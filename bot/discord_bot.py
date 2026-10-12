"""
bot/discord_bot.py — Discord Scrim Monitor Bot

Improvements over original:
  ✓ Per-guild state (no cross-server data collision)
  ✓ Persistent channels + slots via SQLite (survive restarts)
  ✓ Strict IDP extractor (labeled Room ID, confidence scoring)
  ✓ Per-channel rate limiting (no alert spam)
  ✓ Async WhatsApp queue (non-blocking, retried)
  ✓ on_ready guard (handles Discord reconnects)
  ✓ !unsetidchannel / !unsetregchannel commands
  ✓ Improved !status with queue depth + failure count
  ✓ on_command_error handler (no silent failures)
  ✓ Daily DB pruning task
"""

import asyncio
import difflib
import os
import re
import unicodedata
from datetime import datetime

import discord
from discord.ext import commands, tasks

import config
from bot.guild_state import guild_manager, normalize
from bot.idp_extractor import extract_idp, idp_key
from bot.rate_limiter import ChannelRateLimiter
from db.database import db
from services import whatsapp
from state import state
from utils.logger import get_logger
from utils.image_preprocessing import preprocess, hash_image
from utils.roster import extract_team_tag
from services.ocr_service import ocr_service
from services.vision_parser import (
    parse_profile_screenshot_vision,
    parse_screenshot_vision as parse_screenshot,
)

log = get_logger("discord_bot")


def _normalize_player_ign(name: str) -> str:
    normalized = unicodedata.normalize("NFKD", name).casefold()
    return re.sub(r"[^a-z0-9]", "", normalized)


# ── Intents ───────────────────────────────────────────────────────────────
intents = discord.Intents.default()
intents.message_content = True
intents.guilds = True

bot = commands.Bot(
    command_prefix="!",
    intents=intents,
    help_command=None,  # We'll define our own
)

# ── Rate limiter (shared across all guilds) ───────────────────────────────
_idp_rate_limiter = ChannelRateLimiter()

# ── Slot parsing regex ────────────────────────────────────────────────────
_SLOT_PATTERN = re.compile(
    r"slot\s*#?(\d{1,2})\s*(?:->|:|-)?\s*(?:team\s*)?(.+)",
    re.IGNORECASE,
)

# ── Guard: track if we've already done on_ready setup ────────────────────
_ready_fired = False


# ═════════════════════════════════════════════════════════════════════════
# LIFECYCLE EVENTS
# ═════════════════════════════════════════════════════════════════════════

@bot.event
async def on_ready() -> None:
    global _ready_fired
    if _ready_fired:
        # Discord fires on_ready again after reconnects — skip re-initialization
        log.info("on_ready fired again (reconnect) — skipping re-init.")
        return
    _ready_fired = True

    guild_count = len(bot.guilds)
    log.info(f"Bot ready | user={bot.user} | guilds={guild_count}")

    # Pre-load guild state from DB for all known guilds
    guild_manager.preload([g.id for g in bot.guilds])

    await _backfill_roster_usernames()

    state.mark_started(pid=os.getpid(), server_count=guild_count)

    # Start background workers
    await whatsapp.start_worker()
    _daily_prune.start()

    log.info("All systems up. Monitoring active.")


async def _backfill_roster_usernames() -> None:
    for discord_user_id in db.get_approved_roster_users_missing_username():
        try:
            user = await bot.fetch_user(discord_user_id)
        except discord.NotFound:
            log.info(
                f"Roster username backfill skipped: Discord user "
                f"{discord_user_id} not found."
            )
            continue
        except discord.HTTPException as exc:
            log.warning(
                f"Roster username backfill failed for {discord_user_id}: {exc}"
            )
            continue

        updated = db.backfill_approved_roster_username(
            discord_user_id,
            user.name,
        )
        if updated:
            log.info(
                f"Roster username backfilled for {updated} approved row(s) "
                f"for Discord user {discord_user_id}."
            )


@bot.event
async def on_disconnect() -> None:
    log.warning("Bot disconnected from Discord (will auto-reconnect).")
    # Do NOT call state.mark_stopped() here — reconnect is automatic.


@bot.event
async def on_error(event: str, *args, **kwargs) -> None:
    log.exception(f"Unhandled error in event '{event}'")
    state.record_crash()


@bot.event
async def on_guild_join(guild: discord.Guild) -> None:
    state.server_count = len(bot.guilds)
    log.info(f"Joined guild: {guild.name} ({guild.id})")
    # Pre-load (empty) state for new guild
    guild_manager.get(guild.id)


@bot.event
async def on_guild_remove(guild: discord.Guild) -> None:
    state.server_count = len(bot.guilds)
    log.info(f"Left guild: {guild.name} ({guild.id})")
    guild_manager.evict(guild.id)


# ═════════════════════════════════════════════════════════════════════════
# COMMAND ERROR HANDLER — prevents silent failures
# ═════════════════════════════════════════════════════════════════════════

@bot.event
async def on_command_error(ctx: commands.Context, error: Exception) -> None:
    if isinstance(error, commands.MissingPermissions):
        await ctx.send("🚫 You don't have permission to use this command.")
    elif isinstance(error, commands.MissingRequiredArgument):
        await ctx.send(f"⚠️ Missing argument: `{error.param.name}`. Use `!help` for usage.")
    elif isinstance(error, commands.CommandNotFound):
        pass  # Silently ignore unknown commands (avoid spam)
    elif isinstance(error, commands.NoPrivateMessage):
        await ctx.send("⚠️ This command can only be used in a server.")
    else:
        log.exception(f"Command error in '{ctx.command}': {error}")
        await ctx.send(f"❌ Unexpected error: `{error}`")


# ═════════════════════════════════════════════════════════════════════════
# BACKGROUND TASKS
# ═════════════════════════════════════════════════════════════════════════

@tasks.loop(hours=24)
async def _daily_prune() -> None:
    """Delete IDP history older than 7 days. Runs once per 24 hours."""
    deleted = db.prune_old_history(days=7)
    log.info(f"Daily prune: removed {deleted} old IDP history records.")


@_daily_prune.before_loop
async def _before_daily_prune() -> None:
    await bot.wait_until_ready()


# ═════════════════════════════════════════════════════════════════════════
# CORE: MESSAGE HANDLER
# ═════════════════════════════════════════════════════════════════════════

@bot.event
async def on_message(message: discord.Message) -> None:
    # ── Basic guards ──────────────────────────────────────────────────────
    if message.author == bot.user:
        return
    if not message.guild:
        return  # Ignore DMs
    if not state.running:
        return

    guild_id = message.guild.id

    # Guild whitelist filter
    if config.MONITORED_GUILD_IDS and guild_id not in config.MONITORED_GUILD_IDS:
        return

    gs          = guild_manager.get(guild_id)
    channel_id  = message.channel.id
    channel_name = getattr(message.channel, "name", "unknown")
    guild_name  = message.guild.name
    content     = message.content

    # ── 0. Roster profile screenshot registration ────────────────────────
    if gs.is_roster_channel(channel_id) and message.attachments:
        for attachment in message.attachments:
            content_type = (getattr(attachment, "content_type", "") or "").lower()
            filename = (attachment.filename or "").lower()
            if content_type.startswith("image/") or filename.endswith(
                (".png", ".jpg", ".jpeg", ".webp", ".bmp")
            ):
                await _handle_roster_screenshot(message, attachment)

    # ── 1. IDP Detection ─────────────────────────────────────────────────
    if gs.should_scan_for_idp(channel_id):
        idp = extract_idp(content)
        if idp:
            key = idp_key(idp)

            if gs.has_seen_idp(key):
                # Exact duplicate — skip silently
                state.record_duplicate_skipped()
                log.debug(f"IDP duplicate skipped: {key}")

            elif not _idp_rate_limiter.is_allowed(guild_id, channel_id):
                # Rate-limited channel — skip
                log.debug(f"IDP rate-limited: guild={guild_id} ch={channel_id}")

            else:
                # New, allowed IDP — handle it
                gs.mark_idp_seen(key)
                await _handle_idp(message, idp, guild_name, channel_name)

    # ── 2. Slot Registration ──────────────────────────────────────────────
    if gs.is_reg_channel(channel_id):
        updated = _process_slot_message(content, guild_id, gs)
        if updated:
            embed = discord.Embed(
                title="📋 SLOT LIST UPDATED",
                description=gs.format_slots(),
                color=discord.Color.green(),
            )
            await message.channel.send(embed=embed)

   # ── 3. Screenshot stats detection ─────────────────────────────────
    if gs.is_stats_channel(channel_id) and message.attachments:
        for att in message.attachments:
            ct = (getattr(att, "content_type", "") or "").lower()
            name = (att.filename or "").lower()
            is_image = ct.startswith("image/") or name.endswith(
                (".png", ".jpg", ".jpeg", ".webp", ".bmp")
            )
            if is_image:
                await _handle_stats_screenshot(message, att, guild_id)
    
    # ── 3. Keyword Detection ──────────────────────────────────────────────
    content_lower = content.lower()
    for keyword in config.SCRIM_KEYWORDS:
        if keyword in content_lower:
            summary = (
                f"[{guild_name}] #{channel_name} | "
                f"{message.author} | kw={keyword}"
            )
            state.record_detection(summary)
            log.info(f"Keyword: {summary}")
            break

    await bot.process_commands(message)


