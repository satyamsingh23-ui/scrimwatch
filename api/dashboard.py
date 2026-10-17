"""
api/dashboard.py — FastAPI dashboard.
Existing endpoints UNCHANGED. Stats endpoints added at bottom.
"""

import os
from datetime import datetime
from pathlib import Path
from statistics import mean

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from db.database import db
from bot.guild_state import guild_manager
from services.vision_parser import MODEL_CANDIDATES, MODEL_NAME
from state import state

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


@app.get("/roster")
async def get_roster(guild_id: int):
    profiles = db.get_approved_roster_profiles(guild_id)
    teams: dict[str, list[dict]] = {}
    for profile in profiles:
        team_tag = (profile["team_tag"] or "Unassigned").strip().upper()
        teams.setdefault(team_tag, []).append(
            {
                "ign": profile["ign"],
                "uid": profile["uid"],
                "discord_id": profile["discord_id"],
                "discord_username": profile["discord_username"],
                "discord_name": profile["discord_name"],
                "role": profile["role"],
            }
        )
    return {
        "teams": [
            {"team_tag": team_tag, "players": players}
            for team_tag, players in teams.items()
        ]
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
async def get_leaderboard(
    guild_id: int,
    days: int = 7,
    roster_only: bool = True,
):
    if not 1 <= days <= 30:
        raise HTTPException(400, "days must be 1-30")
    rows = db.get_player_leaderboard(
        guild_id,
        days=days,
        roster_only=roster_only,
    )
    return {"guild_id": guild_id, "days": days, "count": len(rows), "players": rows}


@app.get("/stats/{guild_id}/recent")
async def get_recent_stats(
    guild_id: int,
    limit: int = 20,
    roster_only: bool = True,
):
    if not 1 <= limit <= 100:
        raise HTTPException(400, "limit must be 1-100")
    rows = db.get_recent_stats(
        guild_id,
        limit=limit,
        roster_only=roster_only,
    )
    return {"guild_id": guild_id, "count": len(rows), "records": rows}


@app.get("/stats/{guild_id}/summary")
async def get_stats_summary(guild_id: int, roster_only: bool = True):
    rows_7 = db.get_player_leaderboard(
        guild_id,
        days=7,
        roster_only=roster_only,
    )
    rows_30 = db.get_player_leaderboard(
        guild_id,
        days=30,
        roster_only=roster_only,
    )
    recent = db.get_recent_stats(
        guild_id,
        limit=1,
        roster_only=roster_only,
    )
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


@app.get("/matches/explore")
async def explore_matches(
    guild_id: int,
    days: str = "7",
    limit: int = 10,
    sort_by: str = "placement",
    order: str = "best",
    map_name: str | None = None,
    roster_only: bool = True,
):
    if not 1 <= guild_id <= 9_223_372_036_854_775_807:
        raise HTTPException(400, "guild_id must be a positive 64-bit integer")
    if days.casefold() == "all":
        day_count = None
    else:
        try:
            day_count = int(days)
        except (TypeError, ValueError):
            raise HTTPException(400, "days must be 1-365 or 'all'")
        if not 1 <= day_count <= 365:
            raise HTTPException(400, "days must be 1-365 or 'all'")
    if not 1 <= limit <= 50:
        raise HTTPException(400, "limit must be 1-50")
    sort_by = sort_by.casefold()
    if sort_by not in {"placement", "kills", "damage", "rating", "survival"}:
        raise HTTPException(400, "sort_by must be placement, kills, damage, rating, or survival")
    order = order.casefold()
    if order not in {"best", "worst"}:
        raise HTTPException(400, "order must be 'best' or 'worst'")
    if map_name is not None:
        map_name = map_name.strip()
        if not map_name or len(map_name) > 100:
            raise HTTPException(400, "map_name must contain 1-100 characters")

    rows = db.get_match_explorer_rows(
        guild_id,
        days=day_count,
        map_name=map_name,
        roster_only=roster_only,
    )
    grouped: dict[str, dict] = {}
    for row in rows:
        image_hash = str(row.get("image_hash") or "").strip()
        match_key = image_hash or f"stat:{row['id']}"
        match = grouped.get(match_key)
        if match is None:
            match = {
                "match_id": match_key,
                "map": row.get("map_name") or "Unknown",
                "date": row.get("detected_at"),
                "placement": row.get("placement"),
                "total_teams": row.get("total_teams"),
                "players": [],
                "_seen_players": set(),
                "_ratings": [],
                "_survival": [],
                "_mvp": None,
            }
            grouped[match_key] = match

        player_key = row.get("roster_profile_id") or str(
            row.get("player_name") or "Unknown"
        ).casefold()
        if player_key in match["_seen_players"]:
            if row.get("is_mvp"):
                match["_mvp"] = row.get("player_name") or "Unknown"
            continue
        match["_seen_players"].add(player_key)
        kills = int(row.get("kills") or 0)
        damage = int(row.get("damage") or 0)
        rating = row.get("rating")
        survived = row.get("survived")
        match["players"].append(
            {
                "ign": row.get("player_name") or "Unknown",
                "uid": row.get("roster_uid"),
                "kills": kills,
                "damage": damage,
                "rating": rating,
                "survived": survived,
                "is_mvp": bool(row.get("is_mvp")),
            }
        )
        if rating is not None:
            match["_ratings"].append(float(rating))
        if survived is not None:
            match["_survival"].append(float(survived))
        if row.get("is_mvp"):
            match["_mvp"] = row.get("player_name") or "Unknown"

    matches = list(grouped.values())
    for match in matches:
        match["kills"] = sum(player["kills"] for player in match["players"])
        match["damage"] = sum(player["damage"] for player in match["players"])
        match["avg_rating"] = mean(match["_ratings"]) if match["_ratings"] else None
        match["avg_survival"] = mean(match["_survival"]) if match["_survival"] else None
        match["mvp"] = match.pop("_mvp")
        match.pop("_seen_players")
        match.pop("_ratings")
        match.pop("_survival")

    def metric(match):
        if sort_by == "placement":
            return match.get("placement")
        if sort_by == "kills":
            return match["kills"]
        if sort_by == "damage":
            return match["damage"]
        if sort_by == "rating":
            return match["avg_rating"]
        return match["avg_survival"]

    def match_sort_key(match):
        value = metric(match)
        missing = value is None
        value = float(value or 0)
        if sort_by == "placement":
            primary = value if order == "best" else -value
            kills_tie = -match["kills"] if order == "best" else match["kills"]
            damage_tie = -match["damage"] if order == "best" else match["damage"]
            return (missing, primary, kills_tie, damage_tie)
        primary = -value if order == "best" else value
        return (missing, primary, -match["kills"], -match["damage"])

    matches.sort(key=match_sort_key)
    matches = matches[:limit]
    placements = [
        float(match["placement"])
        for match in matches
        if match.get("placement") is not None
    ]
    return {
        "matches": matches,
        "summary": {
            "count": len(matches),
            "avg_placement": mean(placements) if placements else None,
            "total_kills": sum(match["kills"] for match in matches),
            "chicken_dinners": sum(
                1 for match in matches if match.get("placement") == 1
            ),
        },
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