"""
backend/routes.py
Place this file at: satyamapp/backend/routes.py

IMPORTANT: This file defines a router (not a standalone FastAPI app).
main.py mounts this router — do NOT call app = FastAPI() here.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from backend.monitor import start_monitoring, stop_monitoring, get_status
from services.whatsapp import send_alert
from utils.logger import get_logger

log = get_logger("routes")
router = APIRouter()


# ── Status ────────────────────────────────────────────────────────────────

@router.get("/status")
async def status():
    """Return current monitoring state."""
    return get_status()


# ── Start ─────────────────────────────────────────────────────────────────

@router.post("/start")
async def start():
    """Start Discord monitoring and the bot."""
    result = await start_monitoring()
    if not result["success"]:
        raise HTTPException(status_code=409, detail=result["message"])
    log.info("Monitoring started via API")
    return result


# ── Stop ──────────────────────────────────────────────────────────────────

@router.post("/stop")
async def stop():
    """Stop Discord monitoring and shut down the bot."""
    result = await stop_monitoring()
    if not result["success"]:
        raise HTTPException(status_code=409, detail=result["message"])
    log.info("Monitoring stopped via API")
    return result


# ── Test Alert ────────────────────────────────────────────────────────────

class AlertBody(BaseModel):
    message: Optional[str] = "🔔 Test alert from ScrimWatch!"


@router.post("/test-alert")
async def test_alert(body: AlertBody):
    """Send a test WhatsApp message to all configured recipients."""
    sent = await send_alert(body.message)
    return {
        "sent": sent,
        "message": (
            f"Alert sent to {sent} recipient(s)"
            if sent
            else "No recipients configured or Twilio not set up"
        ),
    }


# ── Logs ──────────────────────────────────────────────────────────────────

@router.get("/logs")
async def get_logs():
    """Return recent in-memory log entries."""
    from backend.logger import get_logs as _get_logs
    return {"logs": _get_logs()}


# ── Keywords ──────────────────────────────────────────────────────────────

@router.get("/keywords")
async def list_keywords():
    """List currently active scrim keywords."""
    import config
    return {"keywords": config.SCRIM_KEYWORDS}