class RosterApprovalView(discord.ui.View):
    def __init__(
        self,
        guild_id: int,
        discord_user_id: int,
        role: str = "starter",
    ):
        super().__init__(timeout=24 * 60 * 60)
        self.guild_id = guild_id
        self.discord_user_id = discord_user_id
        self.select_role.options = [
            discord.SelectOption(
                label="Starter",
                value="starter",
                default=role == "starter",
            ),
            discord.SelectOption(
                label="Substitute",
                value="substitute",
                default=role == "substitute",
            ),
        ]

    async def _refresh_pending_card(
        self,
        interaction: discord.Interaction,
        profile: dict,
    ) -> None:
        embed = _build_roster_pending_embed(profile)
        await interaction.response.edit_message(embed=embed, view=self)

    @discord.ui.select(
        placeholder="Select roster role",
        options=[
            discord.SelectOption(label="Starter", value="starter"),
            discord.SelectOption(label="Substitute", value="substitute"),
        ],
        row=1,
    )
    async def select_role(
        self,
        interaction: discord.Interaction,
        select: discord.ui.Select,
    ) -> None:
        permissions = getattr(interaction.user, "guild_permissions", None)
        if (
            interaction.guild_id != self.guild_id
            or not permissions
            or not permissions.administrator
        ):
            await interaction.response.send_message(
                "Only server administrators can change the roster role.",
                ephemeral=True,
            )
            return
        profile = db.update_pending_roster_role(
            self.guild_id,
            self.discord_user_id,
            select.values[0],
        )
        if not profile:
            await interaction.response.send_message(
                "This roster submission is no longer pending review.",
                ephemeral=True,
            )
            return
        self.select_role.options = [
            discord.SelectOption(
                label="Starter",
                value="starter",
                default=profile["role"] == "starter",
            ),
            discord.SelectOption(
                label="Substitute",
                value="substitute",
                default=profile["role"] == "substitute",
            ),
        ]
        await self._refresh_pending_card(interaction, profile)

    async def _review(
        self,
        interaction: discord.Interaction,
        status: str,
    ) -> None:
        permissions = getattr(interaction.user, "guild_permissions", None)
        if not permissions or not permissions.administrator:
            await interaction.response.send_message(
                "Only server administrators can review roster registrations.",
                ephemeral=True,
            )
            return
        if interaction.guild_id != self.guild_id:
            await interaction.response.send_message(
                "This roster review belongs to a different server.",
                ephemeral=True,
            )
            return

        profile = db.get_roster_profile(self.guild_id, self.discord_user_id)
        if not profile or profile["status"] != "pending":
            await interaction.response.send_message(
                "This roster submission is no longer pending review.",
                ephemeral=True,
            )
            return

        reviewed = db.review_roster_profile(
            self.guild_id,
            self.discord_user_id,
            status,
        )
        if not reviewed:
            await interaction.response.send_message(
                "The roster submission could not be found.",
                ephemeral=True,
            )
            return

        embed = discord.Embed(
            title="Roster registration approved"
            if status == "approved"
            else "Roster registration rejected",
            color=discord.Color.green()
            if status == "approved"
            else discord.Color.red(),
        )
        embed.add_field(
            name="Discord identity",
            value=(
                f"ID: `{reviewed['discord_user_id']}`\n"
                f"Username: `{reviewed['discord_username'] or 'Unknown'}`\n"
                f"Mention: <@{reviewed['discord_user_id']}>"
            ),
            inline=False,
        )
        embed.add_field(
            name="Display name",
            value=reviewed["discord_display_name"],
            inline=False,
        )
        embed.add_field(name="UID", value=f"`{reviewed['uid']}`", inline=True)
        embed.add_field(name="IGN", value=reviewed["ign"], inline=True)
        embed.set_footer(text=f"Reviewed by {interaction.user}")
        await interaction.response.edit_message(embed=embed, view=None)

    @discord.ui.button(label="Edit", style=discord.ButtonStyle.secondary)
    async def edit(
        self,
        interaction: discord.Interaction,
        button: discord.ui.Button,
    ) -> None:
        permissions = getattr(interaction.user, "guild_permissions", None)
        is_admin = bool(permissions and permissions.administrator)
        is_submitter = interaction.user.id == self.discord_user_id
        if interaction.guild_id != self.guild_id or not (is_admin or is_submitter):
            await interaction.response.send_message(
                "Only an administrator or the player who submitted this entry can edit it.",
                ephemeral=True,
            )
            return

        profile = db.get_roster_profile(self.guild_id, self.discord_user_id)
        if not profile or profile["status"] != "pending":
            await interaction.response.send_message(
                "This roster submission is no longer pending review.",
                ephemeral=True,
            )
            return
        if interaction.message is None:
            await interaction.response.send_message(
                "The roster review message is no longer available.",
                ephemeral=True,
            )
            return

        await interaction.response.send_modal(
            RosterEditModal(profile, self, interaction.message)
        )

    @discord.ui.button(
        label="Set Team",
        style=discord.ButtonStyle.secondary,
        row=0,
    )
    async def set_team(
        self,
        interaction: discord.Interaction,
        button: discord.ui.Button,
    ) -> None:
        permissions = getattr(interaction.user, "guild_permissions", None)
        if (
            interaction.guild_id != self.guild_id
            or not permissions
            or not permissions.administrator
        ):
            await interaction.response.send_message(
                "Only server administrators can override the team tag.",
                ephemeral=True,
            )
            return
        profile = db.get_roster_profile(self.guild_id, self.discord_user_id)
        if not profile or profile["status"] != "pending":
            await interaction.response.send_message(
                "This roster submission is no longer pending review.",
                ephemeral=True,
            )
            return
        if interaction.message is None:
            await interaction.response.send_message(
                "The roster review message is no longer available.",
                ephemeral=True,
            )
            return
        await interaction.response.send_modal(
            RosterTeamTagModal(profile, self, interaction.message)
        )

    @discord.ui.button(label="Approve", style=discord.ButtonStyle.success)
    async def approve(
        self,
        interaction: discord.Interaction,
        button: discord.ui.Button,
    ) -> None:
        await self._review(interaction, "approved")

    @discord.ui.button(label="Reject", style=discord.ButtonStyle.danger)
    async def reject(
        self,
        interaction: discord.Interaction,
        button: discord.ui.Button,
    ) -> None:
        await self._review(interaction, "rejected")


