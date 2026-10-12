"""
db/database.py — SQLite persistence layer.

Stores:
  - slots          : per-guild slot → team mappings
  - channel_config : per-guild ID/registration channel sets
  - idp_history    : detected IDP log (last 7 days)

Uses aiosqlite for fully async, non-blocking DB access.
All public functions are coroutines safe to call from the event loop.
"""

import sqlite3
import unicodedata
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from utils.logger import get_logger
from utils.roster import extract_team_tag

log = get_logger("database")


def _normalize_ign(value: str | None) -> str:
    normalized = unicodedata.normalize("NFKD", str(value or "")).casefold()
    return "".join(char for char in normalized if char.isascii() and char.isalnum())


# ── Schema ────────────────────────────────────────────────────────────────
_SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS slots (
    guild_id    INTEGER NOT NULL,
    slot_num    TEXT    NOT NULL,
    team_name   TEXT    NOT NULL,
    team_norm   TEXT    NOT NULL,           -- normalized lowercase key
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (guild_id, slot_num)
);

CREATE TABLE IF NOT EXISTS channel_config (
    guild_id     INTEGER NOT NULL,
    channel_id   INTEGER NOT NULL,
    channel_type TEXT    NOT NULL CHECK(channel_type IN ('idp', 'registration')),
    PRIMARY KEY (guild_id, channel_id, channel_type)
);

CREATE TABLE IF NOT EXISTS idp_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    INTEGER NOT NULL,
    channel_id  INTEGER NOT NULL,
    guild_name  TEXT,
    channel_name TEXT,
    author      TEXT,
    room_id     TEXT    NOT NULL,
    password    TEXT    NOT NULL,
    message_url TEXT,
    detected_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_idp_history_detected
    ON idp_history(detected_at);

