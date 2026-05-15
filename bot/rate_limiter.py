"""
bot/rate_limiter.py — Per-channel IDP detection rate limiter.

Prevents the same channel from triggering repeated alerts within
IDP_RATE_LIMIT_SECONDS (default: 30 s from config).

Usage:
    limiter = ChannelRateLimiter()
    if limiter.is_allowed(channel_id):
        ... handle IDP ...
"""

import time
from collections import defaultdict

import config
from utils.logger import get_logger

log = get_logger("rate_limiter")


class ChannelRateLimiter:
    """
    Simple timestamp-based rate limiter keyed by (guild_id, channel_id).

    After an IDP is accepted for a channel, further IDPs from the same
    channel are suppressed for IDP_RATE_LIMIT_SECONDS seconds.
    This prevents burst spam from automated/bot messages in the same channel.
    """

    def __init__(self, cooldown_seconds: float | None = None) -> None:
        self._cooldown = cooldown_seconds or config.IDP_RATE_LIMIT_SECONDS
        # (guild_id, channel_id) → last accepted timestamp
        self._last_seen: dict[tuple[int, int], float] = defaultdict(float)

    def is_allowed(self, guild_id: int, channel_id: int) -> bool:
        """
        Return True if an IDP alert is allowed from this channel right now.
        Marks the channel as recently-seen if allowed.
        """
        key = (guild_id, channel_id)
        now = time.monotonic()
        elapsed = now - self._last_seen[key]

        if elapsed >= self._cooldown:
            self._last_seen[key] = now
            return True

        remaining = self._cooldown - elapsed
        log.debug(
            f"Rate-limited guild={guild_id} ch={channel_id} — "
            f"{remaining:.1f}s cooldown remaining."
        )
        return False

    def reset(self, guild_id: int, channel_id: int) -> None:
        """Manually clear the cooldown for a channel (e.g. after !clearslots)."""
        self._last_seen.pop((guild_id, channel_id), None)