class RemoveRosterPlayerView(discord.ui.View):
    def __init__(self, guild_id: int, admin_user_id: int, profile: dict):
        super().__init__(timeout=60)
        self.guild_id = guild_id
        self.admin_user_id = admin_user_id
        self.profile = profile
        self.message: discord.Message | None = None

    async def _authorize(self, interaction: discord.Interaction) -> bool:
        permissions = getattr(interaction.user, "guild_permissions", None)
        if (
            interaction.guild_id != self.guild_id
            or interaction.user.id != self.admin_user_id
            or not permissions
            or not permissions.administrator
        ):
            await interaction.response.send_message(
                "Only the administrator who started this removal can use these buttons.",
                ephemeral=True,
            )
            return False
        return True

    @discord.ui.button(label="Confirm", style=discord.ButtonStyle.danger)
    async def confirm(
        self,
        interaction: discord.Interaction,
        button: discord.ui.Button,
    ) -> None:
        if not await self._authorize(interaction):
            return
        user_id = self.profile["discord_user_id"]
        removed = db.remove_roster_profile(self.guild_id, user_id)
        if not removed:
            await interaction.response.edit_message(
                content="That player is no longer on the roster.",
                embed=None,
                view=None,
            )
            return
        await interaction.response.edit_message(
            content=(
                f"Removed {self.profile['_display_ign']} "
                f"({self.profile['_display_uid']}) from the roster"
            ),
            embed=None,
            view=None,
        )

    @discord.ui.button(label="Cancel", style=discord.ButtonStyle.secondary)
    async def cancel(
        self,
        interaction: discord.Interaction,
        button: discord.ui.Button,
    ) -> None:
        if not await self._authorize(interaction):
            return
        await interaction.response.edit_message(
            content="Roster removal cancelled.",
            embed=None,
            view=None,
        )

    async def on_timeout(self) -> None:
        for item in self.children:
            if isinstance(item, discord.ui.Button):
                item.disabled = True
        if self.message:
            try:
                await self.message.edit(view=self)
            except discord.HTTPException as exc:
                log.warning(f"Could not disable expired roster removal buttons: {exc}")


class RosterEditModal(discord.ui.Modal, title="Edit Roster Submission"):
    uid_input = discord.ui.TextInput(
        label="UID",
        placeholder="Digits only",
        max_length=32,
        required=True,
    )
    ign_input = discord.ui.TextInput(
        label="IGN",
        placeholder="Exact in-game name, including clan tag",
        max_length=100,
        required=True,
    )

    def __init__(
        self,
        profile: dict,
        view: RosterApprovalView,
        message: discord.Message,
    ):
        super().__init__()
        self.uid_input.default = profile["uid"]
        self.ign_input.default = profile["ign"]
        self._view = view
        self._message = message

    async def on_submit(self, interaction: discord.Interaction) -> None:
        permissions = getattr(interaction.user, "guild_permissions", None)
        is_admin = bool(permissions and permissions.administrator)
        is_submitter = interaction.user.id == self._view.discord_user_id
        if (
            interaction.guild_id != self._view.guild_id
            or not (is_admin or is_submitter)
        ):
            await interaction.response.send_message(
                "Only an administrator or the player who submitted this entry can edit it.",
                ephemeral=True,
            )
            return

        uid = "".join(self.uid_input.value.split())
        ign = self.ign_input.value.strip()
        if not uid.isdigit():
            await interaction.response.send_message(
                "UID must contain digits only.",
                ephemeral=True,
            )
            return
        if not ign:
            await interaction.response.send_message(
                "IGN cannot be empty.",
                ephemeral=True,
            )
            return

        profile = db.edit_pending_roster_profile(
            self._view.guild_id,
            self._view.discord_user_id,
            uid,
            ign,
            extract_team_tag(ign),
        )
        if not profile:
            await interaction.response.send_message(
                "This roster submission is no longer pending review.",
                ephemeral=True,
            )
            return

        await interaction.response.defer(ephemeral=True)
        embed = _build_roster_pending_embed(profile)
        try:
            await self._message.edit(embed=embed, view=self._view)
        except discord.HTTPException as exc:
            log.error(
                f"Roster: could not refresh edited review card | "
                f"guild={self._view.guild_id} | "
                f"user={self._view.discord_user_id} | error={exc}"
            )
            await interaction.followup.send(
                "The roster entry was saved, but I couldn't refresh its review card.",
                ephemeral=True,
            )
            return
        await interaction.followup.send(
            "Roster submission updated and remains pending approval.",
            ephemeral=True,
        )


class RosterTeamTagModal(discord.ui.Modal, title="Set Roster Team"):
    team_tag_input = discord.ui.TextInput(
        label="Team tag",
        placeholder="Team name/tag",
        max_length=50,
        required=True,
    )

    def __init__(
        self,
        profile: dict,
        view: RosterApprovalView,
        message: discord.Message,
    ):
        super().__init__()
        self.team_tag_input.default = profile.get("team_tag") or ""
        self._view = view
        self._message = message

    async def on_submit(self, interaction: discord.Interaction) -> None:
        permissions = getattr(interaction.user, "guild_permissions", None)
        if (
            interaction.guild_id != self._view.guild_id
            or not permissions
            or not permissions.administrator
        ):
            await interaction.response.send_message(
                "Only server administrators can override the team tag.",
                ephemeral=True,
            )
            return
        team_tag = self.team_tag_input.value.strip().upper()
        if not team_tag:
            await interaction.response.send_message(
                "Team tag cannot be empty.",
                ephemeral=True,
            )
            return
        profile = db.update_pending_roster_team_tag(
            self._view.guild_id,
            self._view.discord_user_id,
            team_tag,
        )
        if not profile:
            await interaction.response.send_message(
                "This roster submission is no longer pending review.",
                ephemeral=True,
            )
            return
        await interaction.response.defer(ephemeral=True)
        await self._message.edit(
            embed=_build_roster_pending_embed(profile),
            view=self._view,
        )
        await interaction.followup.send(
            "Roster team tag updated and remains pending approval.",
            ephemeral=True,
        )


def _build_roster_pending_embed(profile: dict) -> discord.Embed:
    embed = discord.Embed(
        title="Roster registration pending approval",
        color=discord.Color.gold(),
        timestamp=datetime.utcnow(),
    )
    embed.add_field(
        name="Discord identity",
        value=(
            f"ID: `{profile['discord_user_id']}`\n"
            f"Username: `{profile.get('discord_username') or 'Unknown'}`\n"
            f"Mention: <@{profile['discord_user_id']}>"
        ),
        inline=False,
    )
    embed.add_field(
        name="Display name",
        value=profile["discord_display_name"],
        inline=False,
    )
    embed.add_field(name="UID", value=f"`{profile['uid']}`", inline=True)
    embed.add_field(name="IGN", value=profile["ign"], inline=True)
    embed.add_field(
        name="Team",
        value=profile.get("team_tag") or "Not detected",
        inline=True,
    )
    embed.add_field(name="Role", value=profile.get("role", "starter").title(), inline=True)
    if profile.get("manually_edited"):
        embed.set_footer(text="Manually edited • Submission status: pending")
    else:
        embed.set_footer(text=f"Submission status: {profile['status']}")
    return embed


async def _handle_roster_screenshot(
    message: discord.Message,
    attachment: discord.Attachment,
) -> None:
    try:
        raw_bytes = await attachment.read()
        profile = await parse_profile_screenshot_vision(raw_bytes)
    except Exception as exc:
        log.error(
            f"Roster: profile screenshot parsing failed | "
            f"guild={message.guild.id} | file={attachment.filename} | error={exc}"
        )
        await message.channel.send(
            "❌ I couldn't read that profile screenshot. Please try again."
        )
        return

    uid = profile.get("UID", "").strip()
    ign = profile.get("IGN", "").strip()
    if not uid or not ign:
        await message.channel.send(
            "⚠️ I couldn't clearly read the UID or IGN. Please upload a clearer "
            "BGMI profile screenshot showing both."
        )
        return
    if not uid.isdigit():
        await message.channel.send(
            "⚠️ The UID wasn't readable as digits. Please upload a clearer "
            "BGMI profile screenshot."
        )
        return

    discord_user_id = message.author.id
    discord_username = message.author.name
    display_name = getattr(message.author, "display_name", str(message.author))
    try:
        submission = db.submit_roster_profile(
            guild_id=message.guild.id,
            discord_user_id=discord_user_id,
            discord_username=discord_username,
            discord_display_name=display_name,
            uid=uid,
            ign=ign,
            team_tag=extract_team_tag(ign),
        )
    except Exception as exc:
        log.error(
            f"Roster: could not save submission | "
            f"guild={message.guild.id} | user={discord_user_id} | error={exc}"
        )
        await message.channel.send(
            "❌ I couldn't save this roster submission. Please try again later."
        )
        return

    embed = _build_roster_pending_embed(submission)
    await message.channel.send(
        embed=embed,
        view=RosterApprovalView(
            message.guild.id,
            discord_user_id,
            submission["role"],
        ),
    )


