import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import Mock, patch

import httpx

from api import dashboard
from db.database import Database


def stat_row(
    match_hash,
    *,
    ign="Player",
    placement=1,
    kills=0,
    damage=0,
    rating=0.0,
    survived=0,
    is_mvp=0,
    detected_at="2026-10-17 10:00:00",
    map_name="Erangel",
):
    return {
        "id": hash((match_hash, ign)) & 0x7FFFFFFF,
        "image_hash": match_hash,
        "detected_at": detected_at,
        "map_name": map_name,
        "placement": placement,
        "total_teams": 16,
        "kills": kills,
        "damage": damage,
        "rating": rating,
        "survived": survived,
        "is_mvp": is_mvp,
        "roster_profile_id": 1,
        "roster_uid": "123456789",
        "player_name": ign,
    }


class MatchExplorerApiTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.rows = [
            stat_row("winner", ign="Ace", placement=1, kills=3, damage=300, is_mvp=1),
            stat_row("tie-low", ign="One", placement=2, kills=5, damage=500),
            stat_row("tie-high", ign="Two", placement=2, kills=7, damage=300),
            stat_row("last", ign="Ace", placement=5, kills=8, damage=900),
        ]
        self.database = Mock()
        self.database.get_match_explorer_rows.return_value = self.rows
        self.db_patch = patch.object(dashboard, "db", self.database)
        self.db_patch.start()
        self.addCleanup(self.db_patch.stop)
        self.transport = httpx.ASGITransport(app=dashboard.app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")
        self.addAsyncCleanup(self.client.aclose)

    async def test_days_map_roster_filter_and_limit_are_forwarded(self):
        response = await self.client.get(
            "/matches/explore",
            params={
                "guild_id": 12345,
                "days": 7,
                "limit": 2,
                "map_name": "Erangel",
                "roster_only": True,
            },
        )

        self.assertEqual(response.status_code, 200)
        self.database.get_match_explorer_rows.assert_called_once_with(
            12345,
            days=7,
            map_name="Erangel",
            roster_only=True,
        )
        payload = response.json()
        self.assertEqual([match["match_id"] for match in payload["matches"]], ["winner", "tie-high"])
        self.assertEqual(payload["summary"]["count"], 2)
        self.assertEqual(payload["summary"]["total_kills"], 10)
        self.assertEqual(payload["summary"]["chicken_dinners"], 1)
        self.assertEqual(payload["matches"][0]["mvp"], "Ace")
        self.assertEqual(payload["matches"][0]["players"][0]["uid"], "123456789")

    async def test_best_and_worst_placement_ties_break_by_kills_then_damage(self):
        best = await self.client.get(
            "/matches/explore",
            params={"guild_id": 12345, "days": "all", "limit": 10, "sort_by": "placement"},
        )
        worst = await self.client.get(
            "/matches/explore",
            params={
                "guild_id": 12345,
                "days": "all",
                "limit": 10,
                "sort_by": "placement",
                "order": "worst",
            },
        )

        self.assertEqual(
            [match["match_id"] for match in best.json()["matches"]],
            ["winner", "tie-high", "tie-low", "last"],
        )
        self.assertEqual(
            [match["match_id"] for match in worst.json()["matches"]],
            ["last", "tie-low", "tie-high", "winner"],
        )
        self.database.get_match_explorer_rows.assert_any_call(
            12345, days=None, map_name=None, roster_only=True
        )

    async def test_other_sort_fields_order_by_requested_direction(self):
        most_kills = await self.client.get(
            "/matches/explore",
            params={"guild_id": 12345, "sort_by": "kills", "order": "best"},
        )
        fewest_kills = await self.client.get(
            "/matches/explore",
            params={"guild_id": 12345, "sort_by": "kills", "order": "worst"},
        )
        self.assertEqual(most_kills.json()["matches"][0]["match_id"], "last")
        self.assertEqual(fewest_kills.json()["matches"][0]["match_id"], "winner")

    async def test_invalid_parameters_are_rejected(self):
        invalid_params = [
            {"days": "0"},
            {"days": "366"},
            {"days": "seven"},
            {"limit": "0"},
            {"limit": "51"},
            {"sort_by": "assists"},
            {"order": "middle"},
            {"map_name": ""},
            {"map_name": "x" * 101},
        ]
        for invalid in invalid_params:
            with self.subTest(params=invalid):
                response = await self.client.get(
                    "/matches/explore",
                    params={"guild_id": 12345, **invalid},
                )
                self.assertEqual(response.status_code, 400)


class MatchExplorerDatabaseTest(unittest.TestCase):
    def test_roster_only_map_and_date_filters_with_legacy_ign_resolution(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            database = Database(str(Path(temp_dir) / "explorer.db"))
            database.connect()
            try:
                database.submit_roster_profile(
                    guild_id=12345,
                    discord_user_id=67890,
                    discord_username="player",
                    discord_display_name="Player",
                    uid="987654321",
                    ign="[HLS] Ace",
                )
                approved_profile = database.review_roster_profile(
                    12345, 67890, "approved"
                )
                recent = datetime.utcnow().isoformat()
                old = (datetime.utcnow() - timedelta(days=40)).isoformat()
                database.save_player_stat(
                    {
                        "guild_id": 12345,
                        "player_name": "hls ace",
                        "kills": 5,
                        "damage": 500,
                        "placement": 1,
                        "map_name": "Erangel",
                        "image_hash": "recent-match",
                        "detected_at": recent,
                    }
                )
                database.save_player_stat(
                    {
                        "guild_id": 12345,
                        "player_name": "Unknown Player",
                        "kills": 2,
                        "placement": 4,
                        "map_name": "Erangel",
                        "image_hash": "unknown-match",
                        "detected_at": recent,
                    }
                )
                database.save_player_stat(
                    {
                        "guild_id": 12345,
                        "player_name": "[HLS] Ace",
                        "kills": 9,
                        "placement": 1,
                        "map_name": "Miramar",
                        "image_hash": "old-match",
                        "detected_at": old,
                    }
                )

                rows = database.get_match_explorer_rows(
                    12345,
                    days=7,
                    map_name="erangel",
                    roster_only=True,
                )
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]["image_hash"], "recent-match")
                self.assertEqual(rows[0]["roster_uid"], "987654321")
                self.assertIsNotNone(rows[0]["roster_profile_id"])
                self.assertEqual(approved_profile["status"], "approved")

                all_roster_rows = database.get_match_explorer_rows(
                    12345, days=None, roster_only=True
                )
                self.assertEqual(
                    {row["image_hash"] for row in all_roster_rows},
                    {"recent-match", "old-match"},
                )
            finally:
                database.close()
