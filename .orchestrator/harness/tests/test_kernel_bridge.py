import ast
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
BRIDGE = ROOT / "kernel_bridge.py"
LAUNCHER = ROOT / "bridge-launcher.mjs"


class KernelBridgeTests(unittest.TestCase):
    def test_static_imports_are_lazy_and_standard_library_only(self):
        tree = ast.parse(BRIDGE.read_text(encoding="utf-8"))
        top_level = {
            alias.name.split(".")[0]
            for node in tree.body
            if isinstance(node, (ast.Import, ast.ImportFrom))
            for alias in node.names
        }
        self.assertNotIn("jupyter", top_level)
        self.assertNotIn("unittest", top_level)

    def test_public_probe_never_claims_escapable_posix_process_groups(self):
        result = subprocess.run([sys.executable, str(BRIDGE), "probe-containment"], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        if os.name == "nt":
            self.assertTrue(report["available"])
            self.assertEqual(report["provider"], "windows_job_object")
        else:
            self.assertFalse(report["available"])
            self.assertEqual(report["reason"], "POSIX_PROCESS_GROUP_ESCAPE_UNCONTAINED")

    def test_python_brokers_event_append_through_node(self):
        with tempfile.TemporaryDirectory(prefix="ecc-python-broker-") as temporary:
            run_dir = Path(temporary) / "run"
            artifacts = run_dir / "artifacts"
            artifacts.mkdir(parents=True)
            body = b"PYTHON_PROMPT_PRIVATE_SENTINEL"
            artifact = artifacts / "prompt.txt"
            artifact.write_bytes(body)
            request = {
                "runDir": str(run_dir),
                "event": {
                    "runId": "python-broker",
                    "type": "bridge_prompt",
                    "producer": "bridge-python-facade",
                    "authority": "workflow_assertion",
                    "data": {
                        "promptDigest": hashlib.sha256(body).hexdigest(),
                        "promptArtifactRef": "artifacts/prompt.txt",
                    },
                },
            }
            request_path = Path(temporary) / "request.json"
            request_path.write_text(json.dumps(request), encoding="utf-8")
            result = subprocess.run(
                ["node", str(LAUNCHER), "python", "append-event", "--request", str(request_path)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            serialized = (run_dir / "events.jsonl").read_text(encoding="utf-8")
            self.assertNotIn(body.decode(), serialized)
            self.assertIn("promptDigest", serialized)

    def test_contained_runner_rejects_and_removes_malformed_private_input(self):
        with tempfile.TemporaryDirectory(prefix="ecc-contained-invalid-") as temporary:
            request_path = Path(temporary) / "private-request.json"
            request_path.write_text(json.dumps({
                "runner": {"command": sys.executable, "args": ["--version"], "cwd": temporary},
                "stdinBase64": "not-valid-***",
                "budget": {"tokens": 1, "toolCalls": 1, "wallSeconds": 2, "processes": 1},
            }), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(BRIDGE), "run-contained", "--request", str(request_path), "--skip-probe"],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertFalse(report["launched"])
            self.assertIn("RUNNER_STDIN_INVALID", report["launchError"])
            self.assertFalse(request_path.exists())

    @unittest.skipUnless(os.name == "nt", "Windows capture-path validation")
    def test_contained_runner_rejects_unconfined_capture_paths(self):
        with tempfile.TemporaryDirectory(prefix="ecc-contained-path-") as temporary:
            root = Path(temporary)
            request_path = root / "lease.json.request"
            request_path.write_text(json.dumps({
                "runner": {"command": sys.executable, "args": ["--version"], "cwd": temporary},
                "stdinBase64": "", "maxCaptureBytes": 1024,
                "control": {"supervisorPid": os.getpid(), "nonce": "n", "stopFile": str(root / "lease.json.stop"), "stdoutPath": str(root.parent / "foreign.capture-stdout"), "stderrPath": str(root.parent / "foreign.capture-stderr")},
                "budget": {"tokens": 1, "toolCalls": 1, "wallSeconds": 2, "processes": 1},
            }), encoding="utf-8")
            result = subprocess.run([sys.executable, str(BRIDGE), "run-contained", "--request", str(request_path), "--skip-probe"], capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertFalse(report["launched"])
            self.assertIn("RUNNER_CONTROL_INVALID", report["launchError"])
            self.assertFalse(request_path.exists())


if __name__ == "__main__":
    unittest.main()
