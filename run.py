"""
run.py — Single entry point for ScrimWatch.
Starts both the Discord bot and FastAPI dashboard concurrently.
Called by start_app.bat via: python run.py

Fixes vs previous version:
  - Import dashboard app object directly (avoids ModuleNotFoundError from
    uvicorn trying to resolve "api.dashboard:app" as a string import)
  - Bot and dashboard run as independent tasks — a dashboard crash does NOT
    kill the bot or close the database underneath it
"""

from dotenv import load_dotenv
load_dotenv()  # loads .env into os.environ

import asyncio
import signal
import sys

import uvicorn

# Import the FastAPI app object directly.
# DO NOT pass "api.dashboard:app" as a string to uvicorn — on Windows
# it raises ModuleNotFoundError because uvicorn spawns a new import context.
from api.dashboard import app as dashboard_app

from db.database import db
from bot.discord_bot import run_bot
from utils.logger import get_logger
import config

log = get_logger("run")


async def _run_dashboard() -> None:
    """Run the FastAPI dashboard. Errors here do NOT kill the bot."""
    try:
        uv_config = uvicorn.Config(
            app=dashboard_app,      # object, not string
            host=config.API_HOST,
            port=config.API_PORT,
            log_level="warning",
        )
        uv_server = uvicorn.Server(uv_config)
        log.info(f"FastAPI dashboard → http://localhost:{config.API_PORT}")
        await uv_server.serve()
    except Exception as exc:
        log.error(f"Dashboard stopped unexpectedly: {exc}")


async def _main() -> None:
    # 1. Connect database FIRST — both bot and dashboard depend on it
    db.connect()
    log.info("Database connected.")
    log.info("Starting Discord bot ...")

    try:
        # 2. Independent tasks — crash in dashboard does NOT cancel the bot
        bot_task       = asyncio.create_task(run_bot(),        name="discord_bot")
        dashboard_task = asyncio.create_task(_run_dashboard(), name="dashboard")

        await asyncio.gather(bot_task, dashboard_task, return_exceptions=True)

    except asyncio.CancelledError:
        log.info("Shutdown signal received.")
    finally:
        db.close()
        log.info("Shutdown complete.")


def _shutdown(loop: asyncio.AbstractEventLoop) -> None:
    log.info("Stopping all tasks ...")
    for task in asyncio.all_tasks(loop):
        task.cancel()


if __name__ == "__main__":
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _shutdown, loop)
        except NotImplementedError:
            pass  # Windows — handled by KeyboardInterrupt below

    try:
        loop.run_until_complete(_main())
    except KeyboardInterrupt:
        log.info("KeyboardInterrupt — exiting.")
    finally:
        pending = asyncio.all_tasks(loop)
        if pending:
            loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
        loop.close()
        sys.exit(0)