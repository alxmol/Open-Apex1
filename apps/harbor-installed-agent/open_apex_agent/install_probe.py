"""Install-probe script.

Usage:
  uv run python -m open_apex_agent.install_probe [--dev-fallback]

Validates:
  - Host profile detection works on this OS/arch.
  - Dev fallback can install a working shim that responds to --version.

This is a test utility, not part of the Harbor contract.
"""

from __future__ import annotations

import argparse
import tempfile
from pathlib import Path

from .install import detect_host_profile, install_into, verify_binary


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dev-fallback", action="store_true", default=False)
    parser.add_argument("--version", default="0.0.1")
    args = parser.parse_args()

    profile = detect_host_profile()
    print(f"host profile: os={profile.os} arch={profile.arch} libc={profile.libc}")

    with tempfile.TemporaryDirectory() as td:
        target = Path(td)
        binary = install_into(
            target,
            args.version,
            profile=profile,
            dev_fallback=args.dev_fallback,
        )
        print(f"installed: {binary}")
        version = verify_binary(binary)
        print(f"binary --version: {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