# ═════════════════════════════════════════════════════════════════════════
# IDP HANDLER
# ═════════════════════════════════════════════════════════════════════════

async def _handle_idp(
    message: discord.Message,
    idp: dict,
    guild_name: str,
    channel_name: str,
) -> None:
    room_id  = idp["id"]
    password = idp["password"]
    conf     = idp.get("confidence", "?")
    author   = str(message.author)
    url      = message.jump_url

    summary = (
        f"[{guild_name}] #{channel_name} | "
        f"ID={room_id} PASS={password} [{conf}]"
    )
    log.info(f"IDP detected: {summary}")
    state.record_detection(summary)

    # Persist to IDP history log
    db.log_idp(
        guild_id=message.guild.id,
        channel_id=message.channel.id,
        guild_name=guild_name,
        channel_name=channel_name,
        author=author,
        room_id=room_id,
        password=password,
        message_url=url,
    )

    # ── Discord reply ──────────────────────────────────────────────────────
    conf_emoji = "🟢" if conf == "high" else "🟡"
    embed = discord.Embed(
        title="🚨 SCRIM IDP DETECTED",
        color=discord.Color.red(),
        timestamp=datetime.utcnow(),
    )
    embed.add_field(name="🆔 Room ID",  value=f"`{room_id}`",  inline=True)
    embed.add_field(name="🔑 Password", value=f"`{password}`", inline=True)
    embed.add_field(name="📊 Confidence", value=f"{conf_emoji} {conf}", inline=True)
    embed.add_field(name="👤 Detected from", value=author, inline=False)
    embed.set_footer(text=f"{guild_name} • #{channel_name}")
    await message.channel.send(embed=embed)

    # ── WhatsApp alert (enqueued — non-blocking) ───────────────────────────
    alert_text = whatsapp.build_idp_alert(
        guild_name=guild_name,
        channel_name=channel_name,
        author=author,
        room_id=room_id,
        password=password,
        message_url=url,
    )
    queued = await whatsapp.enqueue(alert_text)
    if not queued:
        log.error("WhatsApp queue full — IDP alert not dispatched.")


# ═════════════════════════════════════════════════════════════════════════
# SLOT PROCESSING
# ═════════════════════════════════════════════════════════════════════════

def _process_slot_message(
    content: str,
    guild_id: int,
    gs,  # GuildState
) -> bool:
    """
    Parse slot assignments from a message.
    Returns True if any slots were updated.
    """
    updated = False
    for line in content.splitlines():
        m = _SLOT_PATTERN.search(line)
        if not m:
            continue

        slot_num     = m.group(1).zfill(2)
        raw_team     = m.group(2).strip()
        team_norm, team_display = normalize(raw_team)

        if not team_norm:
            continue

        gs.register_slot(slot_num, team_norm, team_display)
        log.info(f"[{guild_id}] Slot {slot_num} → {team_display}")
        updated = True

    return updated


# ═════════════════════════════════════════════════════════════════════════
# ADMIN COMMANDS
# ═════════════════════════════════════════════════════════════════════════

@bot.command(name="setidchannel")
@commands.has_permissions(administrator=True)
@commands.guild_only()
async def cmd_set_id_channel(ctx: commands.Context) -> None:
    """Designate this channel for IDP (Room ID + Password) detection."""
    gs = guild_manager.get(ctx.guild.id)
    gs.add_idp_channel(ctx.channel.id)
    await ctx.send(
        f"✅ `#{ctx.channel.name}` is now an **IDP detection channel**.\n"
        f"The bot will scan this channel for Room ID + Password messages."
    )


@bot.command(name="unsetidchannel")
@commands.has_permissions(administrator=True)
@commands.guild_only()
async def cmd_unset_id_channel(ctx: commands.Context) -> None:
    """Remove this channel from IDP detection."""
    gs = guild_manager.get(ctx.guild.id)
    gs.remove_idp_channel(ctx.channel.id)
    await ctx.send(f"✅ `#{ctx.channel.name}` removed from IDP detection.")


@bot.command(name="setregchannel")
@commands.has_permissions(administrator=True)
@commands.guild_only()
async def cmd_set_reg_channel(ctx: commands.Context) -> None:
    """Designate this channel for slot registration tracking."""
    gs = guild_manager.get(ctx.guild.id)
    gs.add_reg_channel(ctx.channel.id)
    await ctx.send(f"✅ `#{ctx.channel.name}` is now a **registration channel**.")


@bot.command(name="unsetregchannel")
@commands.has_permissions(administrator=True)
@commands.guild_only()
async def cmd_unset_reg_channel(ctx: commands.Context) -> None:
    """Remove this channel from registration tracking."""
    gs = guild_manager.get(ctx.guild.id)
    gs.remove_reg_channel(ctx.channel.id)
    await ctx.send(f"✅ `#{ctx.channel.name}` removed from registration tracking.")


@bot.command(name="setrosterchannel")
@commands.has_permissions(administrator=True)
@commands.guild_only()
async def cmd_set_roster_channel(ctx: commands.Context) -> None:
    """Designate this channel for player profile screenshot registration."""
    gs = guild_manager.get(ctx.guild.id)
    gs.add_roster_channel(ctx.channel.id)
    await ctx.send(
        f"✅ `#{ctx.channel.name}` is now a **roster registration channel**."
    )


@bot.command(name="unsetrosterchannel")
@commands.has_permissions(administrator=True)
@commands.guild_only()
async def cmd_unset_roster_channel(ctx: commands.Context) -> None:
    """Remove this channel from roster registration."""
    gs = guild_manager.get(ctx.guild.id)
    gs.remove_roster_channel(ctx.channel.id)
    await ctx.send(f"✅ `#{ctx.channel.name}` removed from roster registration.")


def _match_roster_target(target: str, profiles: list[dict]) -> list[dict]:
    target = target.strip()
    if not target:
        return []
    mention = re.fullmatch(r"<@!?(\d+)>", target)
    if mention:
        user_id = int(mention.group(1))
        return [
            profile for profile in profiles
            if profile["discord_user_id"] == user_id
        ]

    if target.isdigit():
        value = int(target)
        return [
            profile for profile in profiles
            if profile["discord_user_id"] == value
            or target in {
                str(profile.get("uid") or ""),
                str(profile.get("approved_uid") or ""),
            }
        ]

    folded_target = target.casefold()
    return [
        profile for profile in profiles
        if any(
            folded_target in str(name or "").casefold()
            for name in (profile.get("ign"), profile.get("approved_ign"))
        )
    ]


def _roster_removal_details(profile: dict) -> dict:
    details = dict(profile)
    has_approved = bool(profile.get("approved_uid"))
    details["_display_ign"] = (
        profile["approved_ign"] if has_approved else profile["ign"]
    )
    details["_display_uid"] = (
        profile["approved_uid"] if has_approved else profile["uid"]
    )
    details["_display_team_tag"] = (
        profile.get("approved_team_tag") if has_approved
        else profile.get("team_tag")
    ) or "Unassigned"
    details["_display_role"] = (
        profile.get("approved_role") if has_approved
        else profile.get("role")
    ) or "starter"
    return details


