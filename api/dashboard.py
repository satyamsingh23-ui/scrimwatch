"""
api/dashboard.py — FastAPI dashboard.
Existing endpoints UNCHANGED. Stats endpoints added at bottom.
"""

import os
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from db.database import db
from bot.guild_state import guild_manager
from state import state

app = FastAPI(title="ScrimWatch", version="2.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

LOG_PATH = Path("logs/app.log")
DIST     = Path("frontend/dist")


# ── EXISTING endpoints (UNCHANGED) ────────────────────────────────────

@app.get("/status")
async def get_status():
    return JSONResponse(content=state.to_dict())


@app.get("/slots/{guild_id}")
async def get_slots(guild_id: int):
    gs   = guild_manager.get(guild_id)
    rows = [{"slot": k, "team": v} for k, v in sorted(gs.slots.items())]
    return {"guild_id": guild_id, "slots": rows, "count": len(rows)}


@app.post("/slots/{guild_id}/clear")
async def clear_slots(guild_id: int):
    gs    = guild_manager.get(guild_id)
    count = gs.clear_all_slots()
    return {"cleared": count}


@app.get("/channels/{guild_id}")
async def get_channels(guild_id: int):
    gs = guild_manager.get(guild_id)
    return {
        "guild_id":     guild_id,
        "idp_channels": list(gs.idp_channels),
        "reg_channels": list(gs.reg_channels),
    }


@app.get("/idphistory")
async def get_idp_history(hours: int = 24):
    if not 1 <= hours <= 168:
        raise HTTPException(400, "hours must be 1-168")
    records = db.recent_idp_history(hours=hours)
    return {"window_hours": hours, "count": len(records), "records": records}


@app.get("/logs")
async def get_logs(lines: int = 150):
    if not LOG_PATH.exists():
        return {"logs": []}
    all_lines = LOG_PATH.read_text(encoding="utf-8", errors="replace").splitlines()
    return {"logs": all_lines[-lines:]}


# ── Stats endpoints ────────────────────────────────────────────────────

@app.get("/stats/{guild_id}/leaderboard")
async def get_leaderboard(guild_id: int, days: int = 7):
    if not 1 <= days <= 30:
        raise HTTPException(400, "days must be 1-30")
    rows = db.get_player_leaderboard(guild_id, days=days)
    return {"guild_id": guild_id, "days": days, "count": len(rows), "players": rows}


@app.get("/stats/{guild_id}/recent")
async def get_recent_stats(guild_id: int, limit: int = 20):
    if not 1 <= limit <= 100:
        raise HTTPException(400, "limit must be 1-100")
    rows = db.get_recent_stats(guild_id, limit=limit)
    return {"guild_id": guild_id, "count": len(rows), "records": rows}


@app.get("/stats/{guild_id}/summary")
async def get_stats_summary(guild_id: int):
    rows_7  = db.get_player_leaderboard(guild_id, days=7)
    rows_30 = db.get_player_leaderboard(guild_id, days=30)
    recent  = db.get_recent_stats(guild_id, limit=1)
    return {
        "guild_id":        guild_id,
        "players_tracked": len(rows_30),
        "matches_7d":      sum(r["matches"]      for r in rows_7),
        "total_kills_7d":  sum(r["total_kills"]  for r in rows_7),
        "total_damage_7d": sum(r["total_damage"] or 0 for r in rows_7),
        "top_player":      rows_7[0]["player_name"] if rows_7 else None,
        "top_kills_7d":    rows_7[0]["total_kills"]  if rows_7 else 0,
        "last_match_at":   recent[0]["detected_at"]  if recent else None,
    }


# ── AI scouting endpoint (Gemini) ─────────────────────────────────────

class ScoutRequest(BaseModel):
    prompt: str


@app.post("/ai/scout")
async def ai_scout(body: ScoutRequest):
    # Support multiple common key names from .env
    api_key = (
        os.getenv("GEMINI_API_KEY") or
        os.getenv("GEMENI_API_KEY") or   # common typo
        os.getenv("GOOGLE_API_KEY") or
        ""
    )
    if not api_key:
        raise HTTPException(500, "No Gemini API key found. Set GEMINI_API_KEY in .env")

    # v1beta is correct for gemini-2.0-flash
    url = (
        "https://generativelanguage.googleapis.com/v1beta"
        f"/models/gemini-2.5-flash:generateContent?key={api_key}"
    )

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            res = await client.post(
                url,
                headers={"content-type": "application/json"},
                json={
                    "contents": [{"parts": [{"text": body.prompt}]}],
                    "generationConfig": {"maxOutputTokens": 4096},
                },
            )
    except httpx.TimeoutException:
        raise HTTPException(504, "Gemini request timed out — try again")
    except httpx.RequestError as e:
        raise HTTPException(502, f"Network error reaching Gemini: {e}")

    if res.status_code != 200:
        # Return the actual Gemini error so it's visible in the frontend
        try:
            detail = res.json().get("error", {}).get("message", res.text)
        except Exception:
            detail = res.text
        raise HTTPException(res.status_code, f"Gemini: {detail}")

    data = res.json()
    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        raise HTTPException(502, f"Unexpected Gemini response: {data}")

    return {"report": text}


# ── Serve React (MUST be last) ─────────────────────────────────────────

if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def serve_react(full_path: str):
        return FileResponse(DIST / "index.html")
else:
    @app.get("/")
    async def no_build():
        return {
            "message": "Run: cd frontend && npm install && npm run build",
            "api_status": "ok",
            "bot_running": state.running,
        }