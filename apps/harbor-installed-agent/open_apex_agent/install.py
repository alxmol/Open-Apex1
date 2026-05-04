"""Bun-in-Docker install strategy.

Locked per §3.5.2. The wrapper's install() branches on the container's
package manager (apk / apt-get / yum), installs only the minimal tooling
required to bootstrap the Open-Apex binary (curl, ca-certificates, unzip,
ripgrep), then downloads the prebuilt platform-specific binary from
GitHub Releases and drops it into /usr/local/bin/open-apex.

GitHub Releases URL (user directive: placeholder namespace, alxmol/Open-Apex1):
   https://github.com/alxmol/Open-Apex1/releases/download/v<VERSION>/
       open-apex-linux-<ARCH>[<-musl>].zip

Musl vs glibc detection: ``ldd --version | grep -qi musl || [ -f /etc/alpine-release ]``.

M0 scope: implementation is wired correctly and unit-testable in isolation
via ``install_into(target_dir, ...)`` which avoids /usr/local/bin writes.
The actual GitHub Releases artifacts are produced in M7 packaging; until
then the install step can pass --dev-fallback to build the CLI from source
via Bun.
"""

from __future__ import annotations

import os
import platform
import shutil
import stat
import subprocess
import tempfile
import urllib.error
import urllib.request
import zipfile
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

OPEN_APEX_REPO = "alxmol/Open-Apex1"  # user directive
PREREQ_PACKAGES = ("bash", "curl", "ca-certificates", "unzip", "ripgrep", "git")


@dataclass(frozen=True)
class HostProfile:
    os: str  # "linux" | "darwin" | "windows"
    arch: str  # "x64" | "arm64"
    libc: str  # "glibc" | "musl" | "apple" | "msvc"

    def release_asset_name(self, version: str) -> str:
        if self.os != "linux":
            raise RuntimeError(
                f"Harbor tasks run in Linux containers; host_os={self.os} is not supported"
            )
        suffix = "-musl" if self.libc == "musl" else ""
        return f"open-apex-linux-{self.arch}{suffix}.zip"

    def release_url(self, version: str) -> str:
        return (
            f"https://github.com/{OPEN_APEX_REPO}/releases/download/"
            f"v{version}/{self.release_asset_name(version)}"
        )

    def bun_target(self) -> str:
        if self.os != "linux":
            raise RuntimeError(
                f"Open-Apex Harbor install only supports linux targets, got {self.os}"
            )
        suffix = "-musl" if self.libc == "musl" else ""
        return f"bun-linux-{self.arch}{suffix}"


def detect_host_profile() -> HostProfile:
    os_name = platform.system().lower()
    arch_raw = platform.machine().lower()
    arch = {
        "x86_64": "x64",
        "amd64": "x64",
        "aarch64": "arm64",
        "arm64": "arm64",
    }.get(arch_raw, arch_raw)

    if os_name == "linux":
        libc = _detect_libc_linux()
    elif os_name == "darwin":
        libc = "apple"
    elif os_name.startswith("win"):
        libc = "msvc"
    else:
        libc = "unknown"
    return HostProfile(os=os_name, arch=arch, libc=libc)


