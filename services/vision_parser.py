import asyncio
import base64
import json
import os
import re
import time
import random
import aiohttp
from datetime import datetime
from utils.logger import get_logger
from db.database import db

log = get_logger("vision_parser")

# Groq Configuration
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
MODEL_NAME = "qwen/qwen3.8-27b"
MODEL_CANDIDATES = [
    "qwen/qwen3.8-27b",
    "qwen/qwen3.6-27b",
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "meta-llama/llama-4-maverick-17b-128e-instruct",
]
# Rate Limiter for Groq (More generous than Gemini)
class _RateLimiter:
    def __init__(self, rpm: int = 20):
        self._interval = 60.0 / rpm
        self._last = 0.0

    async def acquire(self):
        now = time.monotonic()
        wait = self._interval - (now - self._last)
        if wait > 0:
            await asyncio.sleep(wait)
        self._last = time.monotonic()

_limiter = _RateLimiter(rpm=25)
_PROMPT = """You are a BGMI Match Stats Extractor.
Analyze the image carefully. BGMI has TWO different post-match stat screen layouts:

LAYOUT A — "detail_stats" table (column order varies):
Columns may appear in ANY order: Player | Rating | Finishes | Assists | Damage | Survived | Health Restored | Rescue | Recalls
The column HEADER TEXT tells you what each column contains — always read the header to identify columns.

LAYOUT B — "squad_result" player cards:
Each player has a card showing their stats.

LAYOUT C — "victory_lobby" screen:
This is the "Winner Winner Chicken Dinner" or placement celebration screen shown right after a match ends, before the detailed stats table appears.
It shows: large placement number (e.g. "#1") and total teams (e.g. "/21") at top-left, a row of player cards each with a slot number, clan tag + IGN, and sometimes an MVP badge — but per-player numeric stats (kills, damage, survived, etc.) are usually partially obscured by gift/thank-you icons and NOT reliably extractable from this screen.
If you detect this layout, set "screen_type" to "victory_lobby", extract placement, total_teams, map_name (if visible), and each player's name and is_mvp status. Set kills, assists, damage, survived, health_restored, rescue, recall, and rating to null for every player rather than guessing partially-obscured numbers.

Extraction Rules:
1. ALWAYS read column headers first to identify which column is which.
2. Map: Look for map name text anywhere on screen (e.g. "Rondo", "Erangel", "Miramar"). If not visible, use "Unknown".
3. Placement: Large '#N' number (e.g. #2). '/22' after it = total_teams. If not visible use 0.
4. Names: Extract the exact full IGN including clan tag (e.g. HLsAAMIITT, ZNxMeLLO).
5. Kills: Column labelled 'Finishes'. Integer value next to the player in that column.
6. Assists: Integer from 'Assists' column.
7. Damage: Integer from 'Damage' column.
8. Survived: Column labelled 'Survived'. Shows time like '18.8m' or '22.3m'. Extract ONLY the float number, strip the 'm' (e.g. 18.8). NEVER return null for this if the column exists.
9. Health Restored: Integer from 'Health Restored' column. Null if column not present.
10. Rescue: Integer from 'Rescue' column. Use 0 if blank, dash, or column absent.
11. Recall/Recalls: Integer from 'Recall' or 'Recalls' column. Use 0 if blank or absent.
12. Rating: Decimal number from 'Rating' column (e.g. 92.9, 68.4, 95.2).
13. MVP: true ONLY if gold 'MVP' badge or text is visible next to the player's rating.

CRITICAL: The 'Survived' column ALWAYS contains a time value like '18.8m'. You MUST extract it. Do not confuse it with other columns.
CRITICAL: Extract ALL players visible. Never skip a row.

Return ONLY valid JSON, no markdown:
{
  "screen_type": "squad_result", "detail_stats", or "victory_lobby",
  "placement": int,
  "total_teams": int,
  "map_name": "Erangel" or "Miramar" or "Sanhok" or "Vikendi" or "Livik" or "Nusa" or "Rondo" or "Unknown",
  "game_mode": "Squad",
  "players": [
    {
      "name": "Full IGN including clan tag",
      "kills": int,
      "assists": int,
      "damage": int or null,
      "survived": float or null,
      "health_restored": int or null,
      "rescue": int or null,
      "recall": int or null,
      "rating": float or null,
      "is_mvp": bool
    }
  ]
}"""
async def parse_screenshot_vision(
    raw_bytes: bytes,
    image_hash: str,
    guild_id: int,
    api_key: str = "",
) -> list[dict]:
    # Use key from argument or environment
    key = api_key or os.environ.get("GROQ_API_KEY", "")
    if not key:
        raise RuntimeError("GROQ_API_KEY not set")

    # Encode image for Groq
    base64_image = base64.b64encode(raw_bytes).decode('utf-8')
    
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json"
    }

    configured_model = db.get_setting("vision_model", default="")
    selected_model = configured_model.strip() if configured_model else MODEL_NAME

    payload = {
        "model": selected_model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": _PROMPT},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{base64_image}"}
                    }
                ]
            }
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.0,
        "reasoning_effort": "none"
    }

    await _limiter.acquire()

    # Retry logic for 503 (Busy) and 429 (Rate Limit)
    max_retries = 3
    for attempt in range(max_retries):
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(GROQ_URL, headers=headers, json=payload, timeout=45) as resp:
                    
                    if resp.status == 503:
                        wait = (2 ** attempt) + random.uniform(0.5, 1.5)
                        log.warning(f"Groq Busy (503). Retrying in {wait:.1f}s...")
                        await asyncio.sleep(wait)
                        continue
                        
                    if resp.status == 429:
                        log.warning("Groq Rate Limit (429). Waiting 10s...")
                        await asyncio.sleep(10)
                        continue

                    if resp.status != 200:
                        err = await resp.text()
                        log.error(f"Groq Error {resp.status}: {err}")
                        return []

                    data = await resp.json()
                    raw_text = data['choices'][0]['message']['content']
                    break
        except Exception as e:
            log.error(f"Groq call attempt {attempt+1} failed: {e}")
            if attempt == max_retries - 1: return []
            await asyncio.sleep(2)
    else:
        return []

    # Parse and build records
    try:
        parsed = json.loads(raw_text)
        return _build_records(parsed, image_hash, guild_id)
    except Exception as e:
        log.error(f"Failed to parse Groq JSON: {e}")
        return []

