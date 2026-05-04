"""Tests for populate_context_post_run's reward polling + stderr warning."""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import threading
import time
import types
from contextlib import redirect_stderr
from pathlib import Path
from typing import Any
from unittest import TestCase

# Stub the `harbor` import tree so this test can load in a bare CI env
# without the Harbor SDK installed. We only test populate_context_post_run
# — it never touches BaseInstalledAgent functionality.
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

from open_apex_agent.agent import OpenApexAgent  # noqa: E402 — after stubbing


class _FakeContext:
    """Minimal context stub with the attrs populate_context_post_run writes."""

    def __init__(self) -> None:
        self.n_input_tokens = 0
        self.n_output_tokens = 0
        self.n_cache_tokens = 0
        self.cost_usd = 0.0
        self.metadata: dict[str, Any] | None = None


def _mk_agent(logs_dir: Path) -> OpenApexAgent:
    agent = OpenApexAgent.__new__(OpenApexAgent)
    # populate_context_post_run only needs logs_dir on the instance.
    agent.logs_dir = logs_dir  # type: ignore[attr-defined]
    return agent


def _write_trajectory(path: Path) -> None:
    path.write_text(
        json.dumps(
            {
                "schema_version": "ATIF-v1.6",
                "session_id": "test-session",
                "steps": [],
                "final_metrics": {
                    "total_prompt_tokens": 0,
                    "total_completion_tokens": 0,
                    "total_cached_tokens": 0,
                    "total_cost_usd": 0.0,
                },
            }
        )
    )


class PopulateContextPostRunTests(TestCase):
    def test_reward_appearing_late_is_captured_within_poll_window(self) -> None:
        """Regression: every TB2 trial missed `harbor_verifier_truth` because
        the original 1-second poll window was too short. Simulate Harbor
        writing `reward.txt` ~3s after populate_context_post_run starts,
        and confirm the extended window catches it."""
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            logs_dir = td_path / "agent"
            logs_dir.mkdir()
            verifier_dir = td_path / "verifier"
            verifier_dir.mkdir()
            reward_txt = verifier_dir / "reward.txt"

            trajectory = logs_dir / "trajectory.json"
            _write_trajectory(trajectory)

            # Simulate Harbor writing reward.txt 2500ms into the hook.
            def _late_writer() -> None:
                time.sleep(2.5)
                reward_txt.write_text("1.0")

            writer = threading.Thread(target=_late_writer)
            writer.start()
            try:
                # Use the default delays (override only to keep deterministic
                # in CI; these mirror the production defaults).
                os.environ.pop("OPEN_APEX_VERIFIER_POLL_MS", None)
                agent = _mk_agent(logs_dir)
                ctx = _FakeContext()
                stderr_buf = io.StringIO()
                with redirect_stderr(stderr_buf):
                    agent.populate_context_post_run(ctx)
            finally:
                writer.join()

            payload = json.loads(trajectory.read_text())
            extra = payload.get("extra", {})
            self.assertIn("harbor_verifier_truth", extra)
            self.assertEqual(extra["harbor_verifier_truth"], {"reward_text": "1.0"})
            # Warning should NOT fire when the reward eventually appears.
            self.assertNotIn("verifier reward.txt never appeared", stderr_buf.getvalue())
            # Metadata also updated.
            self.assertIsNotNone(ctx.metadata)
            assert ctx.metadata is not None
            self.assertIn("harbor_verifier_truth", ctx.metadata)

    def test_stderr_warning_when_reward_never_appears(self) -> None:
        """When reward.txt is never written (Harbor post-hook ordering),
        populate_context_post_run must log a single-line stderr warning
        so the trial.log records the gap — silent misses hid the
        Anthropic 0/6 yesterday."""
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            logs_dir = td_path / "agent"
            logs_dir.mkdir()
            (td_path / "verifier").mkdir()
            trajectory = logs_dir / "trajectory.json"
            _write_trajectory(trajectory)

            # Tight polling window for fast test — still exercises the
            # "all probes empty" branch.
            os.environ["OPEN_APEX_VERIFIER_POLL_MS"] = "0,10,10"
            try:
                agent = _mk_agent(logs_dir)
                ctx = _FakeContext()
                stderr_buf = io.StringIO()
                with redirect_stderr(stderr_buf):
                    agent.populate_context_post_run(ctx)
            finally:
                os.environ.pop("OPEN_APEX_VERIFIER_POLL_MS", None)

            self.assertIn(
                "verifier reward.txt never appeared", stderr_buf.getvalue()
            )
            payload = json.loads(trajectory.read_text())
            extra = payload.get("extra", {})
            # No harbor_verifier_truth, but diagnostics still stamped.
            self.assertNotIn("harbor_verifier_truth", extra)
            self.assertIn("populate_context_post_run_ran_at", extra)
            self.assertEqual(len(extra.get("verifier_probe_attempts", [])), 3)

    def test_early_reward_short_circuits_polling(self) -> None:
        """When reward.txt is already present on the host, populate_context_
        post_run must read it on the first probe and stop polling."""
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            logs_dir = td_path / "agent"
            logs_dir.mkdir()
            verifier_dir = td_path / "verifier"
            verifier_dir.mkdir()
            (verifier_dir / "reward.txt").write_text("0.5")

            trajectory = logs_dir / "trajectory.json"
            _write_trajectory(trajectory)

            # Tight delays for fast test.
            os.environ["OPEN_APEX_VERIFIER_POLL_MS"] = "0,10000,10000"
            try:
                agent = _mk_agent(logs_dir)
                ctx = _FakeContext()
                started = time.time()
                agent.populate_context_post_run(ctx)
                elapsed = time.time() - started
            finally:
                os.environ.pop("OPEN_APEX_VERIFIER_POLL_MS", None)

            # Found on first probe → no extra sleeps.
            self.assertLess(elapsed, 1.0)
            payload = json.loads(trajectory.read_text())
            extra = payload.get("extra", {})
            self.assertEqual(extra["harbor_verifier_truth"], {"reward_text": "0.5"})
            # Only one probe was recorded.
            self.assertEqual(len(extra["verifier_probe_attempts"]), 1)
