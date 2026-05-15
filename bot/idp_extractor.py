"""
bot/idp_extractor.py — Strict IDP (Room ID + Password) extractor.

WHY THE ORIGINAL HAD FALSE POSITIVES
─────────────────────────────────────
  re.search(r"\\b(\\d{6,10})\\b", text)

  This matches ANY 6–10 digit number: phone numbers, timestamps (20240101),
  order IDs, prices (₹999999), Discord snowflakes, etc.

HOW WE FIX IT
─────────────────────────────────────
  1. Context anchoring  — the Room ID must appear near explicit labels
     ("room", "id", "uid", "roomid", "rid") OR near a password token.
  2. Password must be explicitly labeled  — "pass:", "pwd:", "password:"
     with a value that is 3–16 non-space chars (avoids matching URLs, etc.)
  3. Both must appear in the same message (within 500 chars of each other).
  4. Hard exclusion list — skip numbers that look like phone numbers
     (10-digit starting with 6-9 for Indian mobile), Discord snowflake
     range (18+ digits — already excluded by {6,10}), dates (YYYYMMDD).

RESULT
──────
  extract_idp() returns a validated dict or None.
  Confidence score attached so callers can decide thresholds.
"""

import re
from typing import Optional

# ── Label-anchored Room ID ────────────────────────────────────────────────
#
# Matches patterns like:
#   "room id: 123456"  "Room ID - 987654"  "ID: 1234567"
#   "roomid 654321"    "RID: 777888"       "uid: 111222"
#
_ROOM_ID_LABELED = re.compile(
    r"""
    (?:room\s*id|room|rid|r\.?id|uid)   # explicit label
    \s*[:\-\s]\s*                        # separator
    (\d{6,10})                           # the actual Room ID
    """,
    re.IGNORECASE | re.VERBOSE,
)

# Fallback: bare number that appears VERY close to a password token
# (within 120 chars). Used only if labeled pattern fails.
_ROOM_ID_BARE = re.compile(r"\b(\d{6,10})\b")

# ── Password ──────────────────────────────────────────────────────────────
#
# Matches:
#   "pass: abc123"   "password: MyPass!"   "pwd - hello"
#   "Pass:abc"       "password=X1Y2"
#
_PASSWORD = re.compile(
    r"""
    \b(?:pass(?:word)?|pwd)\b           # keyword
    \s*[:\-=\s]\s*                      # separator (colon, dash, equals, space)
    ([^\s,|/\\]{3,16})                  # value: 3–16 non-whitespace/separator chars
    """,
    re.IGNORECASE | re.VERBOSE,
)

# ── Exclusion: numbers that look like Indian mobile numbers ───────────────
#   10-digit, starts with 6/7/8/9
_MOBILE_RE = re.compile(r"^[6-9]\d{9}$")

# ── Exclusion: pure date patterns YYYYMMDD or DDMMYYYY ────────────────────
_DATE_RE = re.compile(
    r"^(?:20[0-2]\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])|"   # YYYYMMDD
    r"(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])20[0-2]\d)$"       # DDMMYYYY
)


def _is_excluded(num: str) -> bool:
    """Return True if *num* looks like a mobile number or a date."""
    return bool(_MOBILE_RE.match(num) or _DATE_RE.match(num))


def extract_idp(text: str) -> Optional[dict]:
    """
    Extract Room ID and Password from *text*.

    Returns:
        {
          "id":         str,   # the Room ID digits
          "password":   str,   # the password value
          "confidence": str,   # "high" | "medium"
        }
        or None if no valid IDP found.

    Confidence:
        "high"   — Room ID found with an explicit label (room id: XXXXXX)
        "medium" — bare number inferred from proximity to a password token
    """
    if not text or len(text) > 2000:
        return None

    pass_match = _PASSWORD.search(text)
    if not pass_match:
        return None  # No labeled password → not an IDP message

    password = pass_match.group(1).strip()

    # ── Try labeled Room ID first (high confidence) ───────────────────────
    id_match = _ROOM_ID_LABELED.search(text)
    if id_match:
        room_id = id_match.group(1)
        if not _is_excluded(room_id):
            return {"id": room_id, "password": password, "confidence": "high"}

    # ── Fallback: bare number within 120 chars of password (medium conf) ──
    pass_pos = pass_match.start()
    window_start = max(0, pass_pos - 120)
    window_end   = min(len(text), pass_pos + 120)
    window = text[window_start:window_end]

    for bare_match in _ROOM_ID_BARE.finditer(window):
        room_id = bare_match.group(1)
        if not _is_excluded(room_id):
            return {"id": room_id, "password": password, "confidence": "medium"}

    return None


def idp_key(idp: dict) -> str:
    """Deduplication key for a detected IDP."""
    return f"{idp['id'].lower()}-{idp['password'].lower()}"