@bot.command(name="removeplayer")
@commands.has_permissions(administrator=True)
@commands.guild_only()
async def cmd_remove_roster_player(
    ctx: commands.Context,
    *,
    target: str,
) -> None:
    """Remove a roster profile after administrator confirmation."""
    permissions = getattr(ctx.author, "guild_permissions", None)
    if not permissions or not permissions.administrator:
        await ctx.send("Only server administrators can remove roster players.")
        return

    matches = _match_roster_target(
        target,
        db.get_roster_profiles(ctx.guild.id),
    )
    if not matches:
        await ctx.send(f"No roster player matched `{target.strip()}`.")
        return
    if len(matches) > 1:
        lines = [
            f"{index}. {profile.get('approved_ign') or profile['ign']} "
            f"(`{profile.get('approved_uid') or profile['uid']}`) "
            f"<@{profile['discord_user_id']}>"
            for index, profile in enumerate(matches[:10], start=1)
        ]
        remaining = len(matches) - len(lines)
        if remaining:
            lines.append(f"…and {remaining} more.")
        await ctx.send(
            "Several roster players match. Please be more specific:\n"
            + "\n".join(lines)
        )
        return

    profile = _roster_removal_details(matches[0])
    embed = discord.Embed(
        title="Confirm roster player removal",
        description="This removes the roster profile, including any pending re-submission. Match stats will be kept.",
        color=discord.Color.orange(),
    )
    embed.add_field(name="IGN", value=profile["_display_ign"], inline=True)
    embed.add_field(name="UID", value=f"`{profile['_display_uid']}`", inline=True)
    embed.add_field(
        name="Team tag",
        value=profile["_display_team_tag"],
        inline=True,
    )
    embed.add_field(
        name="Role",
        value=profile["_display_role"].title(),
        inline=True,
    )
    view = RemoveRosterPlayerView(
        ctx.guild.id,
        ctx.author.id,
        profile,
    )
    view.message = await ctx.send(embed=embed, view=view)


@bot.command(name="roster")
@commands.guild_only()
async def cmd_roster(ctx: commands.Context) -> None:
    """List approved roster players grouped by team."""
    players = db.get_approved_roster_profiles(ctx.guild.id)
    if not players:
        await ctx.send("No approved players are on the roster yet.")
        return

    teams: dict[str, dict[str, list[dict]]] = {}
    for player in players:
        team_tag = (player["team_tag"] or "Unassigned").strip().upper()
        teams.setdefault(team_tag, {"starter": [], "substitute": []})
        role = player["role"] if player["role"] in {"starter", "substitute"} else "starter"
        teams[team_tag][role].append(player)

    chunks: list[str] = []
    current = ""
    for team_tag, roles in teams.items():
        lines = [f"**{team_tag}**"]
        for role, label in (("starter", "Starters"), ("substitute", "Substitutes")):
            if roles[role]:
                lines.append(f"_{label}_")
                lines.extend(
                    f"• {player['ign']} — `{player['uid']}`"
                    for player in roles[role]
                )
        for line in lines:
            addition = f"\n{line}" if current else line
            if current and len(current) + len(addition) > 1900:
                chunks.append(current)
                current = line
            else:
                current += addition
    if current:
        chunks.append(current)

    for chunk in chunks:
        await ctx.send(chunk)


@bot.command(name="showchannels")
@commands.has_permissions(administrator=True)
@commands.guild_only()
async def cmd_show_channels(ctx: commands.Context) -> None:
    """Show configured IDP, registration, and roster channels for this server."""
    gs = guild_manager.get(ctx.guild.id)

    def fmt_channels(ch_ids: set[int]) -> str:
        if not ch_ids:
            return "_None configured_"
        return ", ".join(f"<#{cid}>" for cid in ch_ids)

    embed = discord.Embed(title="⚙️ Channel Configuration", color=discord.Color.blurple())
    embed.add_field(
        name="🔍 IDP Channels",
        value=fmt_channels(gs.idp_channels) + (
            "\n_Scanning ALL channels (no filter)_" if not gs.idp_channels else ""
        ),
        inline=False,
    )
    embed.add_field(
        name="📋 Registration Channels",
        value=fmt_channels(gs.reg_channels),
        inline=False,
    )
    embed.add_field(
        name="👤 Roster Registration Channels",
        value=fmt_channels(gs.roster_channels),
        inline=False,
    )
    await ctx.send(embed=embed)


# ═════════════════════════════════════════════════════════════════════════
# SLOT COMMANDS
# ═════════════════════════════════════════════════════════════════════════

@bot.command(name="slots")
@commands.guild_only()
async def cmd_slots(ctx: commands.Context) -> None:
    """Show all registered slots for this server."""
    gs = guild_manager.get(ctx.guild.id)
    embed = discord.Embed(
        title="📋 SLOT LIST",
        description=gs.format_slots(),
        color=discord.Color.blue(),
    )
    embed.set_footer(text=f"{len(gs.slots)} slot(s) registered")
    await ctx.send(embed=embed)


@bot.command(name="team")
@commands.guild_only()
async def cmd_team(ctx: commands.Context, *, name: str) -> None:
    """Find which slot a team is in. Usage: !team <team name>"""
    gs = guild_manager.get(ctx.guild.id)
    team_norm, _ = normalize(name)
    if team_norm in gs.team_index:
        slot = gs.team_index[team_norm]
        await ctx.send(f"✅ **{name}** is registered in Slot `{slot}`")
    else:
        await ctx.send(f"❌ Team **{name}** not found in the slot list.")


@bot.command(name="clearslots")
@commands.has_permissions(administrator=True)
@commands.guild_only()
async def cmd_clearslots(ctx: commands.Context) -> None:
    """Clear all registered slots for this server."""
    gs = guild_manager.get(ctx.guild.id)
    count = gs.clear_all_slots()
    await ctx.send(f"🗑️ Cleared **{count}** slot(s).")


# ═════════════════════════════════════════════════════════════════════════
# STATUS COMMAND
# ═════════════════════════════════════════════════════════════════════════

@bot.command(name="status")
@commands.has_permissions(administrator=True)
async def cmd_status(ctx: commands.Context) -> None:
    """Show bot runtime status and statistics."""
    s = state
    embed = discord.Embed(
        title="📊 Bot Status",
        color=discord.Color.green() if s.running else discord.Color.red(),
        timestamp=datetime.utcnow(),
    )
    embed.add_field(name="🟢 Running",       value=str(s.running),              inline=True)
    embed.add_field(name="🌐 Servers",       value=str(s.server_count),         inline=True)
    embed.add_field(name="🔎 Detections",    value=str(s.detection_count),      inline=True)
    embed.add_field(name="📤 Alerts sent",   value=str(s.alert_count),          inline=True)
    embed.add_field(name="❌ Alert failures",value=str(s.alert_failed_count),   inline=True)
    embed.add_field(name="⏭️ Duplicates",    value=str(s.duplicate_skipped_count), inline=True)
    embed.add_field(name="📬 WA Queue depth",value=str(s.wa_queue_depth),       inline=True)
    embed.add_field(name="💥 Crashes",       value=str(s.crash_count),          inline=True)
    embed.add_field(name="📌 Last IDP",      value=s.last_detected_scrim,       inline=False)
    await ctx.send(embed=embed)


@bot.command(name="idphistory")
@commands.has_permissions(administrator=True)
@commands.guild_only()
async def cmd_idp_history(ctx: commands.Context) -> None:
    """Show the last 10 IDP detections in the last 24 hours."""
    records = db.recent_idp_history(hours=24)
    guild_records = [r for r in records if r["guild_id"] == ctx.guild.id][:10]

    if not guild_records:
        await ctx.send("📭 No IDP detections in the last 24 hours.")
        return

    lines = []
    for r in guild_records:
        lines.append(
            f"`{r['detected_at'][:16]}` — "
            f"ID `{r['room_id']}` / Pass `{r['password']}` "
            f"by {r['author']}"
        )

    embed = discord.Embed(
        title="📜 IDP History (last 24h)",
        description="\n".join(lines),
        color=discord.Color.gold(),
    )
    await ctx.send(embed=embed)


@bot.command(name="help")
async def cmd_help(ctx: commands.Context) -> None:
    """Show available commands."""
    embed = discord.Embed(
        title="🤖 ScrimBot Commands",
        color=discord.Color.blurple(),
    )
    admin = (
        "`!setidchannel`    — Set this channel for IDP detection\n"
        "`!unsetidchannel`  — Remove this channel from IDP detection\n"
        "`!setregchannel`   — Set this channel for slot registration\n"
        "`!unsetregchannel` — Remove this channel from registration\n"
        "`!setrosterchannel`   — Set this channel for profile screenshot registration\n"
        "`!unsetrosterchannel` — Remove this channel from roster registration\n"
        "`!removeplayer <target>` — Remove a roster player after confirmation\n"
        "`!showchannels`    — Show configured channels\n"
        "`!clearslots`      — Clear all slots for this server\n"
        "`!status`          — Bot runtime status\n"
        "`!idphistory`      — Last 24h IDP detections\n"
    )
    user = (
        "`!slots`           — Show current slot list\n"
        "`!team <name>`     — Find a team's slot\n"
        "`!roster`          — List approved players grouped by team\n"
    )
    embed.add_field(name="🔐 Admin Only", value=admin, inline=False)
    embed.add_field(name="👥 Everyone",   value=user,  inline=False)
    await ctx.send(embed=embed)




