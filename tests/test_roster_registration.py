import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from bot import discord_bot
from bot.discord_bot import RosterApprovalView, RosterEditModal
from db.database import Database


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
            author=SimpleNamespace(id=self.user_id, display_name="Player One"),
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
            discord_display_name="Player One",
            uid="5123456789",
            ign="[ABC] Player",
        )

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
        self.assertIn("9876543210", message.edited["embed"].fields[1].value)
        self.assertEqual(interaction.followup.sent[0][0], "Roster submission updated and remains pending approval.")

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


if __name__ == "__main__":
    unittest.main()
