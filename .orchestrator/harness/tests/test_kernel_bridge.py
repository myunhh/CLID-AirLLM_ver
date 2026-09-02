import ast
import hashlib
import json
import os
import subprocess
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


if __name__ == "__main__":
    unittest.main()
