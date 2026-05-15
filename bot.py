"""
Discord bot — listens for scrim keywords across monitored guilds,
updates shared state, and fires WhatsApp alerts.
"""

import asyncio
import os

import discord
from discord.ext import commands

import config
from state import state
from services.whatsapp import send_alert, build_scrim_alert
from utils.logger import get_logger

log = get_logger("discord_bot")

# ── Intents ──────────────────────────────────────────────────────────────────
intents = discord.Intents.default()
intents.message_content = True   # required for reading message text
intents.guilds = True

bot = commands.Bot(command_prefix="!", intents=intents, help_command=None)


# ── Lifecycle ────────────────────────────────────────────────────────────────

@bot.event
async def on_ready():
    guild_count = len(bot.guilds)
    log.info(f"Bot ready | user={bot.user} | guilds={guild_count}")
    state.mark_started(pid=os.getpid(), server_count=guild_count)


@bot.event
async def on_disconnect():
    log.warning("Bot disconnected from Discord")
    state.mark_stopped()


@bot.event
async def on_error(event, *args, **kwargs):
    log.exception(f"Unhandled Discord event error in '{event}'")
    state.record_crash()


# ── Guild join / leave ────────────────────────────────────────────────────────

@bot.event
async def on_guild_join(guild: discord.Guild):
    state.server_count = len(bot.guilds)
    log.info(f"Joined guild: {guild.name} ({guild.id})")


@bot.event
async def on_guild_remove(guild: discord.Guild):
    state.server_count = len(bot.guilds)
    log.info(f"Left guild: {guild.name} ({guild.id})")


# ── Core: message monitoring ──────────────────────────────────────────────────

@bot.event
async def on_message(message: discord.Message):
    # Ignore own messages
    if message.author == bot.user:
        return

    # If guild filter is configured, skip non-monitored guilds
    if (
        config.MONITORED_GUILD_IDS
        and message.guild
        and message.guild.id not in config.MONITORED_GUILD_IDS
    ):
        return

    # Only scan when monitoring is active
    if not state.running:
        return

    content_lower = message.content.lower()

    for keyword in config.SCRIM_KEYWORDS:
        if keyword in content_lower:
            await _handle_detection(message, keyword)
            break   # one alert per message

    await bot.process_commands(message)


async def _handle_detection(message: discord.Message, keyword: str) -> None:
    guild_name   = message.guild.name if message.guild else "DM"
    channel_name = getattr(message.channel, "name", "unknown")
    author       = str(message.author)
    url          = message.jump_url if message.guild else None

    summary = f"[{guild_name}] #{channel_name} | {author} | kw={keyword}"
    log.info(f"Scrim detected: {summary}")

    # Update shared state
    state.record_detection(summary)

    # Build and send WhatsApp alert
    alert_text = build_scrim_alert(
        guild_name=guild_name,
        channel_name=channel_name,
        author=author,
        keyword=keyword,
        message_content=message.content,
        message_url=url,
    )

    sent = await send_alert(alert_text)
    if sent:
        state.record_alert_sent()
        log.info(f"Alert sent to {sent} recipient(s)")


# ── Commands ──────────────────────────────────────────────────────────────────

@bot.command(name="status")
@commands.has_permissions(administrator=True)
async def cmd_status(ctx: commands.Context):
    """Admin command: show bot monitoring status."""
    embed = discord.Embed(title="Monitoring Status", color=discord.Color.green() if state.running else discord.Color.red())
    embed.add_field(name="Running",      value=str(state.running),            inline=True)
    embed.add_field(name="Servers",      value=str(state.server_count),       inline=True)
    embed.add_field(name="Detections",   value=str(state.detection_count),    inline=True)
    embed.add_field(name="Alerts sent",  value=str(state.alert_count),        inline=True)
    embed.add_field(name="Last scrim",   value=state.last_detected_scrim,     inline=False)
    await ctx.send(embed=embed)


# ── Runner ────────────────────────────────────────────────────────────────────

async def run_bot() -> None:
    """Start the Discord bot. Designed to run as a coroutine alongside FastAPI."""
    token = config.DISCORD_TOKEN
    if not token:
        log.error("DISCORD_TOKEN not set — bot will not start.")
        state.monitoring_status = "Token Missing"
        return

    try:
        log.info("Starting Discord bot …")
        await bot.start(token)
    except discord.LoginFailure:
        log.error("Invalid DISCORD_TOKEN — bot cannot log in.")
        state.record_crash()
    except asyncio.CancelledError:
        log.info("Bot task cancelled, shutting down …")
        await bot.close()
    except Exception as exc:
        log.exception(f"Bot crashed: {exc}")
        state.record_crash()
    finally:
        if not bot.is_closed():
            await bot.close()
        state.mark_stopped()
        log.info("Discord bot stopped.")