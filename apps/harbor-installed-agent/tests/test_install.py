from __future__ import annotations

import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from open_apex_agent.install import (
    HostProfile,
    build_exploratory_runner_bundle,
    build_save_runner_bundle,
    bun_install_tag,
    prepare_host_binary,
    prereq_install_command,
    sync_runtime_assets,
    write_dev_wrapper,
)


class PrepareHostBinaryTests(TestCase):
    def test_falls_back_to_local_build_when_release_unavailable(self) -> None:
        profile = HostProfile(os="linux", arch="x64", libc="glibc")
        with tempfile.TemporaryDirectory() as td:
            output = Path(td) / "open-apex"
            with (
                patch(
                    "open_apex_agent.install.download_release_binary",
                    side_effect=RuntimeError("release missing"),
                ),
                patch(
                    "open_apex_agent.install.build_local_binary",
                    side_effect=lambda path, **_: (
                        path.write_text("binary"),
                        path,
                    )[1],
                ) as build_mock,
            ):
                result = prepare_host_binary(output, "0.0.1", profile=profile)

        self.assertEqual(result, output)
        build_mock.assert_called_once()

    def test_raises_when_release_and_local_build_fail(self) -> None:
        profile = HostProfile(os="linux", arch="x64", libc="glibc")
        with tempfile.TemporaryDirectory() as td:
            output = Path(td) / "open-apex"
            with (
                patch(
                    "open_apex_agent.install.download_release_binary",
                    side_effect=RuntimeError("release missing"),
                ),
                patch(
                    "open_apex_agent.install.build_local_binary",
                    side_effect=RuntimeError("bun missing"),
                ),
            ):
                with self.assertRaises(RuntimeError) as ctx:
                    prepare_host_binary(output, "0.0.1", profile=profile)

        self.assertIn("release missing", str(ctx.exception))
        self.assertIn("bun missing", str(ctx.exception))


def test_bun_discovery_filename_anchor() -> None:
    case = PrepareHostBinaryTests()
    case.test_falls_back_to_local_build_when_release_unavailable()
    case.test_raises_when_release_and_local_build_fail()


def test_write_dev_wrapper_contains_bundle_path() -> None:
    with tempfile.TemporaryDirectory() as td:
        wrapper = Path(td) / "open-apex"
        write_dev_wrapper(wrapper, bundle_path="/installed-agent/open-apex.mjs")
        content = wrapper.read_text()

    assert '/installed-agent/open-apex.mjs "$@"' in content
    assert '"$HOME/.bun/bin/bun"' in content


def test_prereq_install_command_includes_git_and_rg() -> None:
    cmd = prereq_install_command("apt-get")
    assert "git" in cmd
    assert "ripgrep" in cmd


def test_sync_runtime_assets_creates_presets_and_prompts() -> None:
    with tempfile.TemporaryDirectory() as td:
        config_dir = Path(td) / "config"
        presets_dir, prompts_dir, runtime_config_dir, assets_dir = sync_runtime_assets(config_dir)

        assert presets_dir.name == "presets"
        assert prompts_dir.name == "prompts"
        assert runtime_config_dir.name == "config"
        assert assets_dir.name == "assets"
        assert (presets_dir / "tb2-gpt54.json").exists()
        assert (prompts_dir / "identity.v1.md").exists()
        assert (prompts_dir / "recovery" / "test_failure.md").exists()
        assert (runtime_config_dir / "contamination-blocklist.v1.json").exists()
        assert any((assets_dir / "web-tree-sitter").glob("*.wasm"))
        assert any((assets_dir / "tree-sitter-wasms" / "out").glob("*.wasm"))


def test_bun_install_tag_uses_repo_package_manager_and_env_override() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "package.json").write_text('{"packageManager":"bun@1.3.12"}')
        with patch.dict("os.environ", {}, clear=True):
            assert bun_install_tag(source_root=root) == "bun-v1.3.12"
        with patch.dict("os.environ", {"OPEN_APEX_BUN_VERSION": "1.2.3"}, clear=True):
            assert bun_install_tag(source_root=root) == "bun-v1.2.3"
        with patch.dict("os.environ", {"OPEN_APEX_BUN_VERSION": "bun-v1.2.4"}, clear=True):
            assert bun_install_tag(source_root=root) == "bun-v1.2.4"


def test_build_save_runner_bundle_invokes_bun_build() -> None:
    with tempfile.TemporaryDirectory() as td:
        output = Path(td) / "save-runner.mjs"
        with (
            patch("open_apex_agent.install.shutil.which", return_value="/usr/bin/bun"),
            patch(
                "open_apex_agent.install.subprocess.run",
                return_value=SimpleNamespace(returncode=0, stdout="", stderr=""),
            ) as run_mock,
        ):
            result = build_save_runner_bundle(output)

    assert result == output
    args = run_mock.call_args.args[0]
    assert args[:4] == ["bun", "build", "--target", "bun"]
    assert str(output) in args


def test_build_exploratory_runner_bundle_invokes_bun_build() -> None:
    with tempfile.TemporaryDirectory() as td:
        output = Path(td) / "exploratory-runner.mjs"
        with (
            patch("open_apex_agent.install.shutil.which", return_value="/usr/bin/bun"),
            patch(
                "open_apex_agent.install.subprocess.run",
                return_value=SimpleNamespace(returncode=0, stdout="", stderr=""),
            ) as run_mock,
        ):
            result = build_exploratory_runner_bundle(output)

    assert result == output
    args = run_mock.call_args.args[0]
    assert args[:4] == ["bun", "build", "--target", "bun"]
    assert str(output) in args
    assert "exploratory-runner.ts" in args[-1]


def test_extract_result_payload_from_mixed_stdout() -> None:
    from open_apex_agent.agent import OpenApexAgent

    agent = object.__new__(OpenApexAgent)
    payload = agent._extract_result_payload(
        "\n".join(
            [
                "[open-apex/autonomous] run_id=abc preset=tb2-gpt54",
                '{"schema_version":"open-apex-result.v1","status":"validation_unknown","artifact_paths":{}}',
            ]
        )
    )

    assert payload is not None
    assert payload["status"] == "validation_unknown"


def test_read_verifier_truth_reads_reward_files() -> None:
    from open_apex_agent.agent import OpenApexAgent

    with tempfile.TemporaryDirectory() as td:
        agent_logs = Path(td) / "agent"
        verifier_dir = Path(td) / "verifier"
        agent_logs.mkdir(parents=True, exist_ok=True)
        verifier_dir.mkdir(parents=True, exist_ok=True)
        (verifier_dir / "reward.txt").write_text("1.0\n")
        (verifier_dir / "reward.json").write_text('{"reward": 1.0}\n')

        agent = object.__new__(OpenApexAgent)
        agent.logs_dir = agent_logs
        truth = agent._read_verifier_truth()

    assert truth is not None
    assert truth["reward_text"] == "1.0"
    assert truth["reward_json"]["reward"] == 1.0