-- ── Player stats (screenshot OCR) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS player_stats (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id         INTEGER NOT NULL,
    player_name      TEXT    NOT NULL,
    kills            INTEGER DEFAULT 0,
    assists          INTEGER DEFAULT 0,
    damage           INTEGER DEFAULT 0,
    survived         REAL    DEFAULT NULL,
    health_restored  INTEGER DEFAULT NULL,
    rescue           INTEGER DEFAULT NULL,
    recall           INTEGER DEFAULT NULL,
    placement        INTEGER DEFAULT 0,
    total_teams      INTEGER DEFAULT 0,
    map_name         TEXT    DEFAULT '',
    game_mode        TEXT    DEFAULT '',
    is_mvp           INTEGER DEFAULT 0,
    rating           REAL    DEFAULT NULL,
    roster_profile_id INTEGER DEFAULT NULL,
    confidence       REAL    DEFAULT 0.0,
    screenshot_type  TEXT    DEFAULT '',
    image_hash       TEXT    DEFAULT '',
    detected_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stats_guild   ON player_stats(guild_id);
CREATE INDEX IF NOT EXISTS idx_stats_player  ON player_stats(guild_id, player_name);
CREATE INDEX IF NOT EXISTS idx_stats_date    ON player_stats(detected_at);
CREATE INDEX IF NOT EXISTS idx_stats_hash    ON player_stats(image_hash);

-- Dedup table for screenshot hashes
CREATE TABLE IF NOT EXISTS stats_image_hashes (
    hash         TEXT PRIMARY KEY,
    guild_id     INTEGER DEFAULT 0,
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Stats channels (separate from channel_config to avoid CHECK constraint conflict)
CREATE TABLE IF NOT EXISTS stats_channels (
    guild_id    INTEGER NOT NULL,
    channel_id  INTEGER NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS roster_channels (
    guild_id    INTEGER NOT NULL,
    channel_id  INTEGER NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS roster_profiles (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id              INTEGER NOT NULL,
    discord_user_id       INTEGER NOT NULL,
    discord_username      TEXT,
    discord_display_name  TEXT NOT NULL,
    uid                   TEXT NOT NULL,
    ign                   TEXT NOT NULL,
    team_tag              TEXT,
    role                  TEXT NOT NULL DEFAULT 'starter'
                              CHECK(role IN ('starter', 'substitute')),
    manually_edited       INTEGER NOT NULL DEFAULT 0,
    status                TEXT NOT NULL DEFAULT 'pending'
                              CHECK(status IN ('pending', 'approved', 'rejected')),
    approved_uid          TEXT,
    approved_ign          TEXT,
    approved_team_tag     TEXT,
    approved_role         TEXT
                              CHECK(approved_role IN ('starter', 'substitute')
                                    OR approved_role IS NULL),
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at           TEXT,
    UNIQUE (guild_id, discord_user_id)
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class Database:
    """
    Synchronous SQLite wrapper.

    Uses sqlite3 with check_same_thread=False + WAL mode.
    All methods are regular (sync) because discord.py runs in a single
    event-loop thread — we call these from async handlers directly.
    If you later switch to aiosqlite, the interface stays identical.
    """

    def __init__(self, db_path: str = "data/scrimbot.db") -> None:
        path = Path(db_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self._path = str(path)
        self._conn: Optional[sqlite3.Connection] = None

    # ── Lifecycle ─────────────────────────────────────────────────────────

    def connect(self) -> None:
        """Open DB connection and create tables if needed."""
        self._conn = sqlite3.connect(
            self._path,
            check_same_thread=False,
            detect_types=sqlite3.PARSE_DECLTYPES,
        )
        self._conn.create_function("normalize_ign", 1, _normalize_ign, deterministic=True)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(_SCHEMA)
        self._conn.commit()
        # Migrate existing DBs — add columns silently if missing
        for col, defn in [
            ("survived",        "REAL    DEFAULT NULL"),
            ("health_restored", "INTEGER DEFAULT NULL"),
            ("rescue",          "INTEGER DEFAULT NULL"),
            ("recall",          "INTEGER DEFAULT NULL"),
        ]:
            try:
                self._conn.execute(f"ALTER TABLE player_stats ADD COLUMN {col} {defn}")
                self._conn.commit()
                log.info(f"DB migrated: added column player_stats.{col}")
            except Exception:
                pass  # column already exists
        roster_columns = {
            row["name"]
            for row in self._conn.execute("PRAGMA table_info(roster_profiles)")
        }
        if "manually_edited" not in roster_columns:
            self._conn.execute(
                "ALTER TABLE roster_profiles "
                "ADD COLUMN manually_edited INTEGER NOT NULL DEFAULT 0"
            )
            self._conn.commit()
            log.info("DB migrated: added column roster_profiles.manually_edited")
        if "discord_username" not in roster_columns:
            self._conn.execute(
                "ALTER TABLE roster_profiles ADD COLUMN discord_username TEXT"
            )
            self._conn.commit()
            log.info("DB migrated: added column roster_profiles.discord_username")
        stats_columns = {
            row["name"]
            for row in self._conn.execute("PRAGMA table_info(player_stats)")
        }
        if "roster_profile_id" not in stats_columns:
            self._conn.execute(
                "ALTER TABLE player_stats ADD COLUMN roster_profile_id INTEGER DEFAULT NULL"
            )
            self._conn.commit()
            log.info("DB migrated: added column player_stats.roster_profile_id")
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_stats_roster_profile "
            "ON player_stats(roster_profile_id)"
        )
        self._conn.commit()
        log.info(f"Database connected: {self._path}")

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None
            log.info("Database closed.")

    @property
    def _db(self) -> sqlite3.Connection:
        if not self._conn:
            raise RuntimeError("Database not connected — call connect() first.")
        return self._conn

    # ── Global settings ──────────────────────────────────────────────────

    def get_setting(self, key: str, default=None) -> str:
        """Return a global setting value, or default when it is not stored."""
        row = self._db.execute(
            "SELECT value FROM settings WHERE key=?",
            (key,),
        ).fetchone()
        return row["value"] if row else default

    def set_setting(self, key: str, value: str) -> None:
        """Insert or replace a global setting value."""
        self._db.execute(
            """
            INSERT INTO settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value
            """,
            (key, value),
        )
        self._db.commit()

    # ── Slots ─────────────────────────────────────────────────────────────

    def save_slot(
        self,
        guild_id: int,
        slot_num: str,
        team_name: str,
        team_norm: str,
    ) -> None:
        """Insert or replace a slot entry."""
        self._db.execute(
            """
            INSERT INTO slots (guild_id, slot_num, team_name, team_norm, updated_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(guild_id, slot_num) DO UPDATE SET
                team_name  = excluded.team_name,
                team_norm  = excluded.team_norm,
                updated_at = excluded.updated_at
            """,
            (guild_id, slot_num, team_name, team_norm),
        )
        self._db.commit()

    def delete_slot_by_team(self, guild_id: int, team_norm: str) -> Optional[str]:
        """
        Remove old slot for a team that's re-registering.
        Returns the old slot_num if found, else None.
        """
        row = self._db.execute(
            "SELECT slot_num FROM slots WHERE guild_id=? AND team_norm=?",
            (guild_id, team_norm),
        ).fetchone()
        if row:
            self._db.execute(
                "DELETE FROM slots WHERE guild_id=? AND slot_num=?",
                (guild_id, row["slot_num"]),
            )
            self._db.commit()
            return row["slot_num"]
        return None

    def load_slots(self, guild_id: int) -> dict[str, str]:
        """Return {slot_num: team_name} for a guild."""
        rows = self._db.execute(
            "SELECT slot_num, team_name FROM slots WHERE guild_id=? ORDER BY slot_num",
            (guild_id,),
        ).fetchall()
        return {r["slot_num"]: r["team_name"] for r in rows}

    def load_team_index(self, guild_id: int) -> dict[str, str]:
        """Return {team_norm: slot_num} for a guild."""
        rows = self._db.execute(
            "SELECT team_norm, slot_num FROM slots WHERE guild_id=?",
            (guild_id,),
        ).fetchall()
        return {r["team_norm"]: r["slot_num"] for r in rows}

    def clear_slots(self, guild_id: int) -> int:
        """Delete all slots for a guild. Returns count deleted."""
        cur = self._db.execute(
            "DELETE FROM slots WHERE guild_id=?", (guild_id,)
        )
        self._db.commit()
        return cur.rowcount

    # ── Channel config ────────────────────────────────────────────────────

    def save_channel(
        self,
        guild_id: int,
        channel_id: int,
        channel_type: str,  # 'idp' or 'registration'
    ) -> None:
        self._db.execute(
            """
            INSERT OR IGNORE INTO channel_config (guild_id, channel_id, channel_type)
            VALUES (?, ?, ?)
            """,
            (guild_id, channel_id, channel_type),
        )
        self._db.commit()

    def remove_channel(
        self,
        guild_id: int,
        channel_id: int,
        channel_type: str,
    ) -> None:
        self._db.execute(
            "DELETE FROM channel_config WHERE guild_id=? AND channel_id=? AND channel_type=?",
            (guild_id, channel_id, channel_type),
        )
        self._db.commit()

    def load_channels(
        self, guild_id: int, channel_type: str
    ) -> set[int]:
        """Return set of channel_ids for a guild + type."""
        rows = self._db.execute(
            "SELECT channel_id FROM channel_config WHERE guild_id=? AND channel_type=?",
            (guild_id, channel_type),
        ).fetchall()
        return {r["channel_id"] for r in rows}

    def save_roster_channel(self, guild_id: int, channel_id: int) -> None:
        self._db.execute(
            "INSERT OR IGNORE INTO roster_channels (guild_id, channel_id) VALUES (?, ?)",
            (guild_id, channel_id),
        )
        self._db.commit()

    def remove_roster_channel(self, guild_id: int, channel_id: int) -> None:
        self._db.execute(
            "DELETE FROM roster_channels WHERE guild_id=? AND channel_id=?",
            (guild_id, channel_id),
        )
        self._db.commit()

    def load_roster_channels(self, guild_id: int) -> set[int]:
        rows = self._db.execute(
            "SELECT channel_id FROM roster_channels WHERE guild_id=?",
            (guild_id,),
        ).fetchall()
        return {row["channel_id"] for row in rows}

    def submit_roster_profile(
        self,
        *,
        guild_id: int,
        discord_user_id: int,
        discord_display_name: str,
        uid: str,
        ign: str,
        team_tag: str | None = None,
        role: str = "starter",
        discord_username: str | None = None,
    ) -> dict:
        """Create or replace a pending submission without changing approved data."""
        if role not in {"starter", "substitute"}:
            raise ValueError(f"Unsupported roster role: {role}")
        if team_tag is None:
            team_tag = extract_team_tag(ign)
        else:
            team_tag = team_tag.strip().upper() or None
        self._db.execute(
            """
            INSERT INTO roster_profiles (
                guild_id, discord_user_id, discord_username, discord_display_name,
                uid, ign, team_tag, role, status, created_at, updated_at,
                manually_edited, reviewed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'),
                      datetime('now'), 0, NULL)
            ON CONFLICT(guild_id, discord_user_id) DO UPDATE SET
                discord_username=COALESCE(
                    NULLIF(excluded.discord_username, ''),
                    roster_profiles.discord_username
                ),
                discord_display_name=excluded.discord_display_name,
                uid=excluded.uid,
                ign=excluded.ign,
                team_tag=excluded.team_tag,
                role=excluded.role,
                status='pending',
                manually_edited=0,
                updated_at=datetime('now'),
                reviewed_at=NULL
            """,
            (
                guild_id,
                discord_user_id,
                discord_username,
                discord_display_name,
                uid,
                ign,
                team_tag,
                role,
            ),
        )
        self._db.commit()
        return self.get_roster_profile(guild_id, discord_user_id)

    def get_roster_profile(self, guild_id: int, discord_user_id: int) -> dict | None:
        row = self._db.execute(
            """
            SELECT * FROM roster_profiles
            WHERE guild_id=? AND discord_user_id=?
            """,
            (guild_id, discord_user_id),
        ).fetchone()
        return dict(row) if row else None

    def get_roster_profiles(self, guild_id: int) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT *
            FROM roster_profiles
            WHERE guild_id=?
            ORDER BY upper(coalesce(approved_team_tag, team_tag, '')),
                     upper(coalesce(approved_ign, ign))
            """,
            (guild_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    def remove_roster_profile(self, guild_id: int, discord_user_id: int) -> bool:
        cursor = self._db.execute(
            "DELETE FROM roster_profiles WHERE guild_id=? AND discord_user_id=?",
            (guild_id, discord_user_id),
        )
        self._db.commit()
        return cursor.rowcount > 0

    def get_approved_roster_profile(
        self,
        guild_id: int,
        discord_user_id: int,
    ) -> dict | None:
        """Return the currently live approved values, even during re-review."""
        row = self._db.execute(
            """
            SELECT guild_id, discord_user_id, discord_display_name,
                   approved_uid AS uid, approved_ign AS ign,
                   approved_team_tag AS team_tag, approved_role AS role
            FROM roster_profiles
            WHERE guild_id=? AND discord_user_id=? AND approved_uid IS NOT NULL
            """,
            (guild_id, discord_user_id),
        ).fetchone()
        return dict(row) if row else None

    def edit_pending_roster_profile(
        self,
        guild_id: int,
        discord_user_id: int,
        uid: str,
        ign: str,
        team_tag: str | None = None,
    ) -> dict | None:
        """Update only the pending submission; approved values remain untouched."""
        if team_tag is None:
            team_tag = extract_team_tag(ign)
        else:
            team_tag = team_tag.strip().upper() or None
        cursor = self._db.execute(
            """
            UPDATE roster_profiles
            SET uid=?, ign=?, team_tag=?, manually_edited=1,
                updated_at=datetime('now')
            WHERE guild_id=? AND discord_user_id=? AND status='pending'
            """,
            (uid, ign, team_tag, guild_id, discord_user_id),
        )
        self._db.commit()
        if not cursor.rowcount:
            return None
        return self.get_roster_profile(guild_id, discord_user_id)

    def update_pending_roster_team_tag(
        self,
        guild_id: int,
        discord_user_id: int,
        team_tag: str,
    ) -> dict | None:
        team_tag = team_tag.strip().upper()
        if not team_tag:
            raise ValueError("Team tag cannot be empty")
        cursor = self._db.execute(
            """
            UPDATE roster_profiles
            SET team_tag=?, manually_edited=1, updated_at=datetime('now')
            WHERE guild_id=? AND discord_user_id=? AND status='pending'
            """,
            (team_tag, guild_id, discord_user_id),
        )
        self._db.commit()
        if not cursor.rowcount:
            return None
        return self.get_roster_profile(guild_id, discord_user_id)

    def update_pending_roster_role(
        self,
        guild_id: int,
        discord_user_id: int,
        role: str,
    ) -> dict | None:
        if role not in {"starter", "substitute"}:
            raise ValueError(f"Unsupported roster role: {role}")
        cursor = self._db.execute(
            """
            UPDATE roster_profiles
            SET role=?, manually_edited=1, updated_at=datetime('now')
            WHERE guild_id=? AND discord_user_id=? AND status='pending'
            """,
            (role, guild_id, discord_user_id),
        )
        self._db.commit()
        if not cursor.rowcount:
            return None
        return self.get_roster_profile(guild_id, discord_user_id)

    def get_approved_roster_profiles(self, guild_id: int) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT id, CAST(discord_user_id AS TEXT) AS discord_id,
                   discord_username,
                   discord_display_name AS discord_name,
                   approved_uid AS uid,
                   approved_ign AS ign,
                   approved_team_tag AS team_tag,
                   approved_role AS role
            FROM roster_profiles
            WHERE guild_id=? AND approved_uid IS NOT NULL
            ORDER BY upper(coalesce(approved_team_tag, '')),
                     CASE approved_role WHEN 'starter' THEN 0 ELSE 1 END,
                     upper(approved_ign)
            """,
            (guild_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    def get_approved_roster_users_missing_username(self) -> list[int]:
        rows = self._db.execute(
            """
            SELECT DISTINCT discord_user_id
            FROM roster_profiles
            WHERE approved_uid IS NOT NULL
              AND (discord_username IS NULL OR discord_username='')
            """
        ).fetchall()
        return [row["discord_user_id"] for row in rows]

    def backfill_approved_roster_username(
        self,
        discord_user_id: int,
        discord_username: str,
    ) -> int:
        cursor = self._db.execute(
            """
            UPDATE roster_profiles
            SET discord_username=?, updated_at=datetime('now')
            WHERE discord_user_id=?
              AND approved_uid IS NOT NULL
              AND (discord_username IS NULL OR discord_username='')
            """,
            (discord_username, discord_user_id),
        )
        self._db.commit()
        return cursor.rowcount

    def review_roster_profile(
        self,
        guild_id: int,
        discord_user_id: int,
        status: str,
    ) -> dict | None:
        """Approve the pending submission or reject it, preserving the live profile."""
        if status not in {"approved", "rejected"}:
            raise ValueError(f"Unsupported roster review status: {status}")

        if status == "approved":
            self._db.execute(
                """
                UPDATE roster_profiles
                SET status='approved',
                    approved_uid=uid,
                    approved_ign=ign,
                    approved_team_tag=team_tag,
                    approved_role=role,
                    updated_at=datetime('now'),
                    reviewed_at=datetime('now')
                WHERE guild_id=? AND discord_user_id=?
                """,
                (guild_id, discord_user_id),
            )
        else:
            self._db.execute(
                """
                UPDATE roster_profiles
                SET status='rejected',
                    updated_at=datetime('now'),
                    reviewed_at=datetime('now')
                WHERE guild_id=? AND discord_user_id=?
                """,
                (guild_id, discord_user_id),
            )
        self._db.commit()
        return self.get_roster_profile(guild_id, discord_user_id)

    # ── IDP History ───────────────────────────────────────────────────────

    def log_idp(
        self,
        *,
        guild_id: int,
        channel_id: int,
        guild_name: str,
        channel_name: str,
        author: str,
        room_id: str,
        password: str,
        message_url: Optional[str],
    ) -> None:
        """Persist a detected IDP to history."""
        self._db.execute(
            """
            INSERT INTO idp_history
                (guild_id, channel_id, guild_name, channel_name, author,
                 room_id, password, message_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                guild_id, channel_id, guild_name, channel_name, author,
                room_id, password, message_url,
            ),
        )
        self._db.commit()

    def recent_idp_history(self, hours: int = 24) -> list[dict]:
        """Return IDP detections from the last N hours."""
        since = (datetime.utcnow() - timedelta(hours=hours)).isoformat()
        rows = self._db.execute(
            """
            SELECT * FROM idp_history
            WHERE detected_at >= ?
            ORDER BY detected_at DESC
            LIMIT 200
            """,
            (since,),
        ).fetchall()
        return [dict(r) for r in rows]

    def prune_old_history(self, days: int = 7) -> int:
        """Delete IDP history older than N days. Call from a daily task."""
        cutoff = (datetime.utcnow() - timedelta(days=days)).isoformat()
        cur = self._db.execute(
            "DELETE FROM idp_history WHERE detected_at < ?", (cutoff,)
        )
        self._db.commit()
        return cur.rowcount

    # ── Stats Channels ────────────────────────────────────────────────────
    # Stored in separate table to avoid CHECK constraint on channel_config

    def save_stats_channel(self, guild_id: int, channel_id: int) -> None:
        self._db.execute(
            "INSERT OR IGNORE INTO stats_channels (guild_id, channel_id) VALUES (?, ?)",
            (guild_id, channel_id),
        )
        self._db.commit()

    def remove_stats_channel(self, guild_id: int, channel_id: int) -> None:
        self._db.execute(
            "DELETE FROM stats_channels WHERE guild_id=? AND channel_id=?",
            (guild_id, channel_id),
        )
        self._db.commit()

    def load_stats_channels(self, guild_id: int) -> set[int]:
        rows = self._db.execute(
            "SELECT channel_id FROM stats_channels WHERE guild_id=?",
            (guild_id,),
        ).fetchall()
        return {r["channel_id"] for r in rows}

    # ── Player Stats ──────────────────────────────────────────────────────

    def is_stats_duplicate(self, image_hash: str, guild_id: int | None = None) -> bool:
        """Return True if this screenshot was already processed."""
        if guild_id is None:
            row = self._db.execute(
                "SELECT 1 FROM stats_image_hashes WHERE hash=?",
                (image_hash,),
            ).fetchone()
        else:
            row = self._db.execute(
                "SELECT 1 FROM stats_image_hashes WHERE hash=? AND guild_id=?",
                (image_hash, guild_id),
            ).fetchone()
        return row is not None

    def mark_stats_processed(self, image_hash: str, guild_id: int = 0) -> None:
        self._db.execute(
            "INSERT OR IGNORE INTO stats_image_hashes (hash, guild_id) VALUES (?, ?)",
            (image_hash, guild_id),
        )
        self._db.commit()




    def save_player_stat(self, record: dict) -> int:
        """Insert one player stats record. Returns new row id."""
        cur = self._db.execute(
            """
            INSERT INTO player_stats (
                guild_id, player_name, kills, assists, damage,
                survived, health_restored, rescue, recall,
                placement, total_teams, map_name, game_mode, is_mvp,
                rating, roster_profile_id, confidence, screenshot_type,
                image_hash, detected_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                record.get("guild_id", 0),
                record.get("player_name", ""),
                record.get("kills") or 0,
                record.get("assists") or 0,
                record.get("damage") or 0,
                record.get("survived"),
                record.get("health_restored"),
                record.get("rescue"),
                record.get("recall"),
                record.get("placement", 0),
                record.get("total_teams", 0),
                record.get("map_name", ""),
                record.get("game_mode", ""),
                int(record.get("is_mvp", False)),
                record.get("rating"),
                record.get("roster_profile_id"),
                record.get("confidence", 0.0),
                record.get("screenshot_type", ""),
                record.get("image_hash", ""),
                record.get("detected_at", datetime.utcnow().isoformat()),
            ),
        )
        self._db.commit()
        return cur.lastrowid

    def save_player_stats(self, records: list[dict]) -> int:
        """Batch insert. Returns count saved."""
        count = 0
        for r in records:
            self.save_player_stat(r)
            count += 1
        return count

    def get_player_stats(self, guild_id: int, days: int = 30) -> list[dict]:
        """All stats for a guild in the last N days."""
        since = (datetime.utcnow() - timedelta(days=days)).isoformat()
        rows = self._db.execute(
            """
            SELECT * FROM player_stats
            WHERE guild_id=? AND detected_at >= ?
            ORDER BY detected_at DESC
            """,
            (guild_id, since),
        ).fetchall()
        return [dict(r) for r in rows]

    def get_player_leaderboard(
        self,
        guild_id: int,
        days: int = 7,
        roster_only: bool = False,
    ) -> list[dict]:
        """
        Aggregate per-player stats for leaderboard.
        Returns list sorted by total_kills desc.
        """
        since = (datetime.utcnow() - timedelta(days=days)).isoformat()
        rows = self._db.execute(
            """
            WITH resolved AS (
                SELECT stats.*,
                       COALESCE(
                           stats.roster_profile_id,
                           (
                               SELECT roster.id
                               FROM roster_profiles AS roster
                               WHERE roster.guild_id=stats.guild_id
                                 AND roster.approved_uid IS NOT NULL
                                 AND normalize_ign(roster.approved_ign)=normalize_ign(stats.player_name)
                               ORDER BY roster.id
                               LIMIT 1
                           )
                       ) AS resolved_roster_profile_id
                FROM player_stats AS stats
                WHERE stats.guild_id=? AND stats.detected_at >= ?
            ),
            enriched AS (
                SELECT resolved.*,
                       COALESCE(roster.approved_ign, resolved.player_name) AS roster_name,
                       roster.approved_uid AS roster_uid,
                       roster.approved_role AS roster_role,
                       roster.approved_team_tag AS roster_team_tag
                FROM resolved
                LEFT JOIN roster_profiles AS roster
                  ON roster.id=resolved.resolved_roster_profile_id
            )
            SELECT
                MAX(roster_name)      AS player_name,
                resolved_roster_profile_id AS roster_profile_id,
                MAX(roster_uid)       AS roster_uid,
                MAX(roster_role)      AS roster_role,
                MAX(roster_team_tag)  AS roster_team_tag,
                COUNT(*)              AS matches,
                SUM(kills)            AS total_kills,
                SUM(assists)          AS total_assists,
                SUM(damage)           AS total_damage,
                ROUND(AVG(kills),2)   AS avg_kills,
                ROUND(AVG(damage),1)  AS avg_damage,
                ROUND(AVG(placement),1) AS avg_placement,
                MIN(placement)        AS best_placement,
                SUM(is_mvp)           AS mvp_count,
                ROUND(AVG(rating),1)  AS avg_rating
            FROM enriched
            WHERE (?=0 OR resolved_roster_profile_id IS NOT NULL)
            GROUP BY CASE
                WHEN resolved_roster_profile_id IS NOT NULL
                    THEN 'roster:' || resolved_roster_profile_id
                ELSE 'name:' || player_name
            END
            ORDER BY total_kills DESC
            """,
            (guild_id, since, int(roster_only)),
        ).fetchall()
        return [dict(r) for r in rows]

    def get_recent_stats(
        self,
        guild_id: int,
        limit: int = 20,
        roster_only: bool = False,
    ) -> list[dict]:
        """Most recently processed screenshots for a guild."""
        rows = self._db.execute(
            """
            WITH resolved AS (
                SELECT stats.*,
                       COALESCE(
                           stats.roster_profile_id,
                           (
                               SELECT roster.id
                               FROM roster_profiles AS roster
                               WHERE roster.guild_id=stats.guild_id
                                 AND roster.approved_uid IS NOT NULL
                                 AND normalize_ign(roster.approved_ign)=normalize_ign(stats.player_name)
                               ORDER BY roster.id
                               LIMIT 1
                           )
                       ) AS resolved_roster_profile_id
                FROM player_stats AS stats
                WHERE stats.guild_id=?
            )
            SELECT resolved.*,
                   COALESCE(roster.approved_ign, resolved.player_name) AS roster_name,
                   roster.approved_uid AS roster_uid,
                   roster.approved_role AS roster_role,
                   roster.approved_team_tag AS roster_team_tag
            FROM resolved
            LEFT JOIN roster_profiles AS roster
              ON roster.id=resolved.resolved_roster_profile_id
            WHERE (?=0 OR resolved_roster_profile_id IS NOT NULL)
            ORDER BY detected_at DESC
            LIMIT ?
            """,
            (guild_id, int(roster_only), limit),
        ).fetchall()
        records = []
        for row in rows:
            record = dict(row)
            record["roster_profile_id"] = record.pop("resolved_roster_profile_id")
            record["player_name"] = record.pop("roster_name")
            records.append(record)
        return records


# ── Singleton ─────────────────────────────────────────────────────────────
db = Database()