def _build_records(parsed: dict, image_hash: str, guild_id: int) -> list[dict]:
    now = datetime.utcnow().isoformat()
    # Pull these from the top-level of the parsed JSON
    placement   = parsed.get("placement") or 0
    total       = parsed.get("total_teams") or 0
    map_name    = parsed.get("map_name") or "Unknown"
    mode        = parsed.get("game_mode") or "Squad"
    screen_type = parsed.get("screen_type") or "squad_result"

    records = []
    for idx, p in enumerate(parsed.get("players") or [], start=1):
        name = (p.get("name") or "").strip()
        if not name:
            continue
            
        # survived may come back as "22.3m" string — strip the m
        survived_raw = p.get("survived")
        if isinstance(survived_raw, str):
            survived_raw = survived_raw.replace("m", "").replace("s", "").strip()
            try:
                survived_raw = float(survived_raw)
            except ValueError:
                survived_raw = None

        # rating may come back as string too
        rating_raw = p.get("rating")
        if isinstance(rating_raw, str):
            try:
                rating_raw = float(rating_raw)
            except ValueError:
                rating_raw = None

        records.append({
            "player_name":     name,
            "name":            name,
            "slot":            idx,
            "kills":           None if screen_type == "victory_lobby" else (p.get("kills") or p.get("finishes") or 0),
            "assists":         None if screen_type == "victory_lobby" else (p.get("assists") or 0),
            "is_mvp":          bool(p.get("is_mvp")),
            "placement":       placement,
            "total_teams":     total,
            "map_name":        map_name,
            "game_mode":       mode,
            "damage":          None if screen_type == "victory_lobby" else p.get("damage"),
            "survived":        None if screen_type == "victory_lobby" else survived_raw,
            "health_restored": None if screen_type == "victory_lobby" else p.get("health_restored"),
            "rescue":          None if screen_type == "victory_lobby" else (p.get("rescue") or 0),
            "recall":          None if screen_type == "victory_lobby" else (p.get("recall") or 0),
            "rating":          None if screen_type == "victory_lobby" else rating_raw,
            "confidence":      0.99,
            "screenshot_type": screen_type,
            "image_hash":      image_hash,
            "guild_id":        guild_id,
            "detected_at":     now,
        })
    if not records and screen_type == "victory_lobby":
        return [{
            "screenshot_type": screen_type,
            "placement": placement,
            "total_teams": total,
            "map_name": map_name,
            "game_mode": mode,
            "image_hash": image_hash,
            "guild_id": guild_id,
        }]
    return records