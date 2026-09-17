"""
config.py — Central configuration loaded from .env

All values are read from environment variables (or .env via dotenv).
No hard-coded secrets. Sensitive keys are validated at startup.
"""

import os
import json
import sys
from pathlib import Path

from dotenv import load_dotenv

# Load .env from project root (one level up from this file if inside a package)
load_dotenv(dotenv_path=Path(__file__).parent / ".env", override=False)

def get_user_config_path() -> Path:
    """Return the writable per-user ScrimWatch configuration path."""
    app_data = os.getenv("APPDATA")
    base = Path(app_data) if app_data else Path.home()
    return base / "ScrimWatch" / "config.json"


def get_runtime_root() -> Path:
    """Return the source root or PyInstaller's extracted bundle root."""
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent


def get_user_data_path(*parts: str) -> Path:
    """Return a writable path for runtime data outside a packaged bundle."""
    return get_user_data_root().joinpath("data", *parts)


def get_user_data_root() -> Path:
    """Return the writable per-user ScrimWatch data root."""
    app_data = os.getenv("APPDATA")
    base = Path(app_data) if app_data else Path.home()
    path = base / "ScrimWatch"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _load_user_config() -> dict:
    path = get_user_config_path()
    if not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Unable to read user config at {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise RuntimeError(f"User config at {path} must contain a JSON object")
    return data


_USER_CONFIG = _load_user_config()


def _secret(name: str) -> str:
    environment_value = os.getenv(name, "").strip()
    if environment_value:
        return environment_value
    user_value = _USER_CONFIG.get(name, "")
    return user_value.strip() if isinstance(user_value, str) else ""


# ── Discord ───────────────────────────────────────────────────────────────
DISCORD_TOKEN: str = _secret("DISCORD_BOT_TOKEN")
GROQ_API_KEY: str = _secret("GROQ_API_KEY")
SETUP_REQUIRED: bool = not (DISCORD_TOKEN and GROQ_API_KEY)

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
TWILIO_ACCOUNT_SID: str   = _secret("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN: str    = _secret("TWILIO_AUTH_TOKEN")
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
DB_PATH: str = os.getenv("DB_PATH", str(get_user_data_path("scrimbot.db")))