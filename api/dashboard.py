"""
api/dashboard.py — FastAPI dashboard.
Existing endpoints UNCHANGED. Stats endpoints added at bottom.
"""

import os
import json
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from db.database import db
from bot.guild_state import guild_manager
from services.vision_parser import MODEL_CANDIDATES, MODEL_NAME
from state import state
import config

app = FastAPI(title="ScrimWatch", version="2.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5173",
        "https://scrimwatch-eight.vercel.app",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

LOG_PATH = Path("logs/app.log")
PROJECT_ROOT = Path(__file__).resolve().parent.parent
LOG_PATH = PROJECT_ROOT / "logs/app.log"
DIST     = PROJECT_ROOT / "frontend" / "dist"

SETUP_PAGE = """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ScrimWatch Setup</title>
<style>
body{margin:0;background:#07080f;color:#c8cde8;font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}
main{width:min(440px,calc(100% - 40px));background:#111320;border:1px solid #1e2235;border-radius:14px;padding:28px}
h1{font-size:22px;color:#00e5ff;margin:0 0 10px}p{color:#8b91ae;line-height:1.5}
label{display:block;color:#c8cde8;font-size:13px;margin:18px 0 6px}input{box-sizing:border-box;width:100%;padding:11px;border-radius:8px;border:1px solid #1e2235;background:#07080f;color:#fff}
a{color:#00e5ff}button{margin-top:22px;width:100%;padding:11px;border:0;border-radius:8px;background:#00e5ff;color:#07080f;font-weight:700;cursor:pointer}
#message{margin-top:14px;color:#7bed9f}
</style></head>
<body><main>
<h1>Welcome to ScrimWatch</h1>
<p>Enter your bot token and API key to get started.</p>
<p>Get a Discord bot token at <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">discord.com/developers/applications</a>.<br>
Get a free Groq API key at <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">console.groq.com/keys</a>.</p>
<form id="setup"><label for="token">Discord Bot Token</label><input id="token" name="token" type="password" required>
<label for="key">Groq API Key</label><input id="key" name="key" type="password" required><button>Save</button></form>
<div id="message"></div>
<script>document.getElementById('setup').addEventListener('submit',async e=>{e.preventDefault();const m=document.getElementById('message');m.textContent='Saving...';const r=await fetch('/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({discord_bot_token:document.getElementById('token').value,groq_api_key:document.getElementById('key').value})});m.innerHTML=await r.text()})</script>
</main></body></html>"""


# ── EXISTING endpoints (UNCHANGED) ────────────────────────────────────

@app.get("/status")
async def get_status():
    return JSONResponse(content=state.to_dict())


class SetupRequest(BaseModel):
    discord_bot_token: str
    groq_api_key: str


@app.get("/")
async def root():
    if config.SETUP_REQUIRED:
        return HTMLResponse(SETUP_PAGE)
    if DIST.exists():
        return FileResponse(DIST / "index.html")
    return {
        "message": "Run: cd frontend && npm install && npm run build",
        "api_status": "ok",
        "bot_running": state.running,
    }


@app.post("/setup")
async def save_setup(body: SetupRequest):
    token = body.discord_bot_token.strip()
    groq_key = body.groq_api_key.strip()
    if not token or not groq_key:
        raise HTTPException(400, "Both Discord bot token and Groq API key are required")
    path = config.get_user_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {"DISCORD_BOT_TOKEN": token, "GROQ_API_KEY": groq_key},
            indent=2,
        ),
        encoding="utf-8",
    )
    return HTMLResponse("<!doctype html><html><body><h1>Saved!</h1><p>Please restart ScrimWatch to continue</p></body></html>")


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


class VisionModelRequest(BaseModel):
    model: str


@app.get("/settings/vision-model")
async def get_vision_model():
    configured_model = db.get_setting("vision_model", default="")
    return {
        "model": configured_model or MODEL_NAME,
        "candidates": MODEL_CANDIDATES,
    }


@app.post("/settings/vision-model")
async def set_vision_model(body: VisionModelRequest):
    model = body.model.strip()
    if not model:
        raise HTTPException(400, "model must be a non-empty string")
    db.set_setting("vision_model", model)
    return {"model": model}


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
    @app.get("/{full_path:path}")
    async def serve_react(full_path: str):
        requested = (DIST / full_path).resolve()
        if DIST in requested.parents and requested.is_file():
            return FileResponse(requested)
        return FileResponse(DIST / "index.html")

    app.mount("/", StaticFiles(directory=DIST, html=True), name="frontend")
else:
    @app.get("/")
    async def no_build():
        return {
            "message": "Run: cd frontend && npm install && npm run build",
            "api_status": "ok",
            "bot_running": state.running,
        }