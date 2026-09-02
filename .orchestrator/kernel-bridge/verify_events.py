"""Compatibility shim: delegate verification to the canonical Node verifier."""
import subprocess
import sys
from pathlib import Path

verifier = Path(__file__).resolve().parents[2] / ".orchestrator" / "harness" / "verify-events.mjs"
raise SystemExit(subprocess.run(["node", str(verifier), *sys.argv[1:]], check=False).returncode)