# ═════════════════════════════════════════════════════════════════════════
# STATS SCREENSHOT HANDLER
# ═════════════════════════════════════════════════════════════════════════

# ═════════════════════════════════════════════════════════════════════════
# STATS CONFIRM / EDIT UI
# ═════════════════════════════════════════════════════════════════════════

def _build_stats_embed(
    records: list[dict],
    saved: bool = False,
    overflow_count: int = 0,
) -> discord.Embed:
    """Build the stats preview/saved embed from a records list."""
    r0        = records[0]
    placement = r0.get("placement", 0)
    total     = r0.get("total_teams", 0)
    map_name  = r0.get("map_name", "")
    place_str = f"#{placement}/{total}" if placement else "?"

    if saved:
        place_emoji = "✅"
        title = f"{place_emoji} Match Stats Saved — {place_str}"
        color = discord.Color.green()
    else:
        if placement == 1:   place_emoji = "🏆"
        elif placement == 2: place_emoji = "🥈"
        elif placement == 3: place_emoji = "🥉"
        else:                place_emoji = "🎮"
        title = f"{place_emoji} Match Stats — {place_str}  ·  Review before saving"
        color = discord.Color.gold() if placement and placement <= 3 else discord.Color.blurple()

    embed = discord.Embed(title=title, color=color, timestamp=datetime.utcnow())
    footer = f"{map_name} • {len(records)} player(s)"
    if overflow_count:
        footer += f" • {overflow_count} more row(s): upload separately"
    embed.set_footer(text=footer)

    for r in records:
        mvp_tag = " ⭐ MVP" if r.get("is_mvp") else ""
        kills   = r.get("kills") or 0
        assists = r.get("assists") or 0
        damage  = r.get("damage")
        rating  = r.get("rating")
        value   = f"🔫 `{kills}` kills  🤝 `{assists or '—'}` assists"
        if damage:  value += f"  💥 `{damage}` dmg"
        if rating:  value += f"  📈 `{rating}` rtg"
        embed.add_field(name=f"{r['player_name']}{mvp_tag}", value=value, inline=False)

    return embed


def _roster_match_score(name: str, roster_name: str) -> float:
    normalized_name = _normalize_player_ign(name)
    normalized_roster_name = _normalize_player_ign(roster_name)
    if not normalized_name or not normalized_roster_name:
        return 0.0
    return difflib.SequenceMatcher(
        None,
        normalized_name,
        normalized_roster_name,
    ).ratio()


class StatsRosterSelect(discord.ui.Select):
    def __init__(
        self,
        parent_view: "StatsConfirmView",
        record_index: int,
        options: list[discord.SelectOption],
        selected_id: int | None,
    ):
        for option in options:
            option.default = option.value == (
                str(selected_id) if selected_id is not None else "unknown"
            )
        super().__init__(
            placeholder=(
                f"Player {record_index + 1}: "
                f"{parent_view.records[record_index].get('player_name', '')}"
            )[:150],
            min_values=1,
            max_values=1,
            options=options,
            row=record_index,
        )
        self.parent_view = parent_view
        self.record_index = record_index

    async def callback(self, interaction: discord.Interaction) -> None:
        value = self.values[0]
        self.parent_view.assignments[self.record_index] = (
            int(value) if value != "unknown" else None
        )
        self.parent_view.manual_assignments.add(self.record_index)
        self.parent_view._refresh_option_defaults()
        await interaction.response.edit_message(
            content=None,
            embed=_build_stats_embed(
                self.parent_view.records,
                overflow_count=self.parent_view.overflow_count,
            ),
            view=self.parent_view,
        )


class StatsEditModal(discord.ui.Modal, title="✏️ Edit Player Names & Kills"):
    """
    Discord Modal popup — one row per player.
    User types: PlayerName  (just name, OR  PlayerName 3  to also fix kills)
    """

    def __init__(self, records: list[dict], view: "StatsConfirmView"):
        super().__init__(timeout=120)
        self._records = records
        self._parent_view = view

        for i, r in enumerate(records[:4]):
            kills = r.get("kills") or 0
            default = f"{r['player_name']} {kills}"
            self.add_item(discord.ui.TextInput(
                label=f"Player {i+1}  (Name  Kills)",
                default=default,
                placeholder="e.g.  MACxKARAN99 4",
                required=True,
                max_length=60,
            ))

    async def on_submit(self, interaction: discord.Interaction):
        changed_names = set()
        for i, item in enumerate(self.children):
            if i >= len(self._records):
                break
            old_name = self._records[i]["player_name"]
            parts = item.value.strip().rsplit(None, 1)   # split on last whitespace
            if len(parts) == 2 and parts[1].isdigit():
                self._records[i]["player_name"] = parts[0].strip()
                self._records[i]["kills"]        = int(parts[1])
            else:
                self._records[i]["player_name"] = item.value.strip()
            if self._records[i]["player_name"] != old_name:
                changed_names.add(i)

        self._parent_view.records = self._records
        if changed_names:
            self._parent_view._preselect_roster_players()
        embed = _build_stats_embed(
            self._records,
            overflow_count=self._parent_view.overflow_count,
        )
        embed.set_footer(text=embed.footer.text + "  ·  Changes applied — confirm to save")
        self._parent_view._refresh_option_defaults()
        await interaction.response.edit_message(embed=embed, view=self._parent_view)


