"""
utils/logger.py
Rotating file logger — safe for long-running production bots.

Changes from original:
  - RotatingFileHandler (10 MB × 5 backups) — prevents disk fill
  - Separate error.log file for easy alerting
  - Color-coded console output (no extra deps)
  - Single shared formatter instance
"""

import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

# ── Paths ─────────────────────────────────────────────────────────────────
LOG_DIR = Path(__file__).resolve().parent.parent / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

# ── Formats ───────────────────────────────────────────────────────────────
_FMT      = "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s"
_DATE_FMT = "%Y-%m-%d %H:%M:%S"
_formatter = logging.Formatter(_FMT, datefmt=_DATE_FMT)

# ANSI colors for console — ignored on Windows if colorama isn't installed
_COLORS = {
    "DEBUG":    "\033[36m",   # cyan
    "INFO":     "\033[32m",   # green
    "WARNING":  "\033[33m",   # yellow
    "ERROR":    "\033[31m",   # red
    "CRITICAL": "\033[35m",   # magenta
}
_RESET = "\033[0m"


class _ColorFormatter(logging.Formatter):
    """Adds ANSI color to the levelname in console output."""

    def format(self, record: logging.LogRecord) -> str:
        color = _COLORS.get(record.levelname, "")
        record.levelname = f"{color}{record.levelname}{_RESET}"
        return super().format(record)


_color_formatter = _ColorFormatter(_FMT, datefmt=_DATE_FMT)


def get_logger(name: str) -> logging.Logger:
    """
    Return a named logger with:
      - Console handler  (INFO+, colored)
      - app.log handler  (DEBUG+, rotating 10 MB × 5)
      - error.log handler (ERROR+, rotating 5 MB × 3)
    """
    logger = logging.getLogger(name)

    # Guard: only configure once per name
    if logger.handlers:
        return logger

    logger.setLevel(logging.DEBUG)
    logger.propagate = False  # Don't double-log via root logger

    # ── Console (INFO+) ───────────────────────────────────────────────────
    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(logging.INFO)
    ch.setFormatter(_color_formatter)
    logger.addHandler(ch)

    # ── app.log (DEBUG+, rotating) ────────────────────────────────────────
    fh = RotatingFileHandler(
        LOG_DIR / "app.log",
        maxBytes=10 * 1024 * 1024,  # 10 MB
        backupCount=5,
        encoding="utf-8",
    )
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(_formatter)
    logger.addHandler(fh)

    # ── error.log (ERROR+, rotating) ─────────────────────────────────────
    eh = RotatingFileHandler(
        LOG_DIR / "error.log",
        maxBytes=5 * 1024 * 1024,   # 5 MB
        backupCount=3,
        encoding="utf-8",
    )
    eh.setLevel(logging.ERROR)
    eh.setFormatter(_formatter)
    logger.addHandler(eh)

    return logger