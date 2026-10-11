import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from bot import discord_bot
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
