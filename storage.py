import json
import logging
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


@dataclass
class GuildConfig:
    guild_id: int
    monitoring_enabled: bool = True
    enabled_channels: list[int] = field(default_factory=list)
    alert_role_id: int | None = None


class JsonStorage:
    def __init__(self, base_dir: Path) -> None:
        self.base_dir = base_dir
        self.config_path = base_dir / "guild_configs.json"
        self.log_path = base_dir / "detection_logs.jsonl"
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self._configs = self._load_configs()

    def _load_configs(self) -> dict[int, GuildConfig]:
        if not self.config_path.exists():
            self.config_path.write_text("{}\n", encoding="utf-8")
            return {}

        try:
            raw_data = json.loads(self.config_path.read_text(encoding="utf-8"))
            configs: dict[int, GuildConfig] = {}
            for guild_id, payload in raw_data.items():
                configs[int(guild_id)] = GuildConfig(
                    guild_id=int(guild_id),
                    monitoring_enabled=bool(payload.get("monitoring_enabled", True)),
                    enabled_channels=[int(channel_id) for channel_id in payload.get("enabled_channels", [])],
                    alert_role_id=int(payload["alert_role_id"]) if payload.get("alert_role_id") else None,
                )
            logging.info("Loaded %s guild configuration(s).", len(configs))
            return configs
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            logging.error("Failed to load guild configs: %s", exc)
            return {}

    def _save_configs(self) -> None:
        payload = {
            str(guild_id): asdict(config)
            for guild_id, config in sorted(self._configs.items())
        }
        self.config_path.write_text(
            f"{json.dumps(payload, indent=2)}\n",
            encoding="utf-8",
        )

    def get_guild_config(self, guild_id: int) -> GuildConfig:
        config = self._configs.get(guild_id)
        if config is None:
            config = GuildConfig(guild_id=guild_id)
            self._configs[guild_id] = config
            self._save_configs()
        return config

    def configure_channel(self, guild_id: int, channel_id: int, enabled: bool) -> GuildConfig:
        config = self.get_guild_config(guild_id)
        channels = set(config.enabled_channels)

        if enabled:
            channels.add(channel_id)
        else:
            channels.discard(channel_id)

        config.enabled_channels = sorted(channels)
        self._save_configs()
        return config

    def toggle_monitoring(self, guild_id: int, enabled: bool) -> GuildConfig:
        config = self.get_guild_config(guild_id)
        config.monitoring_enabled = enabled
        self._save_configs()
        return config

    def set_alert_role(self, guild_id: int, role_id: int | None) -> GuildConfig:
        config = self.get_guild_config(guild_id)
        config.alert_role_id = role_id
        self._save_configs()
        return config

    def append_detection_log(self, payload: dict[str, Any]) -> None:
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            **payload,
        }
        try:
            with self.log_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=True) + "\n")
        except OSError as exc:
            logging.error("Failed to append detection log: %s", exc)
