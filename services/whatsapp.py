"""
services/whatsapp.py — Async WhatsApp alert queue.

Architecture:
  - Callers push messages onto an asyncio.Queue (non-blocking)
  - A background worker coroutine drains the queue one item at a time
  - Each send is retried up to WA_MAX_RETRIES times with delay
  - A token-bucket rate limiter caps global send rate (WA_RATE_LIMIT_PER_MIN)
  - Twilio calls run in a thread pool (they are blocking HTTP)

Public API:
  await whatsapp.enqueue(message)   — fire-and-forget from any async context
  await whatsapp.start_worker()     — call once at bot startup
  await whatsapp.stop_worker()      — call once at shutdown
"""

import asyncio
import time
from dataclasses import dataclass
from typing import Optional

import config
from state import state
from utils.logger import get_logger

log = get_logger("whatsapp")

# ── Internal queue ────────────────────────────────────────────────────────
_queue: asyncio.Queue[str] = asyncio.Queue(maxsize=500)
_worker_task: Optional[asyncio.Task] = None


# ── Token-bucket rate limiter ─────────────────────────────────────────────

class _RateLimiter:
    """
    Token-bucket: allows burst up to `capacity` then rate-limits
    to `rate` tokens per second.
    """

    def __init__(self, rate_per_minute: int) -> None:
        self._rate    = rate_per_minute / 60.0      # tokens/sec
        self._capacity = max(rate_per_minute, 1)
        self._tokens  = float(self._capacity)
        self._last_ts = time.monotonic()

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self._last_ts
        self._tokens = min(self._capacity, self._tokens + elapsed * self._rate)
        self._last_ts = now

    async def acquire(self) -> None:
        """Block until a token is available."""
        while True:
            self._refill()
            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return
            # Sleep until the next token is ready
            wait = (1.0 - self._tokens) / self._rate
            await asyncio.sleep(wait)


_limiter = _RateLimiter(config.WA_RATE_LIMIT_PER_MIN)


# ── Blocking Twilio send (runs in thread pool) ────────────────────────────

def _send_sync(to: str, body: str) -> bool:
    """
    Send a WhatsApp message via Twilio. Blocking — runs in executor.
    Returns True on success, False on any error.
    """
    try:
        from twilio.rest import Client  # type: ignore

        client = Client(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN)
        msg = client.messages.create(
            body=body,
            from_=config.TWILIO_WHATSAPP_FROM,
            to=to,
        )
        log.info(f"WhatsApp sent → {to} | SID={msg.sid}")
        return True
    except Exception as exc:
        log.error(f"WhatsApp send FAILED → {to} | {exc}")
        return False


async def _send_with_retry(to: str, body: str) -> bool:
    """
    Try sending to one recipient up to WA_MAX_RETRIES times.
    Returns True if any attempt succeeds.
    """
    loop = asyncio.get_event_loop()
    for attempt in range(1, config.WA_MAX_RETRIES + 1):
        success = await loop.run_in_executor(None, _send_sync, to, body)
        if success:
            return True
        if attempt < config.WA_MAX_RETRIES:
            log.warning(
                f"Retry {attempt}/{config.WA_MAX_RETRIES} for {to} "
                f"in {config.WA_RETRY_DELAY}s …"
            )
            await asyncio.sleep(config.WA_RETRY_DELAY)
    return False


# ── Queue worker ──────────────────────────────────────────────────────────

async def _worker() -> None:
    """
    Background coroutine: drain _queue, rate-limit, send with retry.
    Runs until cancelled at shutdown.
    """
    log.info("WhatsApp queue worker started.")
    while True:
        try:
            message = await _queue.get()
            state.wa_queue_depth = _queue.qsize()

            # Honour global rate limit before sending
            await _limiter.acquire()

            if not config.WHATSAPP_ENABLED:
                log.warning("WhatsApp disabled — dropping queued message.")
                _queue.task_done()
                continue

            # Send to all recipients concurrently
            tasks = [
                _send_with_retry(recipient, message)
                for recipient in config.ALERT_WHATSAPP_TO
            ]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            sent  = sum(1 for r in results if r is True)
            failed = len(results) - sent

            if sent:
                state.record_alert_sent()
                log.info(f"Alert dispatched → {sent} recipient(s) OK, {failed} failed.")
            if failed:
                state.record_alert_failed()

            _queue.task_done()

        except asyncio.CancelledError:
            log.info("WhatsApp worker shutting down.")
            break
        except Exception as exc:
            # Never let the worker die silently
            log.exception(f"Unexpected error in WhatsApp worker: {exc}")
            await asyncio.sleep(1)

    state.wa_queue_depth = 0


# ── Public API ────────────────────────────────────────────────────────────

async def enqueue(message: str) -> bool:
    """
    Push *message* onto the send queue.
    Returns False if the queue is full (backpressure protection).
    Non-blocking — safe to call from any async handler.
    """
    try:
        _queue.put_nowait(message)
        state.wa_queue_depth = _queue.qsize()
        log.debug(f"Queued WhatsApp alert (depth={_queue.qsize()})")
        return True
    except asyncio.QueueFull:
        log.error("WhatsApp queue is FULL — alert dropped!")
        return False


async def start_worker() -> None:
    """Start the background queue-drain task. Call once at bot startup."""
    global _worker_task
    if _worker_task and not _worker_task.done():
        return  # Already running
    _worker_task = asyncio.create_task(_worker(), name="wa_queue_worker")
    log.info("WhatsApp queue worker task created.")


async def stop_worker() -> None:
    """Gracefully stop the worker. Waits for queue to drain (up to 10 s)."""
    global _worker_task
    if not _worker_task:
        return
    try:
        await asyncio.wait_for(_queue.join(), timeout=10.0)
    except asyncio.TimeoutError:
        log.warning("Queue did not drain in time — cancelling worker.")
    _worker_task.cancel()
    try:
        await _worker_task
    except asyncio.CancelledError:
        pass
    log.info("WhatsApp worker stopped.")


# ── Message builder ───────────────────────────────────────────────────────

def build_idp_alert(
    *,
    guild_name: str,
    channel_name: str,
    author: str,
    room_id: str,
    password: str,
    message_url: Optional[str] = None,
) -> str:
    """Format a WhatsApp IDP alert message."""
    lines = [
        "🎮 *SCRIM IDP ALERT!*",
        f"📡 Server   : {guild_name}",
        f"💬 Channel  : #{channel_name}",
        f"👤 Author   : {author}",
        f"🆔 Room ID  : {room_id}",
        f"🔑 Password : {password}",
    ]
    if message_url:
        lines.append(f"🔗 Link     : {message_url}")
    return "\n".join(lines)