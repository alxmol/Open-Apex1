"""OpenApexAgent — the Harbor BaseInstalledAgent subclass.

M0 implements the class shape + install() properly. run() + the ATIF/metric
parsing in populate_context_post_run() land in M6 where the full Harbor
integration is wired.
"""

from __future__ import annotations

import asyncio
import json
import shlex
from pathlib import Path
from typing import Any, Optional

from .install import (
    HostProfile,
    build_local_bundle,
    build_exploratory_runner_bundle,
    build_save_runner_bundle,
    bun_install_tag,
    prereq_install_command,
    prepare_host_binary,
    sync_runtime_assets,
    write_dev_wrapper,
)

# Import Harbor lazily so this module loads even without Harbor installed
# (CI without the uv-tool python).
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template


class OpenApexAgent(BaseInstalledAgent):
    """Harbor installed-agent that runs the Open-Apex Bun CLI.

    Invoked by Harbor as:
        harbor run --agent-import-path open_apex_agent:OpenApexAgent \
                   --agent-kwarg preset=tb2-opus46 ...
    """

    SUPPORTS_ATIF = True

    # Harbor-selectable kwargs (surfaced on the CLI via --agent-kwarg):
    #   preset:   "tb2-gpt54" | "tb2-sonnet46" | "tb2-opus46" | "tb2-opus47"
    #   version:  CLI version to download from GitHub Releases
    #   dev_fallback: bool — use `bun run ...` instead of prebuilt binary
    def __init__(
        self,
        *args: Any,
        preset: str = "tb2-opus46",
        version: str = "0.0.1",
        dev_fallback: bool = False,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._preset = preset
        self._version = version
        self._dev_fallback = dev_fallback
        self._binary_path: Optional[Path] = None
        self._runtime_mode = "dev_fallback" if dev_fallback else "compiled_binary"
        self._runtime_metadata: dict[str, Any] = {}

    @staticmethod
    def name() -> str:
        return "open-apex"

    def version(self) -> Optional[str]:
        return self._version

    async def install(self, environment: Any) -> None:
        """Install Open-Apex binary inside the Harbor task container.

        §3.5.2 install strategy:
          - Detect package manager (apk/apt-get/dnf/yum).
          - Install minimal prereqs: curl, ca-certificates, unzip, ripgrep.
          - Detect musl vs glibc for Linux.
          - Download open-apex-linux-<arch>[-musl].zip from GitHub Releases.
          - Install to /usr/local/bin/open-apex.
          - Verify via `open-apex --version`.

        Runs during Harbor's setup() phase, BEFORE agent.timeout_sec starts.
        """
        mgr_result = await self.exec_as_root(
            environment,
            command=(
                "if command -v apk >/dev/null 2>&1; then echo apk; "
                "elif command -v apt-get >/dev/null 2>&1; then echo apt-get; "
                "elif command -v dnf >/dev/null 2>&1; then echo dnf; "
                "elif command -v yum >/dev/null 2>&1; then echo yum; "
                "else echo none; fi"
            ),
        )
        mgr = (mgr_result.stdout or "").strip()
        if mgr in {"apk", "apt-get", "dnf", "yum"}:
            await self.exec_as_root(environment, command=prereq_install_command(mgr))

        arch_result = await self.exec_as_agent(
            environment,
            command="uname -m",
        )
        arch_raw = (arch_result.stdout or "").strip().lower()
        arch = {
            "x86_64": "x64",
            "amd64": "x64",
            "aarch64": "arm64",
            "arm64": "arm64",
        }.get(arch_raw, arch_raw)

        libc_result = await self.exec_as_agent(
            environment,
            command=(
                "if [ -f /etc/alpine-release ] || (command -v ldd >/dev/null 2>&1 && "
                "ldd --version 2>&1 | grep -qi musl); then echo musl; else echo glibc; fi"
            ),
        )
        libc = (libc_result.stdout or "").strip().lower() or "glibc"
        profile = HostProfile(os="linux", arch=arch, libc=libc)

        remote_binary = "/installed-agent/open-apex"
        if self._dev_fallback:
            host_bundle_dir = self.logs_dir / "open-apex-host-bin"
            host_bundle = host_bundle_dir / "open-apex.mjs"
            await asyncio.to_thread(build_local_bundle, host_bundle)
            wrapper = host_bundle_dir / "open-apex"
            await asyncio.to_thread(
                write_dev_wrapper,
                wrapper,
                bundle_path="/installed-agent/open-apex.mjs",
            )

            await environment.upload_file(host_bundle, "/installed-agent/open-apex.mjs")
            await environment.upload_file(wrapper, remote_binary)
            await self.exec_as_root(
                environment,
                command=f"chmod 755 {remote_binary} /installed-agent/open-apex.mjs",
            )
            bun_check = await self.exec_as_agent(
                environment,
                command='if command -v bun >/dev/null 2>&1; then echo present; elif [ -x "$HOME/.bun/bin/bun" ]; then echo present; else echo missing; fi',
            )
            if (bun_check.stdout or "").strip() != "present":
                bun_tag = shlex.quote(bun_install_tag())
                await self.exec_as_agent(
                    environment,
                    command=(
                        'export BUN_INSTALL="$HOME/.bun"; '
                        'install_url="https://bun.com/install"; '
                        f"tag={bun_tag}; "
                        'log="/tmp/open-apex-bun-install.log"; '
                        'rm -f "$log"; '
                        'for delay in 1 3 7; do '
                        'if curl -fsSL "$install_url" | bash -s "$tag" >>"$log" 2>&1; then '
                        '"$HOME/.bun/bin/bun" --version >>"$log" 2>&1 && '
                        '"$HOME/.bun/bin/bun" --revision >>"$log" 2>&1 && exit 0; '
                        "fi; "
                        'sleep "$delay"; '
                        "done; "
                        'echo "bun install failed url=$install_url tag=$tag" >&2; '
                        'tail -120 "$log" >&2; '
                        "exit 1"
                    ),
                )
                bun_check = await self.exec_as_agent(
                    environment,
                    command='if command -v bun >/dev/null 2>&1; then echo present; elif [ -x "$HOME/.bun/bin/bun" ]; then echo present; else echo missing; fi',
                )
            if (bun_check.stdout or "").strip() != "present":
                raise RuntimeError(
                    "dev_fallback requires bun in the container agent environment, and automatic bun installation failed"
                )
        else:
            host_binary_dir = self.logs_dir / "open-apex-host-bin"
            host_binary = host_binary_dir / "open-apex"
            await asyncio.to_thread(
                prepare_host_binary,
                host_binary,
                self._version,
                profile=profile,
                dev_fallback=False,
            )
            await environment.upload_file(host_binary, remote_binary)
            await self.exec_as_root(
                environment,
                command=f"chmod 755 {remote_binary}",
            )

        verify = await self.exec_as_agent(
            environment,
            command=f"{remote_binary} --version",
        )
        reported_version = (verify.stdout or "").strip()
        if not reported_version:
            raise RuntimeError("uploaded Open-Apex binary did not report a version")
        self._binary_path = Path(remote_binary)
        await self._record_runtime_metadata(environment, reported_version)

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: Any,
        context: Any,
    ) -> None:
        """Invoke /usr/local/bin/open-apex autonomous with the task instruction.

        M0 scope: placeholder that writes a sentinel ATIF so Harbor sees a
        valid trajectory.json even if the Bun CLI isn't live-wired. M6 wires
        the full subprocess invocation with stdout/stderr piping into
        /logs/agent/ and proper artifact collection.
        """
        if self._binary_path is None:
            await self.install(environment)

        task_file = "/tmp/open-apex-task.txt"
        local_task_file = self.logs_dir / "open-apex-task.txt"
        local_task_file.write_text(instruction)
        await environment.upload_file(local_task_file, task_file)

        config_dir = self.logs_dir / "open-apex-host-config"
        presets_dir, prompts_dir, runtime_config_dir, assets_dir = await asyncio.to_thread(
            sync_runtime_assets, config_dir
        )
        self._runtime_metadata.update(
            {
                "open_apex_config_dir": "/installed-agent/config",
                "open_apex_assets_dir": "/installed-agent/assets",
                "contamination_blocklist_present": (
                    runtime_config_dir / "contamination-blocklist.v1.json"
                ).exists(),
                "tree_sitter_assets_present": any(assets_dir.rglob("*.wasm")),
            }
        )
        (self.logs_dir / "runtime-metadata.json").write_text(
            json.dumps(self._runtime_metadata, indent=2, sort_keys=True) + "\n"
        )
        helper_dir = self.logs_dir / "open-apex-host-helpers"
        save_runner_bundle = helper_dir / "save-runner.mjs"
        exploratory_runner_bundle = helper_dir / "exploratory-runner.mjs"
        await asyncio.to_thread(build_save_runner_bundle, save_runner_bundle)
        await asyncio.to_thread(build_exploratory_runner_bundle, exploratory_runner_bundle)

        await environment.upload_dir(presets_dir, "/installed-agent/presets")
        await environment.upload_dir(prompts_dir, "/installed-agent/prompts")
        await environment.upload_dir(runtime_config_dir, "/installed-agent/config")
        await environment.upload_dir(assets_dir, "/installed-agent/assets")
        await environment.upload_file(save_runner_bundle, "/installed-agent/save-runner.mjs")
        await environment.upload_file(
            exploratory_runner_bundle,
            "/installed-agent/exploratory-runner.mjs",
        )

        await self._assert_runtime_commands(environment)

        workdir = (
            getattr(getattr(environment, "task_env_config", None), "workdir", None)
            or "/app"
        )
        output_dir = "/logs/agent"
        command = " ".join(
            shlex.quote(part)
            for part in [
                str(self._binary_path),
                "autonomous",
                "--workspace",
                workdir,
                "--task-file",
                task_file,
                "--preset",
                self._preset,
                "--output-dir",
                output_dir,
                "--benchmark",
            ]
        )
        exec_env = {
            **self._extra_env,
            "OPEN_APEX_PRESETS_DIR": "/installed-agent/presets",
            "OPEN_APEX_PROMPTS_DIR": "/installed-agent/prompts/",
            "OPEN_APEX_CONFIG_DIR": "/installed-agent/config",
            "OPEN_APEX_ASSETS_DIR": "/installed-agent/assets",
            "OPEN_APEX_SAVE_RUNNER_PATH": "/installed-agent/save-runner.mjs",
            "OPEN_APEX_EXPLORATORY_RUNNER_PATH": "/installed-agent/exploratory-runner.mjs",
            # Harbor's agent cap is seconds-based. The CLI parses this as an
            # internal watchdog/deadline only; prompts and model feedback never
            # receive remaining-time hints from it.
            "OPEN_APEX_BENCHMARK_TIMEOUT_MS": self._extra_env.get(
                "OPEN_APEX_BENCHMARK_TIMEOUT_MS",
                "900s",
            ),
            # The CLI owns the actual phase abort, but the Harbor wrapper sets
            # a benchmark-safe default so uploaded agents do not silently sit in
            # pre-execute gather forever when the outer Harbor cap is larger.
            "OPEN_APEX_PRE_EXECUTE_PROGRESS_TIMEOUT_MS": self._extra_env.get(
                "OPEN_APEX_PRE_EXECUTE_PROGRESS_TIMEOUT_MS",
                self._extra_env.get("OPEN_APEX_HARBOR_NO_PROGRESS_TIMEOUT_MS", "240000"),
            ),
        }
        stdout_log = "/logs/agent/open-apex.stdout.log"
        result = await environment.exec(
            command=(
                f"{command} > {shlex.quote(stdout_log)} 2>&1; "
                f"rc=$?; cat {shlex.quote(stdout_log)}; exit $rc"
            ),
            env=exec_env,
            cwd=workdir,
        )

        stdout_payload = (result.stdout or "").strip()
        if stdout_payload:
            (self.logs_dir / "stdout.jsonl").write_text(stdout_payload + "\n")
            parsed = self._extract_result_payload(stdout_payload)
            if parsed is not None:
                artifact_paths = parsed.get("artifact_paths", {})
                bundle_dir = self._host_bundle_dir_from_result(artifact_paths)
                if bundle_dir is not None:
                    self._alias_bundle_artifacts(bundle_dir)
        if result.return_code != 0:
            parsed = self._extract_result_payload(stdout_payload)
            if parsed is not None:
                return
            # Harbor will raise; before it does, write a crash forensics
            # file with the exit code + signal interpretation + the tail of
            # events.jsonl from the most recent run subdir. Since SIGSEGV
            # (exit 139) skips the Bun atifWriter.flush(), the incremental
            # events log is the only surviving audit trail.
            self._write_crash_forensics(result.return_code, stdout_payload)
            raise RuntimeError(
                f"Open-Apex command failed without machine-readable result (exit {result.return_code})"
            )

    def _write_crash_forensics(self, return_code: int, stdout_payload: str) -> None:
        """Record the last known state when the Bun process died abnormally."""
        try:
            signal_hint = ""
            if return_code == 139:
                signal_hint = "SIGSEGV (segfault — likely Bun runtime crash)"
            elif return_code == 137:
                signal_hint = "SIGKILL (OOM or external kill)"
            elif return_code == 143:
                signal_hint = "SIGTERM (graceful termination)"
            elif return_code > 128:
                signal_hint = f"signal {return_code - 128}"

            lines = [
                "# open-apex bun crash forensics",
                f"exit_code: {return_code}",
                f"signal_hint: {signal_hint or 'none'}",
                f"runtime_mode: {getattr(self, '_runtime_mode', 'unknown')}",
                f"runtime_metadata: {json.dumps(getattr(self, '_runtime_metadata', {}), sort_keys=True)}",
                f"stdout_len: {len(stdout_payload)}",
                f"stdout_tail:\n{stdout_payload[-2048:] if stdout_payload else '(empty)'}",
                "",
            ]

            # Locate the most recent run's events.jsonl and snapshot the tail.
            run_dirs = sorted(
                [p for p in self.logs_dir.glob("run_*") if p.is_dir()],
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
            if run_dirs:
                events_file = run_dirs[0] / "events.jsonl"
                lines.append(f"latest_run_dir: {run_dirs[0]}")
                if events_file.exists():
                    tail_lines: list[str] = []
                    with events_file.open() as fh:
                        for ln in fh:
                            tail_lines.append(ln.rstrip("\n"))
                    tail_slice = tail_lines[-30:]
                    lines.append(
                        f"events.jsonl total_lines: {len(tail_lines)}; last_30:"
                    )
                    lines.extend(tail_slice)
                else:
                    lines.append("events.jsonl: not found")
                # Also snapshot partial trajectory if the incremental flush
                # wrote one (see telemetry/atif-writer.ts flushPartial).
                partial_traj = run_dirs[0] / "trajectory.json"
                if partial_traj.exists():
                    lines.append("")
                    lines.append(f"partial trajectory: {partial_traj}")
                    try:
                        t = json.loads(partial_traj.read_text())
                        lines.append(
                            f"  steps: {len(t.get('steps', []))}"
                            f"  partial: {t.get('extra', {}).get('partial', False)}"
                        )
                    except Exception as e:
                        lines.append(f"  (unparseable: {type(e).__name__}: {e})")
            else:
                lines.append("no run_* subdirs under logs_dir (bun died before bundle init)")

            crash_path = self.logs_dir / "crash.txt"
            crash_path.write_text("\n".join(lines) + "\n")
        except Exception as e:
            import sys

            print(
                f"[open-apex] crash forensics failed: {type(e).__name__}: {e}",
                file=sys.stderr,
            )

    def populate_context_post_run(self, context: Any) -> None:
        """Parse /logs/agent/trajectory.json, sum metrics onto context.

        §3.4.7: context.n_input_tokens / n_output_tokens / n_cache_tokens /
        cost_usd should accumulate totals. rollout_details receives a
        pointer to the artifact bundle for RL training.

        M0 parses the sentinel (or a real trajectory if M6+ has been run);
        fails gracefully if the file doesn't exist.
        """
        trajectory_path = self.logs_dir / "trajectory.json"
        if not trajectory_path.exists():
            return
        try:
            t = json.loads(trajectory_path.read_text())
        except Exception:
            return
        totals = _sum_final_metrics(t)
        if hasattr(context, "n_input_tokens"):
            context.n_input_tokens = totals["input"]
        if hasattr(context, "n_output_tokens"):
            context.n_output_tokens = totals["output"]
        if hasattr(context, "n_cache_tokens"):
            context.n_cache_tokens = totals["cached"]
        if hasattr(context, "cost_usd"):
            context.cost_usd = totals["cost_usd"]
        # Poll for the verifier truth — Harbor may still be copying
        # /logs/verifier/* from container to host when populate_context_post_run
        # is invoked, so the first read can miss. Previous (0, 200, 500, 1000)
        # window caught zero trials in production; observed Harbor often
        # writes reward.txt several seconds AFTER this hook returns. The new
        # (0, 500, 1500, 3000, 6000, 10000) window totals ~21 s of retries
        # — best-effort bounded; if Harbor writes STRICTLY after us, we log
        # a one-line warning instead of silently missing it.
        import os
        import sys as _sys
        import time

        # Tests / CI may set OPEN_APEX_VERIFIER_POLL_MS=0 to skip delays.
        poll_env = os.environ.get("OPEN_APEX_VERIFIER_POLL_MS")
        if poll_env is not None:
            try:
                delays_ms: tuple[int, ...] = tuple(
                    int(x) for x in poll_env.split(",") if x.strip()
                )
            except ValueError:
                delays_ms = (0, 500, 1500, 3000, 6000, 10000)
        else:
            delays_ms = (0, 500, 1500, 3000, 6000, 10000)

        verifier_probe_attempts: list[dict[str, Any]] = []
        verifier_truth: Optional[dict[str, Any]] = None
        reward_txt_path = self.logs_dir.parent / "verifier" / "reward.txt"
        reward_json_path = self.logs_dir.parent / "verifier" / "reward.json"
        for delay_ms in delays_ms:
            if delay_ms > 0:
                time.sleep(delay_ms / 1000)
            snap = {
                "at_ms": delay_ms,
                "reward_txt_exists": reward_txt_path.exists(),
                "reward_json_exists": reward_json_path.exists(),
            }
            verifier_probe_attempts.append(snap)
            verifier_truth = self._read_verifier_truth()
            if verifier_truth is not None:
                break

        # When every probe came back empty, emit a single stderr warning so
        # the trial.log records the gap. Paired with the HttpError surface
        # improvements in autonomous.ts, this removes the blind spot that
        # was masking Anthropic 0/6 yesterday.
        if verifier_truth is None and verifier_probe_attempts:
            total_ms = sum(d for d in delays_ms)
            print(
                "[open-apex] populate_context_post_run: verifier reward.txt never "
                f"appeared in {total_ms} ms of polling ({len(verifier_probe_attempts)} "
                "probes); falling back to cross-referencing result.json in post-hoc "
                "analysis. This is best-effort; Harbor may write reward.txt AFTER "
                "this hook returns.",
                file=_sys.stderr,
            )

        # Stamp a populate_context_post_run_ran marker on every trajectory,
        # regardless of whether reward data is present, so post-mortem can
        # distinguish "populate didn't run" from "populate ran but found no
        # reward".
        from datetime import datetime, timezone

        populate_ran_at = datetime.now(timezone.utc).isoformat()
        import sys

        try:
            trajectory = json.loads(trajectory_path.read_text())
            extra = trajectory.get("extra")
            if not isinstance(extra, dict):
                extra = {}
            extra["populate_context_post_run_ran_at"] = populate_ran_at
            extra["open_apex_agent_module_path"] = __file__
            extra["verifier_probe_attempts"] = verifier_probe_attempts
            extra["reward_txt_path"] = str(reward_txt_path)
            if verifier_truth is not None:
                extra["harbor_verifier_truth"] = verifier_truth
            trajectory["extra"] = extra
            trajectory_path.write_text(
                json.dumps(trajectory, indent=2, ensure_ascii=False) + "\n"
            )
        except Exception as e:
            # Explicit stderr log so install-propagation / permission errors
            # are debuggable from the trial.log, not silently swallowed.
            print(
                f"[open-apex] populate_context_post_run: trajectory rewrite failed: {type(e).__name__}: {e}",
                file=sys.stderr,
            )

        if verifier_truth is not None and hasattr(context, "metadata"):
            metadata = dict(context.metadata or {})
            metadata["harbor_verifier_truth"] = verifier_truth
            context.metadata = metadata

    def _extract_result_payload(self, stdout_payload: str) -> Optional[dict[str, Any]]:
        for line in reversed(stdout_payload.splitlines()):
            line = line.strip()
            if not line or not line.startswith("{"):
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if parsed.get("schema_version") == "open-apex-result.v1":
                return parsed
        return None

    def _read_verifier_truth(self) -> Optional[dict[str, Any]]:
        reward_txt = self.logs_dir.parent / "verifier" / "reward.txt"
        reward_json = self.logs_dir.parent / "verifier" / "reward.json"
        out: dict[str, Any] = {}
        if reward_txt.exists():
          try:
            out["reward_text"] = reward_txt.read_text().strip()
          except Exception:
            pass
        if reward_json.exists():
          try:
            out["reward_json"] = json.loads(reward_json.read_text())
          except Exception:
            pass
        return out or None

    def _host_bundle_dir_from_result(
        self, artifact_paths: dict[str, Any]
    ) -> Optional[Path]:
        result_path = artifact_paths.get("result")
        if not isinstance(result_path, str) or not result_path:
            return None
        prefix = "/logs/agent/"
        if result_path.startswith(prefix):
            relative = result_path[len(prefix) :]
            return (self.logs_dir / relative).resolve().parent
        try:
            return Path(result_path).resolve().parent
        except Exception:
            return None

    def _alias_bundle_artifacts(self, bundle_dir: Path) -> None:
        aliases = {
            "trajectory.json": "trajectory.json",
            "summary.json": "summary.json",
            "replay.md": "replay.md",
            "result.json": "open-apex-result.json",
            "events.jsonl": "events.jsonl",
        }
        for source_name, alias_name in aliases.items():
            source = bundle_dir / source_name
            target = self.logs_dir / alias_name
            if not source.exists():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(source.read_text())

    async def _assert_runtime_commands(self, environment: Any) -> None:
        check = await self.exec_as_agent(
            environment,
            command='missing=""; for bin in git rg; do command -v "$bin" >/dev/null 2>&1 || missing="$missing $bin"; done; echo "${missing# }"',
        )
        missing = (check.stdout or "").strip()
        if missing:
            raise RuntimeError(f"required runtime commands missing in container: {missing}")

    async def _record_runtime_metadata(
        self, environment: Any, open_apex_version: str
    ) -> None:
        metadata: dict[str, Any] = {
            "runtime_mode": getattr(self, "_runtime_mode", "unknown"),
            "open_apex_version": open_apex_version,
            "open_apex_config_dir": "/installed-agent/config",
            "contamination_blocklist_present": (
                self.logs_dir
                / "open-apex-host-config"
                / "config"
                / "contamination-blocklist.v1.json"
            ).exists(),
        }
        if getattr(self, "_dev_fallback", False):
            bun = await self.exec_as_agent(
                environment,
                command=(
                    'if [ -x "$HOME/.bun/bin/bun" ]; then B="$HOME/.bun/bin/bun"; '
                    'else B="$(command -v bun || true)"; fi; '
                    'if [ -n "$B" ]; then "$B" --version; '
                    '"$B" --revision 2>/dev/null || echo revision_unavailable; '
                    "else echo missing; fi"
                ),
            )
            lines = [line.strip() for line in (bun.stdout or "").splitlines() if line.strip()]
            metadata["bun_version"] = lines[0] if len(lines) >= 1 else "missing"
            metadata["bun_revision"] = lines[1] if len(lines) >= 2 else "missing"
            metadata["bun_install_tag"] = bun_install_tag()
        self._runtime_metadata = metadata
        try:
            (self.logs_dir / "runtime-metadata.json").write_text(
                json.dumps(metadata, indent=2, sort_keys=True) + "\n"
            )
        except Exception:
            pass


def _sum_final_metrics(trajectory: dict) -> dict:
    fm = trajectory.get("final_metrics") or {}
    return {
        "input": fm.get("total_prompt_tokens", 0),
        "output": fm.get("total_completion_tokens", 0),
        "cached": fm.get("total_cached_tokens", 0),
        "cost_usd": fm.get("total_cost_usd", 0.0),
    }
