"""Tests for populate_context_post_run + _write_crash_forensics.

These cover the two latest-run regressions:
  1. `populate_context_post_run` must stamp a marker into trajectory.json's
     top-level `extra` every time it runs, regardless of whether a Harbor
     reward signal is present. Previously the whole rewrite was gated on
     `verifier_truth is not None`, so when reward wasn't readable (e.g.,
     editable-install stale / signal route) there was no trace that the
     hook ran at all.
  2. When the Bun CLI dies abnormally (exit 139 SIGSEGV, exit 137 SIGKILL,
     etc.) the wrapper writes a `crash.txt` with the latest events.jsonl
     tail so we can diagnose Bun-runtime crashes post-hoc.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import types
import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest import TestCase
from unittest.mock import patch

# Skip wall-clock polls during unit tests.
os.environ.setdefault("OPEN_APEX_VERIFIER_POLL_MS", "0")

# Stub the `harbor` import tree so this test module loads without the
# Harbor SDK installed (e.g., bare CI). populate_context_post_run + the
# crash-forensics path never actually invoke BaseInstalledAgent methods.
if "harbor" not in sys.modules:
    harbor_root = types.ModuleType("harbor")
    harbor_agents = types.ModuleType("harbor.agents")
    harbor_agents_installed = types.ModuleType("harbor.agents.installed")
    harbor_agents_installed_base = types.ModuleType("harbor.agents.installed.base")

    class _FakeBase:  # pragma: no cover — stub
        SUPPORTS_ATIF = False

        def __init__(self, *_: Any, **__: Any) -> None: ...

    def _fake_with_prompt_template(fn):  # pragma: no cover — stub
        return fn

    harbor_agents_installed_base.BaseInstalledAgent = _FakeBase  # type: ignore[attr-defined]
    harbor_agents_installed_base.with_prompt_template = _fake_with_prompt_template  # type: ignore[attr-defined]
    sys.modules["harbor"] = harbor_root
    sys.modules["harbor.agents"] = harbor_agents
    sys.modules["harbor.agents.installed"] = harbor_agents_installed
    sys.modules["harbor.agents.installed.base"] = harbor_agents_installed_base

from open_apex_agent.agent import OpenApexAgent  # noqa: E402


def _make_agent(tmpdir: Path) -> OpenApexAgent:
    """Construct an OpenApexAgent with logs_dir pointed at tmpdir/agent.

    We bypass BaseInstalledAgent.__init__ (which wants real Harbor state) by
    instantiating the class and patching the attributes the methods use.
    """
    # Create the layout the Harbor agent expects.
    (tmpdir / "agent").mkdir(parents=True, exist_ok=True)
    (tmpdir / "verifier").mkdir(parents=True, exist_ok=True)
    agent = object.__new__(OpenApexAgent)
    agent._preset = "tb2-gpt54"  # type: ignore[attr-defined]
    agent._version = "0.0.1"  # type: ignore[attr-defined]
    agent._dev_fallback = False  # type: ignore[attr-defined]
    agent._binary_path = None  # type: ignore[attr-defined]
    agent._extra_env = {}  # type: ignore[attr-defined]
    agent._runtime_mode = "compiled_binary"  # type: ignore[attr-defined]
    agent._runtime_metadata = {}  # type: ignore[attr-defined]
    agent._prompt_template_path = None  # type: ignore[attr-defined]
    # logs_dir is the Path BaseInstalledAgent normally provisions; the
    # agent code always references it via self.logs_dir.
    object.__setattr__(agent, "logs_dir", tmpdir / "agent")
    return agent


class PopulateContextPostRunTests(TestCase):
    def test_stamps_populate_ran_marker_even_when_no_verifier_reward(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            agent = _make_agent(root)
            # Minimal valid ATIF at the aliased location.
            traj = {
                "schema_version": "ATIF-v1.6",
                "session_id": "s_test",
                "agent": {"name": "open-apex", "version": "0.0.1"},
                "steps": [{"step_id": 1, "source": "user", "message": "hi"}],
            }
            (root / "agent" / "trajectory.json").write_text(json.dumps(traj))

            # Context without metadata, without reward files.
            ctx = SimpleNamespace()
            agent.populate_context_post_run(ctx)

            updated = json.loads((root / "agent" / "trajectory.json").read_text())
            self.assertIn("extra", updated)
            self.assertIn("populate_context_post_run_ran_at", updated["extra"])
            self.assertIn("open_apex_agent_module_path", updated["extra"])
            # Diagnostic probes should always be recorded so post-mortem can
            # see every reward.txt/reward.json check we made.
            self.assertIn("verifier_probe_attempts", updated["extra"])
            self.assertIsInstance(updated["extra"]["verifier_probe_attempts"], list)
            # No reward data is present → verifier_truth should be absent.
            self.assertNotIn("harbor_verifier_truth", updated["extra"])

    def test_mirrors_harbor_verifier_truth_when_reward_present(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            agent = _make_agent(root)
            traj = {
                "schema_version": "ATIF-v1.6",
                "session_id": "s_test",
                "agent": {"name": "open-apex", "version": "0.0.1"},
                "steps": [{"step_id": 1, "source": "user", "message": "hi"}],
            }
            (root / "agent" / "trajectory.json").write_text(json.dumps(traj))
            (root / "verifier" / "reward.txt").write_text("1.0")
            (root / "verifier" / "reward.json").write_text(
                json.dumps({"reward": 1.0, "extra": "data"})
            )

            ctx = SimpleNamespace()
            agent.populate_context_post_run(ctx)

            updated = json.loads((root / "agent" / "trajectory.json").read_text())
            self.assertIn("harbor_verifier_truth", updated["extra"])
            self.assertEqual(updated["extra"]["harbor_verifier_truth"]["reward_text"], "1.0")
            self.assertEqual(
                updated["extra"]["harbor_verifier_truth"]["reward_json"]["reward"], 1.0
            )


class WriteCrashForensicsTests(TestCase):
    def test_writes_crash_txt_with_sigsegv_hint_and_events_tail(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            agent = _make_agent(root)
            # Fake a run subdir with events.jsonl.
            run_dir = root / "agent" / "run_1234_abcd"
            run_dir.mkdir(parents=True)
            events = [
                json.dumps({"type": "tool_event", "seq": n, "action": "start"})
                for n in range(1, 6)
            ]
            (run_dir / "events.jsonl").write_text("\n".join(events) + "\n")
            # Include a partial trajectory to make sure the wrapper notes it.
            (run_dir / "trajectory.json").write_text(
                json.dumps(
                    {
                        "schema_version": "ATIF-v1.6",
                        "session_id": "s",
                        "agent": {"name": "open-apex", "version": "0.0.1"},
                        "steps": [{"step_id": 1, "source": "user", "message": "x"}],
                        "extra": {"partial": True},
                    }
                )
            )

            agent._write_crash_forensics(139, "final stdout tail here")  # type: ignore[attr-defined]

            crash_path = root / "agent" / "crash.txt"
            self.assertTrue(crash_path.exists())
            text = crash_path.read_text()
            self.assertIn("exit_code: 139", text)
            self.assertIn("SIGSEGV", text)
            self.assertIn("runtime_mode:", text)
            self.assertIn("runtime_metadata:", text)
            self.assertIn("final stdout tail here", text)
            self.assertIn("events.jsonl total_lines: 5", text)
            self.assertIn("partial trajectory:", text)

    def test_signal_hint_for_sigkill_and_sigterm(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            agent = _make_agent(root)
            for code, hint in ((137, "SIGKILL"), (143, "SIGTERM")):
                (root / "agent" / "crash.txt").unlink(missing_ok=True)
                agent._write_crash_forensics(code, "")  # type: ignore[attr-defined]
                self.assertIn(hint, (root / "agent" / "crash.txt").read_text())

    def test_handles_missing_run_dir_gracefully(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            agent = _make_agent(root)
            agent._write_crash_forensics(139, "stdout")  # type: ignore[attr-defined]
            text = (root / "agent" / "crash.txt").read_text()
            self.assertIn("no run_* subdirs", text)

    def test_records_bun_runtime_metadata_for_dev_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            agent = _make_agent(root)
            agent._dev_fallback = True  # type: ignore[attr-defined]
            agent._runtime_mode = "dev_fallback"  # type: ignore[attr-defined]

            async def fake_exec_as_agent(_environment: Any, command: str) -> Any:
                self.assertIn("bun", command)
                return SimpleNamespace(stdout="1.3.12\n1.3.12+abc123\n")

            agent.exec_as_agent = fake_exec_as_agent  # type: ignore[attr-defined]
            asyncio.run(agent._record_runtime_metadata(object(), "0.0.1"))  # type: ignore[attr-defined]

            metadata = json.loads((root / "agent" / "runtime-metadata.json").read_text())
            self.assertEqual(metadata["runtime_mode"], "dev_fallback")
            self.assertEqual(metadata["open_apex_version"], "0.0.1")
            self.assertEqual(metadata["bun_version"], "1.3.12")
            self.assertEqual(metadata["bun_revision"], "1.3.12+abc123")
            self.assertEqual(metadata["open_apex_config_dir"], "/installed-agent/config")
            self.assertFalse(metadata["contamination_blocklist_present"])


class InstalledAgentRunTests(TestCase):
    def test_run_uploads_save_runner_and_sets_runtime_env(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            agent = _make_agent(root)
            agent._binary_path = Path("/installed-agent/open-apex")  # type: ignore[attr-defined]

            async def noop_assert_runtime_commands(_environment: Any) -> None:
                return None

            agent._assert_runtime_commands = noop_assert_runtime_commands  # type: ignore[attr-defined]

            class FakeEnvironment:
                def __init__(self) -> None:
                    self.uploaded_files: list[tuple[Path, str]] = []
                    self.uploaded_dirs: list[tuple[Path, str]] = []
                    self.exec_calls: list[dict[str, Any]] = []
                    self.task_env_config = SimpleNamespace(workdir="/app")

                async def upload_file(self, local: Path, remote: str) -> None:
                    self.uploaded_files.append((Path(local), remote))

                async def upload_dir(self, local: Path, remote: str) -> None:
                    self.uploaded_dirs.append((Path(local), remote))

                async def exec(self, command: str, env: dict[str, str], cwd: str) -> Any:
                    self.exec_calls.append({"command": command, "env": env, "cwd": cwd})
                    return SimpleNamespace(
                        return_code=0,
                        stdout='{"schema_version":"open-apex-result.v1","status":"validation_unknown","artifact_paths":{}}\n',
                    )

            env = FakeEnvironment()
            presets = root / "presets"
            prompts = root / "prompts"
            runtime_config = root / "runtime-config"
            assets = root / "assets"
            presets.mkdir()
            prompts.mkdir()
            runtime_config.mkdir()
            assets.mkdir()
            (runtime_config / "contamination-blocklist.v1.json").write_text("{}\n")
            (assets / "tree-sitter.wasm").write_text("wasm")

            def fake_bundle(output: Path) -> Path:
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text("// bundled save-runner")
                return output

            with (
                patch(
                    "open_apex_agent.agent.sync_runtime_assets",
                    return_value=(presets, prompts, runtime_config, assets),
                ),
                patch("open_apex_agent.agent.build_save_runner_bundle", side_effect=fake_bundle),
                patch(
                    "open_apex_agent.agent.build_exploratory_runner_bundle",
                    side_effect=fake_bundle,
                ),
            ):
                asyncio.run(agent.run("do the task", env, SimpleNamespace()))

            self.assertIn(
                "/installed-agent/save-runner.mjs",
                [remote for _, remote in env.uploaded_files],
            )
            self.assertIn(
                "/installed-agent/exploratory-runner.mjs",
                [remote for _, remote in env.uploaded_files],
            )
            self.assertIn(
                "/installed-agent/config",
                [remote for _, remote in env.uploaded_dirs],
            )
            self.assertIn(
                "/installed-agent/assets",
                [remote for _, remote in env.uploaded_dirs],
            )
            self.assertEqual(
                env.exec_calls[-1]["env"]["OPEN_APEX_SAVE_RUNNER_PATH"],
                "/installed-agent/save-runner.mjs",
            )
            self.assertEqual(
                env.exec_calls[-1]["env"]["OPEN_APEX_EXPLORATORY_RUNNER_PATH"],
                "/installed-agent/exploratory-runner.mjs",
            )
            self.assertEqual(
                env.exec_calls[-1]["env"]["OPEN_APEX_CONFIG_DIR"],
                "/installed-agent/config",
            )
            self.assertEqual(
                env.exec_calls[-1]["env"]["OPEN_APEX_ASSETS_DIR"],
                "/installed-agent/assets",
            )
            self.assertEqual(
                env.exec_calls[-1]["env"]["OPEN_APEX_PRE_EXECUTE_PROGRESS_TIMEOUT_MS"],
                "240000",
            )
            self.assertEqual(
                env.exec_calls[-1]["env"]["OPEN_APEX_BENCHMARK_TIMEOUT_MS"],
                "900s",
            )
            self.assertNotIn("| tee", env.exec_calls[-1]["command"])
            self.assertIn("> /logs/agent/open-apex.stdout.log 2>&1", env.exec_calls[-1]["command"])
            self.assertIn("cat /logs/agent/open-apex.stdout.log", env.exec_calls[-1]["command"])
            metadata = json.loads((root / "agent" / "runtime-metadata.json").read_text())
            self.assertEqual(metadata["open_apex_config_dir"], "/installed-agent/config")
            self.assertEqual(metadata["open_apex_assets_dir"], "/installed-agent/assets")
            self.assertTrue(metadata["contamination_blocklist_present"])
            self.assertTrue(metadata["tree_sitter_assets_present"])
