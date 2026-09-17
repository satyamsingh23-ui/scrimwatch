"""Build the standalone Windows executable with PyInstaller."""

from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parent
DIST = ROOT / "frontend" / "dist"

if not DIST.is_dir():
    raise SystemExit(
        "frontend/dist is missing. Run `npm run build` in frontend/ first."
    )

command = [
    sys.executable,
    "-m",
    "PyInstaller",
    "--clean",
    "--noconfirm",
    "--onefile",
    "--name",
    "ScrimWatch",
    "--add-data",
    f"{DIST}{';frontend/dist'}",
    str(ROOT / "run.py"),
]

subprocess.run(command, cwd=ROOT, check=True)
