"""
main.py — ScrimBot entry point with FastAPI integration.

Runs both the Discord bot AND the FastAPI web server together.
Railway will start this via the Procfile.
"""

import asyncio
import signal
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from utils.logger import get_logger

log = get_logger("main")

# Import your database if you have one
# from db.database import db

# Global task for the Discord bot
_bot_task = None


async def start_bot_background():
    """Start the Discord bot as a background task."""
    global _bot_task
    from bot.discord_bot import run_bot
    
    log.info("Starting Discord bot in background...")
    _bot_task = asyncio.create_task(run_bot(), name="discord_bot")


async def stop_bot_background():
    """Stop the Discord bot gracefully."""
    global _bot_task
    
    if _bot_task and not _bot_task.done():
        log.info("Stopping Discord bot...")
        _bot_task.cancel()
        try:
            await asyncio.wait_for(_bot_task, timeout=5)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
    
    _bot_task = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI lifespan - startup and shutdown events."""
    # Startup
    log.info("FastAPI starting up...")
    
    # Connect database if you have one
    # db.connect()
    
    # Start Discord bot
    await start_bot_background()
    
    yield
    
    # Shutdown
    log.info("FastAPI shutting down...")
    await stop_bot_background()
    
    # Close database
    # db.close()


# Create FastAPI app
app = FastAPI(
    title="ScrimWatch API",
    description="Discord bot monitoring dashboard API",
    version="2.0.0",
    lifespan=lifespan
)

# CORS - Allow your frontend to access the API
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5173",
        # Add your Vercel domain here after deployment:
        # "https://your-app.vercel.app",
        "*"  # Remove this in production and specify exact domains
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include your API routes
from backend.routes import router
app.include_router(router)


@app.get("/")
async def root():
    """Health check endpoint."""
    return {
        "status": "online",
        "message": "ScrimWatch API is running",
        "bot_running": _bot_task is not None and not _bot_task.done()
    }


@app.get("/health")
async def health():
    """Detailed health check."""
    return {
        "api": "healthy",
        "bot": "running" if (_bot_task and not _bot_task.done()) else "stopped"
    }


# Only used when running directly (not via Railway's Procfile)
if __name__ == "__main__":
    import os
    port = int(os.getenv("PORT", 8000))
    
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=port,
        log_level="info"
    )