"""
backend/monitor.py
Place this file at: satyamapp/backend/monitor.py

Controls the Discord bot as an asyncio Task — NOT a subprocess.
FastAPI routes call start_monitoring() / stop_monitoring().
"""
import asyncio
from typing import Optional

from state import state
from utils.logger import get_logger
from backend.logger import add_log

log = get_logger("monitor")

_bot_task: Optional[asyncio.Task] = None


async def start_monitoring() -> dict:
    global _bot_task

    if state.running and _bot_task and not _bot_task.done():
        return {"success": False, "message": "Monitoring already running"}

    # Import here to avoid circular imports at module load
    from bot.discord_bot import run_bot

    log.info("Starting Discord monitoring …")
    add_log("Bot Started")
    _bot_task = asyncio.create_task(run_bot(), name="discord_bot")

    # Give the bot a moment to connect before returning
    await asyncio.sleep(1.5)

    return {
        "success": True,
        "message": "Monitoring started",
        "state": state.to_dict(),
    }


async def stop_monitoring() -> dict:
    global _bot_task

    if not state.running and (_bot_task is None or _bot_task.done()):
        return {"success": False, "message": "Monitoring is not running"}

    log.info("Stopping monitoring …")
    add_log("Bot Stopped")

    if _bot_task and not _bot_task.done():
        _bot_task.cancel()
        try:
            await asyncio.wait_for(_bot_task, timeout=5)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass

    _bot_task = None
    state.mark_stopped()
    log.info("Monitoring stopped.")

    return {
        "success": True,
        "message": "Monitoring stopped",
        "state": state.to_dict(),
    }


def get_status() -> dict:
    return state.to_dict()