class StatsConfirmView(discord.ui.View):
    """
    Buttons shown under the stats preview embed.
    ✅ Save  —  saves to DB
    ✏️ Edit  —  opens StatsEditModal
    Unreviewed stats are saved after timeout when assignments are unambiguous.
    """

    def __init__(
        self,
        records:   list[dict],
        img_hash:  str,
        guild_id:  int,
        message:   discord.Message,
        place_str: str,
        map_name:  str,
        roster_profiles: list[dict] | None = None,
        overflow_count: int = 0,
    ):
        super().__init__(timeout=120)
        self.records = records[:4]
        self.img_hash = img_hash
        self.guild_id = guild_id
        self._message = message
        self._place_str = place_str
        self._map_name = map_name
        self.overflow_count = overflow_count
        self._saved = False
        self.roster_profiles = (
            roster_profiles
            if roster_profiles is not None
            else db.get_approved_roster_profiles(guild_id)
        )
        self._roster_options = self._build_roster_options()
        self.assignments: list[int | None] = [None] * len(self.records)
        self.manual_assignments: set[int] = set()
        self._preselect_roster_players()
        self._build_components()

    def _build_roster_options(self) -> list[discord.SelectOption]:
        if not self.roster_profiles:
            return []

        team_scores: dict[str, list[float]] = {}
        for record in self.records:
            candidates = [
                (
                    _roster_match_score(record.get("player_name", ""), profile["ign"]),
                    str(profile.get("team_tag") or "").casefold(),
                )
                for profile in self.roster_profiles
            ]
            if candidates:
                score, team_tag = max(candidates, key=lambda candidate: candidate[0])
                if score >= 0.85 and team_tag:
                    team_scores.setdefault(team_tag, []).append(score)
        preferred_team = max(
            team_scores,
            key=lambda tag: (len(team_scores[tag]), sum(team_scores[tag]), tag),
            default=None,
        )

        ordered_profiles = sorted(
            self.roster_profiles,
            key=lambda profile: (
                0
                if preferred_team
                and str(profile.get("team_tag") or "").casefold() == preferred_team
                else 1,
                (profile.get("ign") or "").casefold(),
                str(profile.get("uid") or ""),
            ),
        )[:24]
        options = [
            discord.SelectOption(
                label="Unknown / not on roster",
                value="unknown",
                description="Do not save this extracted player",
            )
        ]
        for profile in ordered_profiles:
            uid = str(profile.get("uid") or "")
            ign = str(profile.get("ign") or "")
            label = f"{ign[:max(1, 96 - len(uid))]} ({uid})"
            options.append(
                discord.SelectOption(
                    label=label[:100],
                    value=str(profile["id"]),
                    description=(
                        f"{profile.get('team_tag') or 'Unassigned'} · "
                        f"{profile.get('role') or 'starter'}"
                    )[:100],
                )
            )
        return options

    def _preselect_roster_players(self) -> None:
        if not self.roster_profiles:
            return
        available_ids = {
            int(option.value)
            for option in self._roster_options
            if option.value != "unknown"
        }
        reserved = {
            profile_id
            for index, profile_id in enumerate(self.assignments)
            if index in self.manual_assignments and profile_id is not None
        }
        for index in range(len(self.assignments)):
            if index not in self.manual_assignments:
                self.assignments[index] = None

        candidates = []
        for index, record in enumerate(self.records):
            if index in self.manual_assignments:
                continue
            for profile in self.roster_profiles:
                profile_id = int(profile["id"])
                if profile_id not in available_ids:
                    continue
                score = _roster_match_score(
                    record.get("player_name", ""),
                    profile.get("ign", ""),
                )
                if score >= 0.85:
                    candidates.append((score, index, profile_id))

        assigned = set(reserved)
        for _, index, profile_id in sorted(candidates, reverse=True):
            if self.assignments[index] is None and profile_id not in assigned:
                self.assignments[index] = profile_id
                assigned.add(profile_id)

    def _build_components(self) -> None:
        self.clear_items()
        if self.roster_profiles:
            for index in range(len(self.records)):
                self.add_item(
                    StatsRosterSelect(
                        self,
                        index,
                        [
                            discord.SelectOption(
                                label=option.label,
                                value=option.value,
                                description=option.description,
                                default=option.default,
                            )
                            for option in self._roster_options
                        ],
                        self.assignments[index],
                    )
                )
        save_button = discord.ui.Button(
            label="✅ Save",
            style=discord.ButtonStyle.success,
            emoji="✅",
            row=4,
        )
        save_button.callback = self.save_btn
        self.add_item(save_button)
        edit_button = discord.ui.Button(
            label="✏️ Edit Names / Kills",
            style=discord.ButtonStyle.secondary,
            emoji="✏️",
            row=4,
        )
        edit_button.callback = self.edit_btn
        self.add_item(edit_button)

    def _refresh_option_defaults(self) -> None:
        for item in self.children:
            if isinstance(item, StatsRosterSelect):
                selected_id = self.assignments[item.record_index]
                for option in item.options:
                    option.default = option.value == (
                        str(selected_id) if selected_id is not None else "unknown"
                    )

    def _duplicate_assignment(self) -> str | None:
        assigned_ids = [
            profile_id for profile_id in self.assignments if profile_id is not None
        ]
        duplicate_ids = {
            profile_id for profile_id in assigned_ids
            if assigned_ids.count(profile_id) > 1
        }
        if not duplicate_ids:
            return None
        duplicate_id = next(iter(duplicate_ids))
        profile = next(
            profile for profile in self.roster_profiles
            if int(profile["id"]) == duplicate_id
        )
        return f"{profile['ign']} ({profile['uid']})"

    async def _do_save(self, interaction: discord.Interaction | None):
        if self._saved:
            return
        duplicate = self._duplicate_assignment()
        if duplicate:
            message = (
                f"{duplicate} is assigned to more than one row. "
                "Choose a different player before saving."
            )
            if interaction:
                await interaction.response.edit_message(
                    content=message,
                    embed=_build_stats_embed(
                        self.records,
                        overflow_count=self.overflow_count,
                    ),
                    view=self,
                )
            else:
                log.warning(f"Stats auto-save blocked by duplicate roster assignment: {duplicate}")
                try:
                    await self._bot_msg.edit(content=message, view=None)
                except discord.HTTPException as exc:
                    log.warning(f"Could not report duplicate stats assignment: {exc}")
            return

        self.stop()

        try:
            if self.roster_profiles:
                roster_by_id = {
                    int(profile["id"]): profile for profile in self.roster_profiles
                }
                eligible_records = []
                for index, record in enumerate(self.records):
                    profile_id = self.assignments[index]
                    if profile_id is None:
                        continue
                    profile = roster_by_id[profile_id]
                    eligible_records.append(
                        {
                            **record,
                            "player_name": profile["ign"],
                            "roster_profile_id": profile_id,
                            "guild_id": self.guild_id,
                        }
                    )
                skipped_count = (
                    len(self.records) - len(eligible_records) + self.overflow_count
                )
            else:
                eligible_records = [
                    {**record, "roster_profile_id": None}
                    for record in self.records
                ]
                skipped_count = self.overflow_count
            if eligible_records:
                db.save_player_stats(eligible_records)
            db.mark_stats_processed(self.img_hash, self.guild_id)
            self._saved = True
            self.records = eligible_records
            log.info(
                f"Stats: saved {len(eligible_records)} players, "
                f"skipped {skipped_count} rows | "
                f"{self._place_str} {self._map_name} | "
                f"guild={self.guild_id} | hash={self.img_hash[:12]}"
            )
        except Exception as exc:
            log.error(f"Stats: DB save failed: {exc}")
            if interaction:
                await interaction.response.edit_message(
                    content="❌ DB save failed — check logs.", view=None
                )
            else:
                try:
                    await self._bot_msg.edit(
                        content="❌ DB save failed — check logs.",
                        embed=None,
                        view=None,
                    )
                except discord.HTTPException as update_exc:
                    log.warning(f"Could not report stats save failure: {update_exc}")
            return

        content_parts = [
            f"Saved {len(eligible_records)} player(s); skipped {skipped_count} row(s)."
        ]
        if self.overflow_count:
            content_parts.append(
                f"Upload the other {self.overflow_count} player row(s) separately."
            )
        content = " ".join(content_parts)
        embed = (
            _build_stats_embed(self.records, saved=True)
            if self.records
            else None
        )
        if interaction:
            await interaction.response.edit_message(
                content=content,
                embed=embed,
                view=None,
            )
        else:
            try:
                await self._bot_msg.edit(
                    content=content,
                    embed=embed,
                    view=None,
                )
            except discord.HTTPException as exc:
                log.warning(f"Could not update saved stats review card: {exc}")

    async def save_btn(self, interaction: discord.Interaction):
        await self._do_save(interaction)

    async def edit_btn(self, interaction: discord.Interaction):
        modal = StatsEditModal(self.records, self)
        await interaction.response.send_modal(modal)

    async def on_timeout(self):
        """Auto-save if nobody clicks within 2 minutes."""
        log.info(f"Stats confirm timed out — auto-saving | hash={self.img_hash[:12]}")
        await self._do_save(interaction=None)


