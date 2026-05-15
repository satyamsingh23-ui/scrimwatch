"""
WhatsApp alert service using Twilio.

If Twilio credentials are not configured the service will log a warning
and skip sending — this lets the rest of the system work without Twilio.
"""

import asyncio
from typing import Optional

from config import TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM, ALERT_WHATSAPP_TO, WHATSAPP_ENABLED
from utils.logger import get_logger

log = get_logger("whatsapp")


def _send_sync(to: str, body: str) -> bool:
    """Blocking Twilio send — run inside a thread pool."""
    try:
        from twilio.rest import Client  # type: ignore

        client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
        msg = client.messages.create(
            body=body,
            from_=TWILIO_WHATSAPP_FROM,
            to=to,
        )
        log.info(f"WhatsApp sent → {to} | SID={msg.sid}")
        return True
    except Exception as exc:
        log.error(f"WhatsApp send FAILED → {to} | {exc}")
        return False


async def send_alert(message: str) -> int:
    """
    Send *message* to all configured WhatsApp recipients.

    Returns the number of successful sends.
    """
    if not WHATSAPP_ENABLED:
        log.warning("WhatsApp not configured — skipping alert. Set TWILIO_* env vars.")
        return 0

    loop = asyncio.get_event_loop()
    tasks = [
        loop.run_in_executor(None, _send_sync, recipient, message)
        for recipient in ALERT_WHATSAPP_TO
    ]
    results = await asyncio.gather(*tasks)
    return sum(results)


def build_scrim_alert(
    *,
    guild_name: str,
    channel_name: str,
    author: str,
    keyword: str,
    message_content: str,
    message_url: Optional[str] = None,
) -> str:
    """Format a readable WhatsApp alert message."""
    lines = [
        "🎮 *Scrim Alert Detected!*",
        f"📡 Server   : {guild_name}",
        f"💬 Channel  : #{channel_name}",
        f"👤 Author   : {author}",
        f"🔑 Keyword  : `{keyword}`",
        f"📝 Message  : {message_content[:300]}",
    ]
    if message_url:
        lines.append(f"🔗 Link     : {message_url}")
    return "\n".join(lines)