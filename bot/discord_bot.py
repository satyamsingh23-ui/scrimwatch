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
import os
import re
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
from services.ocr_service import ocr_service
from services.vision_parser import parse_screenshot_vision as parse_screenshot

log = get_logger("discord_bot")

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

    state.mark_started(pid=os.getpid(), server_count=guild_count)

    # Start background workers
    await whatsapp.start_worker()
    _daily_prune.start()

    log.info("All systems up. Monitoring active.")


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


@bot.command(name="showchannels")
@commands.has_permissions(administrator=True)
@commands.guild_only()
async def cmd_show_channels(ctx: commands.Context) -> None:
    """Show configured IDP and registration channels for this server."""
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
        "`!showchannels`    — Show configured channels\n"
        "`!clearslots`      — Clear all slots for this server\n"
        "`!status`          — Bot runtime status\n"
        "`!idphistory`      — Last 24h IDP detections\n"
    )
    user = (
        "`!slots`           — Show current slot list\n"
        "`!team <name>`     — Find a team's slot\n"
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

def _build_stats_embed(records: list[dict], saved: bool = False) -> discord.Embed:
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
    embed.set_footer(text=f"{map_name} • {len(records)} player(s)")

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
        for i, item in enumerate(self.children):
            if i >= len(self._records):
                break
            parts = item.value.strip().rsplit(None, 1)   # split on last whitespace
            if len(parts) == 2 and parts[1].isdigit():
                self._records[i]["player_name"] = parts[0].strip()
                self._records[i]["kills"]        = int(parts[1])
            else:
                self._records[i]["player_name"] = item.value.strip()

        # Refresh the parent view with updated records
        self._parent_view.records = self._records
        embed = _build_stats_embed(self._records)
        embed.set_footer(text=embed.footer.text + "  ·  Changes applied — confirm to save")
        await interaction.response.edit_message(embed=embed, view=self._parent_view)


class StatsConfirmView(discord.ui.View):
    """
    Buttons shown under the stats preview embed.
    ✅ Save  —  saves to DB
    ✏️ Edit  —  opens StatsEditModal
    Auto-saves after timeout so a missed review never blocks the record.
    """

    def __init__(
        self,
        records:   list[dict],
        img_hash:  str,
        guild_id:  int,
        message:   discord.Message,
        place_str: str,
        map_name:  str,
    ):
        super().__init__(timeout=120)   # 2 min window
        self.records   = records
        self.img_hash  = img_hash
        self.guild_id  = guild_id
        self._message  = message
        self._place_str = place_str
        self._map_name  = map_name
        self._saved     = False

    async def _do_save(self, interaction: discord.Interaction | None):
        if self._saved:
            return
        self._saved = True
        self.stop()

        try:
            db.save_player_stats(self.records)
            db.mark_stats_processed(self.img_hash, self.guild_id)
            log.info(
                f"Stats: saved {len(self.records)} players | "
                f"{self._place_str} {self._map_name} | "
                f"guild={self.guild_id} | hash={self.img_hash[:12]}"
            )
        except Exception as exc:
            log.error(f"Stats: DB save failed: {exc}")
            if interaction:
                await interaction.response.edit_message(
                    content="❌ DB save failed — check logs.", view=None
                )
            return

        embed = _build_stats_embed(self.records, saved=True)
        if interaction:
            await interaction.response.edit_message(embed=embed, view=None)
        else:
            # Timeout auto-save — edit the existing bot message
            try:
                await self._bot_msg.edit(embed=embed, view=None)
            except Exception:
                pass

    @discord.ui.button(label="✅ Save", style=discord.ButtonStyle.success, emoji="✅")
    async def save_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._do_save(interaction)

    @discord.ui.button(label="✏️ Edit Names / Kills", style=discord.ButtonStyle.secondary, emoji="✏️")
    async def edit_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
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

    # ── Build preview embed + confirm view (do NOT save yet) ──────────
    r0        = records[0]
    placement = r0.get("placement", 0)
    total     = r0.get("total_teams", 0)
    map_name  = r0.get("map_name", "")
    place_str = f"#{placement}/{total}" if placement else "?"

    view = StatsConfirmView(
        records=records, img_hash=img_hash, guild_id=guild_id,
        message=message, place_str=place_str, map_name=map_name,
    )
    embed = _build_stats_embed(records)

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