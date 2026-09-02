"""Compatibility shim: delegate to the canonical launcher-selected Bridge."""
import subprocess
import sys
from pathlib import Path

launcher = Path(__file__).resolve().parents[2] / ".orchestrator" / "harness" / "bridge-launcher.mjs"
raise SystemExit(subprocess.run(["node", str(launcher), "python", *sys.argv[1:]], check=False).returncode)
