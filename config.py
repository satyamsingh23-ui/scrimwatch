"""
config.py — Central configuration loaded from .env

All values are read from environment variables (or .env via dotenv).
No hard-coded secrets. Sensitive keys are validated at startup.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

# Load .env from project root (one level up from this file if inside a package)
load_dotenv(dotenv_path=Path(__file__).parent / ".env", override=False)

# ── Discord ───────────────────────────────────────────────────────────────
DISCORD_TOKEN: str = os.getenv("DISCORD_BOT_TOKEN", "")

# Guild IDs to monitor — empty list means ALL guilds
MONITORED_GUILD_IDS: list[int] = [
    int(gid.strip())
    for gid in os.getenv("MONITORED_GUILD_IDS", "").split(",")
    if gid.strip().isdigit()
]

# Keywords that trigger general scrim detection (lowercased)
SCRIM_KEYWORDS: list[str] = [
    kw.strip().lower()
    for kw in os.getenv(
        "SCRIM_KEYWORDS",
        "scrim,match,lfg,looking for game,vs,challenge,roster",
    ).split(",")
    if kw.strip()
]

# ── WhatsApp / Twilio ─────────────────────────────────────────────────────
TWILIO_ACCOUNT_SID: str   = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN: str    = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_WHATSAPP_FROM: str = os.getenv("TWILIO_WHATSAPP_FROM", "whatsapp:+14155238886")

# Parse recipient numbers — always prefix with "whatsapp:"
ALERT_WHATSAPP_TO: list[str] = []
for _n in os.getenv("ALERT_WHATSAPP_TO", "").split(","):
    _n = _n.strip()
    if _n:
        ALERT_WHATSAPP_TO.append(_n if _n.startswith("whatsapp:") else f"whatsapp:{_n}")

# Is Twilio fully configured?
WHATSAPP_ENABLED: bool = bool(
    TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and ALERT_WHATSAPP_TO
)

# ── WhatsApp Queue / Retry ─────────────────────────────────────────────────
WA_MAX_RETRIES: int        = int(os.getenv("WA_MAX_RETRIES", "3"))
WA_RETRY_DELAY: float      = float(os.getenv("WA_RETRY_DELAY", "5"))
WA_RATE_LIMIT_PER_MIN: int = int(os.getenv("WA_RATE_LIMIT_PER_MIN", "10"))

# ── IDP Detection Tuning ──────────────────────────────────────────────────
IDP_CACHE_SIZE: int            = int(os.getenv("IDP_CACHE_SIZE", "100"))
IDP_RATE_LIMIT_SECONDS: float  = float(os.getenv("IDP_RATE_LIMIT_SECONDS", "30"))

# ── API Server ────────────────────────────────────────────────────────────
API_HOST: str = os.getenv("API_HOST", "0.0.0.0")
API_PORT: int = int(os.getenv("API_PORT", "8000"))

# ── Database ──────────────────────────────────────────────────────────────
DB_PATH: str = os.getenv("DB_PATH", "data/scrimbot.db")