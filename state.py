"""
state.py — Runtime state singleton.

Shared across all modules. Thread-safe counters via simple attribute
assignment (GIL protects int/bool reads; no cross-thread mutation needed
because everything runs in the asyncio event loop).
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional


@dataclass
class AppState:
    # ── Status ────────────────────────────────────────────────────────────
    running: bool = False
    server_count: int = 0
    monitoring_status: str = "Idle"

    # ── Last detection ────────────────────────────────────────────────────
    last_detected_scrim: str = "None"
    last_detected_at: Optional[datetime] = None

    # ── Counters ──────────────────────────────────────────────────────────
    pid: Optional[int] = None
    crash_count: int = 0
    detection_count: int = 0
    alert_count: int = 0
    alert_failed_count: int = 0         # NEW: track send failures
    duplicate_skipped_count: int = 0    # NEW: track dedup hits

    # ── WhatsApp queue depth (set by the queue worker) ────────────────────
    wa_queue_depth: int = 0             # NEW

    def to_dict(self) -> dict:
        return {
            "running":              self.running,
            "serverCount":          self.server_count,
            "monitoringStatus":     self.monitoring_status,
            "lastDetectedScrim":    self.last_detected_scrim,
            "lastDetectedAt":       (
                self.last_detected_at.isoformat() if self.last_detected_at else None
            ),
            "pid":                  self.pid,
            "crashCount":           self.crash_count,
            "detectionCount":       self.detection_count,
            "alertCount":           self.alert_count,
            "alertFailedCount":     self.alert_failed_count,
            "duplicateSkipped":     self.duplicate_skipped_count,
            "waQueueDepth":         self.wa_queue_depth,
        }

    # ── Lifecycle ─────────────────────────────────────────────────────────

    def mark_started(self, pid: int, server_count: int) -> None:
        self.running = True
        self.pid = pid
        self.server_count = server_count
        self.monitoring_status = "Active"

    def mark_stopped(self) -> None:
        self.running = False
        self.monitoring_status = "Idle"
        self.pid = None

    def record_detection(self, summary: str) -> None:
        self.last_detected_scrim = summary
        self.last_detected_at = datetime.utcnow()
        self.detection_count += 1

    def record_alert_sent(self) -> None:
        self.alert_count += 1

    def record_alert_failed(self) -> None:
        self.alert_failed_count += 1

    def record_duplicate_skipped(self) -> None:
        self.duplicate_skipped_count += 1

    def record_crash(self) -> None:
        self.crash_count += 1
        self.running = False
        self.monitoring_status = "Crashed"


# ── Singleton ─────────────────────────────────────────────────────────────
state = AppState()