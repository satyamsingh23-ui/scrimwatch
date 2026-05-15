"""
bot/guild_state.py — Per-guild in-memory state, backed by SQLite.

WHY THIS EXISTS
───────────────
The original bot used global dicts (slots, ID_CHANNELS, etc.) shared
across ALL guilds. This causes:
  - Data collision: Team "Alpha" from Guild A overwrites Guild B's "Alpha"
  - No isolation: !clearslots on one server clears everyone's slots
  - No persistence: everything resets on restart

HOW THIS FIXES IT
──────────────────
  GuildState holds per-guild data.
  GuildStateManager is a registry: guild_id → GuildState.
  On startup, all data is loaded from SQLite.
  Every mutation writes through to SQLite immediately.
"""

from __future__ import annotations

import re
from collections import deque
from typing import Optional

import config
from db.database import db
from utils.logger import get_logger

log = get_logger("guild_state")


class GuildState:
    """
    All mutable state for a single Discord guild.

    Attributes:
        slots       — {slot_num: display_team_name}
        team_index  — {normalized_team_name: slot_num}
        idp_channels  — set of channel IDs designated for IDP detection
        reg_channels  — set of channel IDs for slot registration
        seen_idps   — deque of recent IDP keys for deduplication
    """

    def __init__(self, guild_id: int) -> None:
        self.guild_id = guild_id
        self.slots: dict[str, str] = {}
        self.team_index: dict[str, str] = {}
        self.idp_channels:   set[int] = set()
        self.reg_channels:   set[int] = set()
        self.stats_channels: set[int] = set()
        self.seen_idps: deque[str] = deque(maxlen=config.IDP_CACHE_SIZE)

    def load_from_db(self) -> None:
        """Hydrate this GuildState from the database."""
        self.slots         = db.load_slots(self.guild_id)
        self.team_index    = db.load_team_index(self.guild_id)
        self.idp_channels  = db.load_channels(self.guild_id, "idp")
        self.reg_channels  = db.load_channels(self.guild_id, "registration")
        self.stats_channels = db.load_stats_channels(self.guild_id)
        log.debug(
            f"Guild {self.guild_id} loaded: "
            f"{len(self.slots)} slots, "
            f"{len(self.idp_channels)} IDP ch, "
            f"{len(self.reg_channels)} reg ch, "
            f"{len(self.stats_channels)} stats ch"
        )

    # ── Slot helpers ──────────────────────────────────────────────────────

    def register_slot(self, slot_num: str, team_norm: str, team_display: str) -> None:
        """Add or update a slot, removing any previous slot this team held."""
        # If team was already in a different slot, remove it
        old_slot = db.delete_slot_by_team(self.guild_id, team_norm)
        if old_slot:
            self.slots.pop(old_slot, None)

        # Remove whoever was previously in this slot number
        if slot_num in self.slots:
            old_norm = _normalize(self.slots[slot_num])[0]
            self.team_index.pop(old_norm, None)

        # Write new slot
        db.save_slot(self.guild_id, slot_num, team_display, team_norm)
        self.slots[slot_num] = team_display
        self.team_index[team_norm] = slot_num

    def clear_all_slots(self) -> int:
        """Clear all slots. Returns count deleted."""
        count = db.clear_slots(self.guild_id)
        self.slots.clear()
        self.team_index.clear()
        return count

    def format_slots(self) -> str:
        if not self.slots:
            return "No slots registered."
        return "\n".join(f"**{s}** → {self.slots[s]}" for s in sorted(self.slots))

    # ── Channel helpers ───────────────────────────────────────────────────

    def add_idp_channel(self, channel_id: int) -> None:
        db.save_channel(self.guild_id, channel_id, "idp")
        self.idp_channels.add(channel_id)

    def add_reg_channel(self, channel_id: int) -> None:
        db.save_channel(self.guild_id, channel_id, "registration")
        self.reg_channels.add(channel_id)

    def remove_idp_channel(self, channel_id: int) -> None:
        db.remove_channel(self.guild_id, channel_id, "idp")
        self.idp_channels.discard(channel_id)

    def remove_reg_channel(self, channel_id: int) -> None:
        db.remove_channel(self.guild_id, channel_id, "registration")
        self.reg_channels.discard(channel_id)

    # ── IDP dedup ─────────────────────────────────────────────────────────

    def has_seen_idp(self, key: str) -> bool:
        return key in self.seen_idps

    def mark_idp_seen(self, key: str) -> None:
        self.seen_idps.append(key)

    # ── Channel filter logic ──────────────────────────────────────────────

    def should_scan_for_idp(self, channel_id: int) -> bool:
        """Scan all channels if no IDP channels configured, else only designated."""
        return not self.idp_channels or channel_id in self.idp_channels

    def is_reg_channel(self, channel_id: int) -> bool:
        return channel_id in self.reg_channels

    # ── Stats channel helpers ─────────────────────────────────────────────

    def add_stats_channel(self, channel_id: int) -> None:
        db.save_stats_channel(self.guild_id, channel_id)
        self.stats_channels.add(channel_id)

    def remove_stats_channel(self, channel_id: int) -> None:
        db.remove_stats_channel(self.guild_id, channel_id)
        self.stats_channels.discard(channel_id)

    def is_stats_channel(self, channel_id: int) -> bool:
        return channel_id in self.stats_channels


# ── Utility ───────────────────────────────────────────────────────────────

_PUNCTUATION_RE = re.compile(r"[^\w\s]")
_WHITESPACE_RE  = re.compile(r"\s+")


def _normalize(name: str) -> tuple[str, str]:
    """Return (normalized_lower, display_clean) for a team name."""
    clean = _PUNCTUATION_RE.sub("", name)
    clean = _WHITESPACE_RE.sub(" ", clean).strip()
    return clean.lower(), clean


# ── Registry ──────────────────────────────────────────────────────────────

class GuildStateManager:
    """
    Lazy registry: creates and caches GuildState per guild_id.
    Guild state is loaded from DB on first access.
    """

    def __init__(self) -> None:
        self._cache: dict[int, GuildState] = {}

    def get(self, guild_id: int) -> GuildState:
        """Return (possibly cached) GuildState for *guild_id*."""
        if guild_id not in self._cache:
            gs = GuildState(guild_id)
            gs.load_from_db()
            self._cache[guild_id] = gs
        return self._cache[guild_id]

    def preload(self, guild_ids: list[int]) -> None:
        """Eagerly load state for all known guilds on startup."""
        for gid in guild_ids:
            self.get(gid)
        log.info(f"Preloaded state for {len(guild_ids)} guild(s).")

    def evict(self, guild_id: int) -> None:
        """Remove a guild's cached state (e.g. after leaving the guild)."""
        self._cache.pop(guild_id, None)


# ── Module-level singleton ─────────────────────────────────────────────────
guild_manager = GuildStateManager()
normalize = _normalize   # re-export for use in discord_bot.py