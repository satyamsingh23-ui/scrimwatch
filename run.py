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

import asyncio
import os
import signal
import sys
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent
os.chdir(PROJECT_ROOT)
load_dotenv(dotenv_path=PROJECT_ROOT / ".env")  # loads .env into os.environ

import uvicorn
import config

# Import the FastAPI app object directly.
# DO NOT pass "api.dashboard:app" as a string to uvicorn — on Windows
# it raises ModuleNotFoundError because uvicorn spawns a new import context.
from api.dashboard import app as dashboard_app

from db.database import db
from bot.discord_bot import run_bot
from utils.logger import get_logger

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
    if config.SETUP_REQUIRED:
        log.warning("Required credentials missing — starting dashboard in setup mode.")

    try:
        # 2. Keep the dashboard available during first-run setup.
        tasks_to_wait = []
        if not config.SETUP_REQUIRED:
            tasks_to_wait.append(asyncio.create_task(run_bot(), name="discord_bot"))
            log.info("Starting Discord bot ...")
        dashboard_task = asyncio.create_task(_run_dashboard(), name="dashboard")
        tasks_to_wait.append(dashboard_task)

        await asyncio.gather(*tasks_to_wait, return_exceptions=True)

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