def _detect_libc_linux() -> str:
    if Path("/etc/alpine-release").exists():
        return "musl"
    try:
        r = subprocess.run(
            ["ldd", "--version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        combined = (r.stdout + r.stderr).lower()
        if "musl" in combined:
            return "musl"
        return "glibc"
    except Exception:
        return "glibc"  # safest default on Linux


def detect_package_manager() -> Optional[str]:
    for mgr in ("apk", "apt-get", "dnf", "yum"):
        if shutil.which(mgr):
            return mgr
    return None


def install_prereqs(mgr: str, *, sudo: bool = False) -> None:
    prefix = ["sudo"] if sudo and os.geteuid() != 0 else []
    if mgr == "apk":
        subprocess.run(prefix + ["apk", "add", "--no-cache", *PREREQ_PACKAGES], check=True)
        return
    if mgr in ("apt-get",):
        subprocess.run(prefix + ["apt-get", "update", "-yq"], check=True)
        subprocess.run(prefix + ["apt-get", "install", "-yq", *PREREQ_PACKAGES], check=True)
        return
    if mgr in ("dnf", "yum"):
        subprocess.run(prefix + [mgr, "install", "-y", *PREREQ_PACKAGES], check=True)
        return
    raise RuntimeError(f"unsupported package manager: {mgr}")


def prereq_install_command(mgr: str) -> str:
    packages = " ".join(PREREQ_PACKAGES)
    if mgr == "apk":
        return f"apk add --no-cache {packages}"
    if mgr == "apt-get":
        return (
            "export DEBIAN_FRONTEND=noninteractive; "
            f"apt-get update -yq && apt-get install -yq {packages}"
        )
    if mgr in {"dnf", "yum"}:
        return f"{mgr} install -y {packages}"
    raise RuntimeError(f"unsupported package manager: {mgr}")


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent.parent.parent


def bun_install_tag(*, source_root: Optional[Path] = None) -> str:
    override = os.environ.get("OPEN_APEX_BUN_VERSION")
    if override:
        return override if override.startswith("bun-v") else f"bun-v{override}"
    source_root = source_root or repo_root()
    pkg = json.loads((source_root / "package.json").read_text())
    package_manager = str(pkg.get("packageManager", "bun@1.3.12"))
    version = package_manager.split("@", 1)[1] if "@" in package_manager else package_manager
    return version if version.startswith("bun-v") else f"bun-v{version}"


def download_release_binary(
    output_path: Path,
    version: str,
    *,
    profile: Optional[HostProfile] = None,
) -> Path:
    profile = profile or detect_host_profile()
    url = profile.release_url(version)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as td:
        zip_path = Path(td) / "open-apex.zip"
        try:
            with urllib.request.urlopen(url) as response, zip_path.open("wb") as handle:
                shutil.copyfileobj(response, handle)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(
                f"release asset unavailable at {url} (HTTP {exc.code})"
            ) from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"failed to download release asset at {url}: {exc}") from exc

        with zipfile.ZipFile(zip_path) as zf:
            members = [name for name in zf.namelist() if not name.endswith("/")]
            binary_member = next(
                (
                    name
                    for name in members
                    if Path(name).name == "open-apex"
                ),
                None,
            )
            if binary_member is None:
                raise RuntimeError(
                    f"release asset at {url} did not contain 'open-apex' binary"
                )
            extracted_path = Path(td) / "open-apex"
            with zf.open(binary_member) as src, extracted_path.open("wb") as dst:
                shutil.copyfileobj(src, dst)
            extracted_path.chmod(
                extracted_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH
            )
            shutil.copy2(extracted_path, output_path)

    output_path.chmod(output_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return output_path


def build_local_binary(
    output_path: Path,
    *,
    profile: Optional[HostProfile] = None,
    source_root: Optional[Path] = None,
) -> Path:
    profile = profile or detect_host_profile()
    source_root = source_root or repo_root()
    entry = source_root / "apps" / "cli" / "src" / "bin.ts"
    if not entry.exists():
        raise RuntimeError(f"local source entry does not exist: {entry}")
    if shutil.which("bun") is None:
        raise RuntimeError("bun is required for local build fallback but was not found on PATH")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "bun",
        "build",
        "--compile",
        "--target",
        profile.bun_target(),
        "--outfile",
        str(output_path),
        str(entry),
    ]
    proc = subprocess.run(
        cmd,
        cwd=source_root,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        stdout = (proc.stdout or "").strip()
        details = stderr or stdout or "unknown bun build failure"
        raise RuntimeError(f"local bun build failed for target {profile.bun_target()}: {details}")

    output_path.chmod(output_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return output_path


def build_local_bundle(
    output_path: Path,
    *,
    source_root: Optional[Path] = None,
) -> Path:
    source_root = source_root or repo_root()
    entry = source_root / "apps" / "cli" / "src" / "bin.ts"
    if not entry.exists():
        raise RuntimeError(f"local source entry does not exist: {entry}")
    if shutil.which("bun") is None:
        raise RuntimeError("bun is required for local bundle fallback but was not found on PATH")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "bun",
        "build",
        "--target",
        "bun",
        "--outfile",
        str(output_path),
        str(entry),
    ]
    proc = subprocess.run(
        cmd,
        cwd=source_root,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        stdout = (proc.stdout or "").strip()
        details = stderr or stdout or "unknown bun build failure"
        raise RuntimeError(f"local bun bundle failed: {details}")

    return output_path


def build_save_runner_bundle(
    output_path: Path,
    *,
    source_root: Optional[Path] = None,
) -> Path:
    source_root = source_root or repo_root()
    entry = source_root / "packages" / "tools" / "src" / "checkpoint" / "save-runner.ts"
    if not entry.exists():
        raise RuntimeError(f"checkpoint save-runner entry does not exist: {entry}")
    if shutil.which("bun") is None:
        raise RuntimeError("bun is required to bundle checkpoint save-runner but was not found on PATH")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "bun",
        "build",
        "--target",
        "bun",
        "--outfile",
        str(output_path),
        str(entry),
    ]
    proc = subprocess.run(
        cmd,
        cwd=source_root,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        stdout = (proc.stdout or "").strip()
        details = stderr or stdout or "unknown bun build failure"
        raise RuntimeError(f"checkpoint save-runner bundle failed: {details}")

    return output_path


def build_exploratory_runner_bundle(
    output_path: Path,
    *,
    source_root: Optional[Path] = None,
) -> Path:
    source_root = source_root or repo_root()
    entry = source_root / "apps" / "cli" / "src" / "exploratory-runner.ts"
    if not entry.exists():
        raise RuntimeError(f"exploratory runner entry does not exist: {entry}")
    if shutil.which("bun") is None:
        raise RuntimeError("bun is required to bundle exploratory runner but was not found on PATH")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "bun",
        "build",
        "--target",
        "bun",
        "--outfile",
        str(output_path),
        str(entry),
    ]
    proc = subprocess.run(
        cmd,
        cwd=source_root,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        stdout = (proc.stdout or "").strip()
        details = stderr or stdout or "unknown bun build failure"
        raise RuntimeError(f"exploratory runner bundle failed: {details}")

    return output_path


def write_dev_wrapper(
    output_path: Path,
    *,
    bundle_path: str,
) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        "\n".join(
            [
                "#!/usr/bin/env sh",
                'if [ -x "$HOME/.bun/bin/bun" ]; then',
                f'  exec "$HOME/.bun/bin/bun" {bundle_path} "$@"',
                "fi",
                f'exec bun {bundle_path} "$@"',
                "",
            ]
        )
    )
    output_path.chmod(0o755)
    return output_path


def sync_runtime_assets(
    config_dir: Path,
    *,
    source_root: Optional[Path] = None,
) -> tuple[Path, Path, Path, Path]:
    source_root = source_root or repo_root()
    presets_dir = config_dir / "presets"
    prompts_dir = config_dir / "prompts"
    appendix_dir = prompts_dir / "appendix"
    recovery_dir = prompts_dir / "recovery"
    runtime_config_dir = config_dir / "config"
    assets_dir = config_dir / "assets"
    web_tree_sitter_dir = assets_dir / "web-tree-sitter"
    grammar_dir = assets_dir / "tree-sitter-wasms" / "out"

    presets_dir.mkdir(parents=True, exist_ok=True)
    appendix_dir.mkdir(parents=True, exist_ok=True)
    recovery_dir.mkdir(parents=True, exist_ok=True)
    runtime_config_dir.mkdir(parents=True, exist_ok=True)
    web_tree_sitter_dir.mkdir(parents=True, exist_ok=True)
    grammar_dir.mkdir(parents=True, exist_ok=True)

    for src in (source_root / "packages" / "config" / "presets").glob("*.json"):
        shutil.copy2(src, presets_dir / src.name)

    source_prompts_root = source_root / "packages" / "core" / "src" / "prompts"
    for src in source_prompts_root.glob("*.md"):
        shutil.copy2(src, prompts_dir / src.name)
    for src in (source_prompts_root / "appendix").glob("*.md"):
        shutil.copy2(src, appendix_dir / src.name)
    # Recovery prompt templates are loaded at runtime by the M4 recovery
    # ladder. They live one directory below the prompt root, so bundling only
    # top-level markdown leaves installed-agent runs looking for
    # /installed-agent/test_failure.md instead of the real recovery path.
    for src in (source_prompts_root / "recovery").glob("*.md"):
        shutil.copy2(src, recovery_dir / src.name)

    # The compiled Bun bundle does not carry arbitrary node_modules WASM files.
    # Package the tree-sitter runtime and grammars into an explicit assets
    # directory that the indexer can resolve through OPEN_APEX_ASSETS_DIR.
    for root in [
        source_root / "node_modules" / "web-tree-sitter",
        *(
            source_root
            / "node_modules"
            / ".bun"
        ).glob("web-tree-sitter@*/node_modules/web-tree-sitter"),
    ]:
        if not root.exists():
            continue
        for src in root.glob("*.wasm"):
            shutil.copy2(src, web_tree_sitter_dir / src.name)

    for root in [
        source_root / "node_modules" / "tree-sitter-wasms" / "out",
        *(
            source_root
            / "node_modules"
            / ".bun"
        ).glob("tree-sitter-wasms@*/node_modules/tree-sitter-wasms/out"),
    ]:
        if not root.exists():
            continue
        for src in root.glob("*.wasm"):
            shutil.copy2(src, grammar_dir / src.name)

    blocklist = source_root / "packages" / "config" / "contamination-blocklist.v1.json"
    if blocklist.exists():
        shutil.copy2(blocklist, runtime_config_dir / blocklist.name)

    return presets_dir, prompts_dir, runtime_config_dir, assets_dir


def prepare_host_binary(
    output_path: Path,
    version: str,
    *,
    profile: Optional[HostProfile] = None,
    dev_fallback: bool = False,
    source_root: Optional[Path] = None,
) -> Path:
    profile = profile or detect_host_profile()
    if dev_fallback:
        return build_local_binary(output_path, profile=profile, source_root=source_root)

    release_error: RuntimeError | None = None
    try:
        return download_release_binary(output_path, version, profile=profile)
    except RuntimeError as exc:
        release_error = exc

    try:
        return build_local_binary(output_path, profile=profile, source_root=source_root)
    except RuntimeError as build_exc:
        raise RuntimeError(
            "failed to provision Open-Apex binary from both release and local build "
            f"(release: {release_error}; local build: {build_exc})"
        ) from build_exc


def install_into(
    target_path: Path,
    version: str,
    *,
    profile: Optional[HostProfile] = None,
    dev_fallback: bool = False,
) -> Path:
    """Download + install the prebuilt binary into target_path/open-apex.

    Returns the installed binary path. Raises on any failure.
    """
    profile = profile or detect_host_profile()
    target_path.mkdir(parents=True, exist_ok=True)
    binary = target_path / "open-apex"

    return prepare_host_binary(
        binary,
        version,
        profile=profile,
        dev_fallback=dev_fallback,
    )


def verify_binary(binary: Path) -> str:
    """Run ``<binary> --version`` as the §3.5.2 sanity check. Returns version string."""
    r = subprocess.run(
        [str(binary), "--version"], capture_output=True, text=True, timeout=10
    )
    if r.returncode != 0:
        raise RuntimeError(
            f"'{binary} --version' failed: exit {r.returncode}, stderr={r.stderr!r}"
        )
    return r.stdout.strip()
