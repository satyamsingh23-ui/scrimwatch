import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx

from api import dashboard
from bot import discord_bot
from bot.discord_bot import (
    RemoveRosterPlayerView,
    RosterApprovalView,
    RosterEditModal,
    RosterTeamTagModal,
)
from db.database import Database
from utils.roster import extract_team_tag


class _Attachment:
    filename = "profile.png"

    async def read(self):
        return b"mock profile screenshot"


class _Channel:
    def __init__(self):
        self.sent = []

    async def send(self, **kwargs):
        self.sent.append(kwargs)


class _InteractionResponse:
    def __init__(self):
        self.edited = None
        self.sent = None

    async def edit_message(self, **kwargs):
        self.edited = kwargs

    async def send_message(self, *args, **kwargs):
        self.sent = (args, kwargs)

    async def defer(self, **kwargs):
        self.deferred = kwargs


class _Followup:
    def __init__(self):
        self.sent = None

    async def send(self, *args, **kwargs):
        self.sent = (args, kwargs)


class _ReviewMessage:
    def __init__(self):
        self.edited = None

    async def edit(self, **kwargs):
        self.edited = kwargs


class _CommandContext:
    def __init__(self, *, user_id=999, is_admin=True, guild_id=12345):
        self.guild = SimpleNamespace(id=guild_id)
        self.author = SimpleNamespace(
            id=user_id,
            guild_permissions=SimpleNamespace(administrator=is_admin),
        )
        self.sent = []

    async def send(self, content=None, **kwargs):
        message = _ReviewMessage()
        self.sent.append({"content": content, **kwargs, "message": message})
        return message


class RosterRegistrationTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database = Database(str(Path(self.temp_dir.name) / "roster.db"))
        self.database.connect()
        self.guild_id = 12345
        self.user_id = 67890
        self.channel = _Channel()
        self.message = SimpleNamespace(
            guild=SimpleNamespace(id=self.guild_id, name="Test Guild"),
            author=SimpleNamespace(
                id=self.user_id,
                name="global_player",
                display_name="Player One",
            ),
            channel=SimpleNamespace(
                id=24680,
                name="roster",
                send=self.channel.send,
            ),
            content="",
            attachments=[_Attachment()],
        )

    async def asyncTearDown(self):
        self.database.close()
        self.temp_dir.cleanup()

    def _create_pending_profile(self):
        return self.database.submit_roster_profile(
            guild_id=self.guild_id,
            discord_user_id=self.user_id,
            discord_username="global_player",
            discord_display_name="Player One",
            uid="5123456789",
            ign="[ABC] Player",
        )

    def _create_profile(
        self,
        *,
        user_id,
        ign,
        uid,
        team_tag="ABC",
        role="starter",
    ):
        return self.database.submit_roster_profile(
            guild_id=self.guild_id,
            discord_user_id=user_id,
            discord_username=f"user{user_id}",
            discord_display_name=f"Player {user_id}",
            uid=uid,
            ign=ign,
            team_tag=team_tag,
            role=role,
        )

    async def _run_remove_command(self, target, *, is_admin=True, user_id=999):
        context = _CommandContext(
            user_id=user_id,
            is_admin=is_admin,
            guild_id=self.guild_id,
        )
        with patch.object(discord_bot, "db", self.database):
            await discord_bot.cmd_remove_roster_player.callback(context, target=target)
        return context

    async def _confirm_removal(self, context, *, user_id=999, is_admin=True):
        view = context.sent[-1].get("view")
        self.assertIsInstance(view, RemoveRosterPlayerView)
        interaction = self._create_edit_interaction(user_id, is_admin=is_admin)
        interaction.guild_id = self.guild_id
        with patch.object(discord_bot, "db", self.database):
            await view.confirm.callback(interaction)
        return interaction

    def _create_edit_interaction(self, user_id, *, is_admin=False):
        return SimpleNamespace(
            user=SimpleNamespace(
                id=user_id,
                guild_permissions=SimpleNamespace(administrator=is_admin),
            ),
            guild_id=self.guild_id,
            response=_InteractionResponse(),
            followup=_Followup(),
        )

    async def _submit_edit(self, profile, user_id, *, is_admin, uid, ign):
        view = RosterApprovalView(self.guild_id, self.user_id)
        message = _ReviewMessage()
        modal = RosterEditModal(profile, view, message)
        self.assertEqual(modal.uid_input.default, profile["uid"])
        self.assertEqual(modal.ign_input.default, profile["ign"])
        modal.uid_input._value = uid
        modal.ign_input._value = ign
        interaction = self._create_edit_interaction(user_id, is_admin=is_admin)
        with patch.object(discord_bot, "db", self.database):
            await modal.on_submit(interaction)
        return interaction, message, view

    async def test_admin_can_edit_pending_profile(self):
        profile = self._create_pending_profile()
        interaction, message, view = await self._submit_edit(
            profile,
            999,
            is_admin=True,
            uid=" 9876543210 ",
            ign=" [NEW] Player ",
        )

        updated = self.database.get_roster_profile(self.guild_id, self.user_id)
        self.assertEqual(updated["uid"], "9876543210")
        self.assertEqual(updated["ign"], "[NEW] Player")
        self.assertEqual(updated["status"], "pending")
        self.assertEqual(updated["manually_edited"], 1)
        self.assertEqual(message.edited["view"], view)
        uid_field = next(
            field for field in message.edited["embed"].fields
            if field.name == "UID"
        )
        self.assertIn("9876543210", uid_field.value)
        self.assertEqual(interaction.followup.sent[0][0], "Roster submission updated and remains pending approval.")

    async def test_team_tag_detection_examples(self):
        examples = (
            ("HLsSATYAM", "HLS"),
            ("HLS_Name", "HLS"),
            ("[HLS] Name", "HLS"),
        )
        for user_id, (ign, expected_tag) in enumerate(examples, start=100):
            self.assertEqual(extract_team_tag(ign), expected_tag)
            profile = self.database.submit_roster_profile(
                guild_id=self.guild_id,
                discord_user_id=user_id,
                discord_username=f"user{user_id}",
                discord_display_name=f"Player {user_id}",
                uid=str(user_id),
                ign=ign,
            )
            self.assertEqual(profile["team_tag"], expected_tag)

        edited = self.database.edit_pending_roster_profile(
            self.guild_id,
            100,
            "100",
            "[NEW] Name",
        )
        self.assertEqual(edited["team_tag"], "NEW")

    async def test_admin_can_override_team_tag(self):
        profile = self._create_pending_profile()
        view = RosterApprovalView(self.guild_id, self.user_id)
        message = _ReviewMessage()
        modal = RosterTeamTagModal(profile, view, message)
        modal.team_tag_input._value = "  FIXED TEAM  "
        interaction = self._create_edit_interaction(999, is_admin=True)

        with patch.object(discord_bot, "db", self.database):
            await modal.on_submit(interaction)

        updated = self.database.get_roster_profile(self.guild_id, self.user_id)
        self.assertEqual(updated["team_tag"], "FIXED TEAM")
        self.assertEqual(updated["manually_edited"], 1)
        self.assertEqual(updated["status"], "pending")
        self.assertIs(message.edited["view"], view)

    async def test_admin_can_change_pending_role(self):
        self._create_pending_profile()
        view = RosterApprovalView(self.guild_id, self.user_id)
        view.select_role._values = ["substitute"]
        interaction = self._create_edit_interaction(999, is_admin=True)
        with patch.object(discord_bot, "db", self.database):
            await view.select_role.callback(
                interaction,
            )
        updated = self.database.get_roster_profile(self.guild_id, self.user_id)
        self.assertEqual(updated["role"], "substitute")
        self.assertEqual(updated["status"], "pending")
        self.assertIsNotNone(interaction.response.edited)

    async def test_remove_player_by_mention_confirms_and_deletes_roster_only(self):
        profile = self._create_profile(
            user_id=67890,
            ign="[ABC] Player",
            uid="5123456789",
        )
        self.database.review_roster_profile(
            self.guild_id,
            profile["discord_user_id"],
            "approved",
        )
        self._create_profile(
            user_id=67890,
            ign="[NEW] Pending",
            uid="5999999999",
        )
        self.database.save_player_stat(
            {
                "guild_id": self.guild_id,
                "player_name": "[ABC] Player",
                "kills": 4,
            }
        )

        context = await self._run_remove_command("<@67890>")
        prompt = context.sent[0]
        self.assertIsInstance(prompt["view"], RemoveRosterPlayerView)
        self.assertEqual(prompt["view"].timeout, 60)
        embed = prompt["embed"]
        self.assertEqual(embed.title, "Confirm roster player removal")
        self.assertEqual(
            {field.name: field.value for field in embed.fields},
            {
                "IGN": "[ABC] Player",
                "UID": "`5123456789`",
                "Team tag": "ABC",
                "Role": "Starter",
            },
        )
        interaction = await self._confirm_removal(context)

        self.assertIsNone(
            self.database.get_roster_profile(self.guild_id, profile["discord_user_id"])
        )
        self.assertEqual(
            interaction.response.edited["content"],
            "Removed [ABC] Player (5123456789) from the roster",
        )
        self.assertEqual(
            self.database.get_recent_stats(self.guild_id, 10)[0]["kills"],
            4,
        )

    async def test_remove_player_by_bgmi_uid(self):
        profile = self._create_profile(
            user_id=1001,
            ign="UIDTarget",
            uid="987654321",
        )
        context = await self._run_remove_command("987654321")
        view = context.sent[0]["view"]
        self.assertEqual(view.profile["discord_user_id"], profile["discord_user_id"])

    async def test_remove_player_by_case_insensitive_partial_ign(self):
        profile = self._create_profile(
            user_id=1002,
            ign="[HLS] Satyam",
            uid="123456789",
        )
        context = await self._run_remove_command("SATY")
        self.assertEqual(
            context.sent[0]["view"].profile["discord_user_id"],
            profile["discord_user_id"],
        )

    async def test_remove_player_ambiguous_match_lists_candidates(self):
        self._create_profile(user_id=1003, ign="[HLS] Sat", uid="333333333")
        self._create_profile(user_id=1004, ign="[HLS] Satyam", uid="444444444")

        context = await self._run_remove_command("sat")

        self.assertEqual(len(context.sent), 1)
        self.assertIn("Several roster players match", context.sent[0]["content"])
        self.assertIn("1. [HLS] Sat", context.sent[0]["content"])
        self.assertIn("2. [HLS] Satyam", context.sent[0]["content"])
        self.assertNotIn("view", context.sent[0])

    async def test_non_admin_cannot_remove_roster_player(self):
        self._create_profile(user_id=1005, ign="NoTouch", uid="555555555")

        context = await self._run_remove_command(
            "NoTouch",
            is_admin=False,
            user_id=777,
        )

        self.assertIn("Only server administrators", context.sent[0]["content"])
        self.assertIsNotNone(self.database.get_roster_profile(self.guild_id, 1005))

    async def test_cancel_roster_removal_leaves_profile_unchanged(self):
        profile = self._create_profile(
            user_id=1006,
            ign="[ABC] Cancel",
            uid="666666666",
        )
        context = await self._run_remove_command("666666666")
        view = context.sent[0]["view"]
        interaction = self._create_edit_interaction(999, is_admin=True)
        interaction.guild_id = self.guild_id
        with patch.object(discord_bot, "db", self.database):
            await view.cancel.callback(interaction)

        self.assertIsNotNone(
            self.database.get_roster_profile(self.guild_id, profile["discord_user_id"])
        )
        self.assertEqual(
            interaction.response.edited["content"],
            "Roster removal cancelled.",
        )

    async def test_different_admin_cannot_confirm_another_admin_removal(self):
        profile = self._create_profile(
            user_id=1009,
            ign="Protected Player",
            uid="909090909",
        )
        context = await self._run_remove_command("909090909")
        view = context.sent[0]["view"]
        interaction = self._create_edit_interaction(1000, is_admin=True)
        interaction.guild_id = self.guild_id
        with patch.object(discord_bot, "db", self.database):
            await view.confirm.callback(interaction)

        self.assertIsNotNone(interaction.response.sent)
        self.assertIsNotNone(
            self.database.get_roster_profile(self.guild_id, profile["discord_user_id"])
        )

    async def test_stats_save_skips_players_not_on_approved_roster(self):
        approved = self._create_profile(
            user_id=1010,
            ign="[HLS] Rostered",
            uid="101010101",
        )
        self.database.review_roster_profile(
            self.guild_id,
            approved["discord_user_id"],
            "approved",
        )
        records = [
            {
                "guild_id": self.guild_id,
                "player_name": "HLS.Rostered",
                "kills": 5,
                "placement": 1,
            },
            {
                "guild_id": self.guild_id,
                "player_name": "Unregistered Player",
                "kills": 8,
                "placement": 1,
            },
        ]
        view = discord_bot.StatsConfirmView(
            records=records,
            img_hash="approved-roster-filter-test",
            guild_id=self.guild_id,
            message=_ReviewMessage(),
            place_str="#1",
            map_name="Erangel",
        )
        interaction = self._create_edit_interaction(999, is_admin=True)

        with patch.object(discord_bot, "db", self.database):
            await view._do_save(interaction)

        saved = self.database.get_recent_stats(self.guild_id, 10)
        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0]["player_name"], "HLS.Rostered")
        self.assertEqual(view.records, [records[0]])

    async def test_reupload_after_removal_creates_new_pending_profile(self):
        self._create_profile(
            user_id=self.user_id,
            ign="[OLD] Player",
            uid="123123123",
        )
        context = await self._run_remove_command(f"<@{self.user_id}>")
        await self._confirm_removal(context)

        with (
            patch.object(discord_bot, "db", self.database),
            patch.object(
                discord_bot,
                "parse_profile_screenshot_vision",
                new=AsyncMock(
                    return_value={"UID": "321321321", "IGN": "[NEW] Player"}
                ),
            ),
        ):
            await discord_bot._handle_roster_screenshot(self.message, _Attachment())

        profile = self.database.get_roster_profile(self.guild_id, self.user_id)
        self.assertEqual(profile["uid"], "321321321")
        self.assertEqual(profile["ign"], "[NEW] Player")
        self.assertEqual(profile["status"], "pending")
        self.assertIsNone(profile["approved_uid"])

    async def test_roster_command_lists_starters_before_substitutes(self):
        starter = self._create_profile(
            user_id=1007,
            ign="Starter IGN",
            uid="777777777",
            team_tag="HLS",
            role="starter",
        )
        substitute = self._create_profile(
            user_id=1008,
            ign="Sub IGN",
            uid="888888888",
            team_tag="HLS",
            role="substitute",
        )
        for profile in (starter, substitute):
            self.database.review_roster_profile(
                self.guild_id,
                profile["discord_user_id"],
                "approved",
            )
        context = _CommandContext(guild_id=self.guild_id, is_admin=False)
        with patch.object(discord_bot, "db", self.database):
            await discord_bot.cmd_roster.callback(context)

        roster_text = context.sent[0]["content"]
        self.assertLess(roster_text.index("Starter IGN"), roster_text.index("Sub IGN"))
        self.assertIn("**HLS**", roster_text)
        self.assertIn("`777777777`", roster_text)
        self.assertIn("`888888888`", roster_text)

    async def test_roster_endpoint_groups_approved_players_with_starters_first(self):
        starter = self.database.submit_roster_profile(
            guild_id=self.guild_id,
            discord_user_id=9007199254740993,
            discord_username="starter_user",
            discord_display_name="Starter",
            uid="111111",
            ign="HLS_One",
            role="starter",
        )
        substitute = self.database.submit_roster_profile(
            guild_id=self.guild_id,
            discord_user_id=2,
            discord_username="sub_user",
            discord_display_name="Sub",
            uid="222222",
            ign="[HLS] Two",
            role="substitute",
        )
        self.database.review_roster_profile(
            self.guild_id, starter["discord_user_id"], "approved"
        )
        self.database.review_roster_profile(
            self.guild_id, substitute["discord_user_id"], "approved"
        )
        self.database.submit_roster_profile(
            guild_id=self.guild_id,
            discord_user_id=9007199254740993,
            discord_username="starter_user",
            discord_display_name="Starter",
            uid="999999",
            ign="[OTHER] New IGN",
        )
        self.database.review_roster_profile(
            self.guild_id, 9007199254740993, "rejected"
        )
        pending = self.database.submit_roster_profile(
            guild_id=self.guild_id,
            discord_user_id=3,
            discord_display_name="Pending",
            uid="333333",
            ign="HLS_Three",
        )
        self.assertEqual(pending["status"], "pending")

        with patch.object(dashboard, "db", self.database):
            transport = httpx.ASGITransport(app=dashboard.app)
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
            ) as client:
                response = await client.get(
                    "/roster",
                    params={"guild_id": self.guild_id},
                )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "teams": [
                    {
                        "team_tag": "HLS",
                        "players": [
                            {
                                "ign": "HLS_One",
                                "uid": "111111",
                                "discord_id": "9007199254740993",
                                "discord_username": "starter_user",
                                "discord_name": "Starter",
                                "role": "starter",
                            },
                            {
                                "ign": "[HLS] Two",
                                "uid": "222222",
                                "discord_id": "2",
                                "discord_username": "sub_user",
                                "discord_name": "Sub",
                                "role": "substitute",
                            },
                        ],
                    }
                ]
            },
        )
        self.assertIsInstance(
            response.json()["teams"][0]["players"][0]["discord_id"],
            str,
        )

    async def test_submitter_can_edit_own_pending_profile(self):
        profile = self._create_pending_profile()
        await self._submit_edit(
            profile,
            self.user_id,
            is_admin=False,
            uid="1234567890",
            ign="[SELF] Edit",
        )

        updated = self.database.get_roster_profile(self.guild_id, self.user_id)
        self.assertEqual(updated["uid"], "1234567890")
        self.assertEqual(updated["status"], "pending")
        self.assertEqual(updated["manually_edited"], 1)

    async def test_other_non_admin_cannot_edit_profile(self):
        profile = self._create_pending_profile()
        interaction, message, _ = await self._submit_edit(
            profile,
            111,
            is_admin=False,
            uid="9999999999",
            ign="Unauthorized",
        )

        current = self.database.get_roster_profile(self.guild_id, self.user_id)
        self.assertEqual(current["uid"], "5123456789")
        self.assertEqual(current["manually_edited"], 0)
        self.assertIsNotNone(interaction.response.sent)
        self.assertIsNone(message.edited)

    async def test_invalid_uid_is_rejected_without_changing_profile(self):
        profile = self._create_pending_profile()
        interaction, message, _ = await self._submit_edit(
            profile,
            999,
            is_admin=True,
            uid="12A45",
            ign="Valid IGN",
        )

        current = self.database.get_roster_profile(self.guild_id, self.user_id)
        self.assertEqual(current["uid"], "5123456789")
        self.assertEqual(current["ign"], "[ABC] Player")
        self.assertEqual(current["manually_edited"], 0)
        self.assertIn("digits only", interaction.response.sent[0][0])
        self.assertIsNone(message.edited)

    async def test_edit_does_not_change_approved_live_profile(self):
        profile = self._create_pending_profile()
        self.database.review_roster_profile(
            self.guild_id,
            self.user_id,
            "approved",
        )
        profile = self.database.submit_roster_profile(
            guild_id=self.guild_id,
            discord_user_id=self.user_id,
            discord_username="global_player",
            discord_display_name="Player One",
            uid="1111111111",
            ign="[PENDING] Update",
        )
        approved_before = self.database.get_approved_roster_profile(
            self.guild_id,
            self.user_id,
        )

        await self._submit_edit(
            profile,
            self.user_id,
            is_admin=False,
            uid="2222222222",
            ign="[EDITED] Pending",
        )

        approved_after = self.database.get_approved_roster_profile(
            self.guild_id,
            self.user_id,
        )
        pending = self.database.get_roster_profile(self.guild_id, self.user_id)
        self.assertEqual(approved_after, approved_before)
        self.assertEqual(pending["uid"], "2222222222")
        self.assertEqual(pending["ign"], "[EDITED] Pending")
        self.assertEqual(pending["status"], "pending")

    async def test_resubmission_keeps_approved_profile_until_admin_approves(self):
        parse_result = AsyncMock(
            return_value={"UID": "5123456789", "IGN": "[OLD] Player"}
        )
        with (
            patch.object(discord_bot, "db", self.database),
            patch.object(discord_bot, "parse_profile_screenshot_vision", parse_result),
            patch.object(
                discord_bot.guild_manager,
                "get",
                return_value=SimpleNamespace(
                    should_scan_for_idp=lambda channel_id: False,
                    is_reg_channel=lambda channel_id: False,
                    is_roster_channel=lambda channel_id: True,
                    is_stats_channel=lambda channel_id: False,
                ),
            ),
            patch.object(discord_bot.state, "running", True),
            patch.object(discord_bot.bot, "process_commands", new=AsyncMock()),
        ):
            await discord_bot.on_message(self.message)
            first_submission = self.database.get_roster_profile(
                self.guild_id,
                self.user_id,
            )
            self.assertEqual(first_submission["status"], "pending")
            self.assertEqual(first_submission["role"], "starter")
            self.assertEqual(first_submission["uid"], "5123456789")
            self.assertEqual(first_submission["discord_username"], "global_player")
            self.assertEqual(parse_result.await_count, 1)

            first_view = self.channel.sent[-1]["view"]
            admin = SimpleNamespace(
                user=SimpleNamespace(
                    guild_permissions=SimpleNamespace(administrator=True)
                ),
                guild_id=self.guild_id,
                response=_InteractionResponse(),
            )
            await first_view._review(admin, "approved")
            self.assertEqual(
                self.database.get_approved_roster_profile(
                    self.guild_id,
                    self.user_id,
                )["ign"],
                "[OLD] Player",
            )

            parse_result.return_value = {
                "UID": "5987654321",
                "IGN": "[NEW] Player",
            }
            await discord_bot._handle_roster_screenshot(
                self.message,
                _Attachment(),
            )
            pending = self.database.get_roster_profile(
                self.guild_id,
                self.user_id,
            )
            live = self.database.get_approved_roster_profile(
                self.guild_id,
                self.user_id,
            )
            self.assertEqual(pending["status"], "pending")
            self.assertEqual(pending["uid"], "5987654321")
            self.assertEqual(live["uid"], "5123456789")
            self.assertEqual(live["ign"], "[OLD] Player")

            new_view = self.channel.sent[-1]["view"]
            non_admin = SimpleNamespace(
                user=SimpleNamespace(
                    guild_permissions=SimpleNamespace(administrator=False)
                ),
                guild_id=self.guild_id,
                response=_InteractionResponse(),
            )
            await new_view._review(non_admin, "approved")
            self.assertIsNotNone(non_admin.response.sent)
            self.assertEqual(
                self.database.get_roster_profile(
                    self.guild_id,
                    self.user_id,
                )["status"],
                "pending",
            )

            admin = SimpleNamespace(
                user=SimpleNamespace(
                    guild_permissions=SimpleNamespace(administrator=True)
                ),
                guild_id=self.guild_id,
                response=_InteractionResponse(),
            )
            await new_view._review(admin, "approved")
            self.assertEqual(
                self.database.get_approved_roster_profile(
                    self.guild_id,
                    self.user_id,
                )["uid"],
                "5987654321",
            )

    async def test_discord_username_is_saved_on_screenshot_submission(self):
        with (
            patch.object(discord_bot, "db", self.database),
            patch.object(
                discord_bot,
                "parse_profile_screenshot_vision",
                new=AsyncMock(
                    return_value={"UID": "123456789", "IGN": "HLS_Player"}
                ),
            ),
        ):
            await discord_bot._handle_roster_screenshot(self.message, _Attachment())
        profile = self.database.get_roster_profile(self.guild_id, self.user_id)
        self.assertEqual(profile["discord_username"], "global_player")

    async def test_database_migrates_existing_roster_table(self):
        legacy_path = Path(self.temp_dir.name) / "legacy.db"
        connection = sqlite3.connect(legacy_path)
        connection.execute(
            """
            CREATE TABLE roster_profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guild_id INTEGER NOT NULL,
                discord_user_id INTEGER NOT NULL,
                discord_display_name TEXT NOT NULL,
                uid TEXT NOT NULL,
                ign TEXT NOT NULL,
                team_tag TEXT,
                role TEXT NOT NULL DEFAULT 'starter',
                manually_edited INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending',
                approved_uid TEXT,
                approved_ign TEXT,
                approved_team_tag TEXT,
                approved_role TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                reviewed_at TEXT,
                UNIQUE (guild_id, discord_user_id)
            )
            """
        )
        connection.execute(
            """
            INSERT INTO roster_profiles
                (guild_id, discord_user_id, discord_display_name, uid, ign,
                 status, approved_uid, approved_ign)
            VALUES (1, 2, 'Legacy Player', '1234', 'Legacy',
                    'approved', '1234', 'Legacy')
            """
        )
        connection.commit()
        connection.close()

        migrated = Database(str(legacy_path))
        migrated.connect()
        try:
            columns = {
                row["name"]
                for row in migrated._db.execute(
                    "PRAGMA table_info(roster_profiles)"
                )
            }
            self.assertIn("discord_username", columns)
            profile = migrated.get_roster_profile(1, 2)
            self.assertIsNone(profile["discord_username"])
            self.assertEqual(profile["approved_uid"], "1234")
        finally:
            migrated.close()


if __name__ == "__main__":
    unittest.main()