async def _handle_stats_screenshot(
    message: discord.Message,
    attachment: discord.Attachment,
    guild_id: int,
) -> None:
    """
    Download a Discord image, run OCR in thread pool, parse BGMI stats,
    save to DB, and reply with a summary embed.
    OCR runs in executor so the event loop is never blocked.
    """
    import aiohttp

    bot_member = message.guild.me if message.guild else None

    def _safe_remove_reaction(emoji: str) -> None:
        async def inner():
            if bot_member:
                try:
                    await message.remove_reaction(emoji, bot_member)
                except discord.HTTPException:
                    pass
        return inner()

    # ── Download ───────────────────────────────────────────────────────
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(attachment.url) as resp:
                resp.raise_for_status()
                raw_bytes = await resp.read()
    except Exception as exc:
        log.error(f"Stats: download failed | file={attachment.filename} | error={exc}")
        return

    log.info(
        f"Stats screenshot received | guild={guild_id} | "
        f"file={attachment.filename} | bytes={len(raw_bytes)}"
    )

    # ── Dedup ──────────────────────────────────────────────────────────
    img_hash = hash_image(raw_bytes)
    log.info(f"Stats hash={img_hash[:12]} | file={attachment.filename}")

    if db.is_stats_duplicate(img_hash, guild_id):

        log.info(
            f"Stats skipped as duplicate | guild={guild_id} | "
            f"hash={img_hash[:12]} | file={attachment.filename}"
        )
        try:
            await message.add_reaction("♻️")
        except discord.HTTPException:
            pass
        return

    try:
        await message.add_reaction("🔍")
    except discord.HTTPException:
        pass

    # ── OCR in thread pool ─────────────────────────────────────────────
    loop = asyncio.get_running_loop()
    try:
        def _ocr_job():
            prepared = preprocess(raw_bytes)
            return ocr_service.read(prepared.full)

       
    except Exception as exc:
        log.error(f"Stats: OCR failed | file={attachment.filename} | error={exc}")
        await _safe_remove_reaction("🔍")
        try:
            await message.add_reaction("❌")
        except discord.HTTPException:
            pass
        return

    # ── Parse ──────────────────────────────────────────────────────────
    try:
        records = await parse_screenshot(raw_bytes, img_hash, guild_id,"")
        log.info(f"Stats parse result | records={len(records)} | file={attachment.filename}")
    except Exception as exc:
        log.error(f"Stats: parse failed | file={attachment.filename} | error={exc}")
        records = []

    if records and records[0].get("screenshot_type") == "victory_lobby":
        await _safe_remove_reaction("🔍")
        try:
            await message.add_reaction("ℹ️")
        except discord.HTTPException:
            pass
        log.info(
            "Stats: victory lobby screen detected, no detailed stats available — "
            "please upload the stats/scoreboard screen instead"
        )
        await message.channel.send(
            "ℹ️ Victory lobby screen detected, but detailed player stats are not "
            "available on this screen. Please upload the stats/scoreboard screen instead."
        )
        return

    if not records:
        await _safe_remove_reaction("🔍")
        try:
            await message.add_reaction("❓")
        except discord.HTTPException:
            pass
        log.warning(
            f"Stats: no records parsed | guild={guild_id} | "
            f"hash={img_hash[:12]} | file={attachment.filename}"
        )
        return

    overflow_count = max(0, len(records) - 4)
    records = records[:4]
    try:
        roster_profiles = db.get_approved_roster_profiles(guild_id)
    except Exception as exc:
        log.error(f"Stats: could not load approved roster | guild={guild_id} | error={exc}")
        await message.channel.send(
            "❌ Could not load the approved roster for review. Please try this screenshot again."
        )
        return

    # ── Build preview embed + confirm view (do NOT save yet) ──────────
    r0        = records[0]
    placement = r0.get("placement", 0)
    total     = r0.get("total_teams", 0)
    map_name  = r0.get("map_name", "")
    place_str = f"#{placement}/{total}" if placement else "?"

    view = StatsConfirmView(
        records=records, img_hash=img_hash, guild_id=guild_id,
        message=message, place_str=place_str, map_name=map_name,
        roster_profiles=roster_profiles,
        overflow_count=overflow_count,
    )
    embed = _build_stats_embed(records, overflow_count=overflow_count)

    await _safe_remove_reaction("🔍")
    try:
        await message.add_reaction("👀")
    except discord.HTTPException:
        pass

    bot_msg = await message.channel.send(embed=embed, view=view)
    view._bot_msg = bot_msg   # needed for timeout auto-save edit


# ═════════════════════════════════════════════════════════════════════════
# STATS CHANNEL COMMANDS  (admin)
# ═════════════════════════════════════════════════════════════════════════

@bot.command(name="setstatschannel")
@commands.has_permissions(administrator=True)
@commands.guild_only()
async def cmd_set_stats_channel(ctx: commands.Context) -> None:
    """Designate this channel for match screenshot stats tracking."""
    gs = guild_manager.get(ctx.guild.id)
    gs.add_stats_channel(ctx.channel.id)
    await ctx.send(
        f"📊 `#{ctx.channel.name}` is now a **stats channel**.\n"
        f"Share BGMI match screenshots here — bot will auto-track player stats."
    )


@bot.command(name="unsetstatschannel")
@commands.has_permissions(administrator=True)
@commands.guild_only()
async def cmd_unset_stats_channel(ctx: commands.Context) -> None:
    """Remove this channel from stats tracking."""
    gs = guild_manager.get(ctx.guild.id)
    gs.remove_stats_channel(ctx.channel.id)
    await ctx.send(f"✅ `#{ctx.channel.name}` removed from stats tracking.")


# ═════════════════════════════════════════════════════════════════════════
# STATS QUERY COMMANDS  (everyone)
# ═════════════════════════════════════════════════════════════════════════

@bot.command(name="topstats")
@commands.guild_only()
async def cmd_top_stats(ctx: commands.Context, days: int = 7) -> None:
    """Show kill leaderboard. Usage: !topstats [days]"""
    days = max(1, min(days, 30))
    rows = db.get_player_leaderboard(ctx.guild.id, days=days)
    if not rows:
        await ctx.send(
            f"📊 No stats in the last {days} day(s).\n"
            "_Use `!setstatschannel` then share match screenshots._"
        )
        return

    embed = discord.Embed(
        title=f"🏆 Kill Leaderboard — Last {days} Day(s)",
        color=discord.Color.gold(),
        timestamp=datetime.utcnow(),
    )
    medals = ["🥇", "🥈", "🥉"]
    for i, r in enumerate(rows[:10]):
        medal   = medals[i] if i < 3 else f"`#{i+1}`"
        mvp_tag = f" ⭐×{r['mvp_count']}" if r["mvp_count"] else ""
        embed.add_field(
            name=f"{medal} {r['player_name']}{mvp_tag}",
            value=(
                f"🔫 `{r['total_kills']}` kills  (avg `{r['avg_kills']}/match`)\n"
                f"💥 `{r['total_damage']}` dmg  🎮 `{r['matches']}` matches  "
                f"🏆 Best `#{r['best_placement']}`"
            ),
            inline=False,
        )
    embed.set_footer(text=f"{len(rows)} player(s) tracked")
    await ctx.send(embed=embed)


@bot.command(name="mystats")
@commands.guild_only()
async def cmd_my_stats(ctx: commands.Context, *, player_name: str = "") -> None:
    """Show stats for a player. Usage: !mystats [player_name]"""
    name = player_name.strip() or str(ctx.author.display_name)
    rows = db.get_player_leaderboard(ctx.guild.id, days=30)
    player = next(
        (r for r in rows if r["player_name"].lower() == name.lower()), None
    )
    if not player:
        await ctx.send(f"❌ No stats found for `{name}` in the last 30 days.")
        return

    embed = discord.Embed(
        title=f"📊 Stats — {player['player_name']}",
        color=discord.Color.blurple(),
        timestamp=datetime.utcnow(),
    )
    embed.add_field(name="🔫 Total Kills",    value=f"`{player['total_kills']}`",            inline=True)
    embed.add_field(name="💥 Total Damage",   value=f"`{player['total_damage']}`",           inline=True)
    embed.add_field(name="🎮 Matches",        value=f"`{player['matches']}`",                inline=True)
    embed.add_field(name="📊 Avg Kills",      value=f"`{player['avg_kills']}/match`",        inline=True)
    embed.add_field(name="📊 Avg Damage",     value=f"`{player['avg_damage']}/match`",       inline=True)
    embed.add_field(name="🏆 Best Placement", value=f"`#{player['best_placement']}`",        inline=True)
    if player["avg_rating"]:
        embed.add_field(name="📈 Avg Rating", value=f"`{player['avg_rating']}`",             inline=True)
    if player["mvp_count"]:
        embed.add_field(name="⭐ MVP Count",  value=f"`{player['mvp_count']}x`",             inline=True)
    await ctx.send(embed=embed)

# ═════════════════════════════════════════════════════════════════════════
# RUNNER
# ═════════════════════════════════════════════════════════════════════════

async def run_bot() -> None:
    token = config.DISCORD_TOKEN
    if not token:
        log.error("DISCORD_BOT_TOKEN not set — bot will not start.")
        state.monitoring_status = "Token Missing"
        return

    try:
        log.info("Starting Discord bot …")
        await bot.start(token)
    except discord.LoginFailure:
        log.error("Invalid Discord token — cannot log in.")
        state.record_crash()
    except asyncio.CancelledError:
        log.info("Bot task cancelled — shutting down cleanly.")
        await bot.close()
    except Exception as exc:
        log.exception(f"Bot crashed: {exc}")
        state.record_crash()
    finally:
        await whatsapp.stop_worker()
        if not bot.is_closed():
            await bot.close()
        state.mark_stopped()
        log.info("Discord bot stopped.")