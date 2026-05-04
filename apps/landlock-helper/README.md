# open-apex-landlock-exec

Linux Landlock best-effort kernel sandbox helper.

Part of the Open-Apex Milestone 2 exploratory-executor isolation stack
(§M2 of `open-apex-build-plan.md`). Silently degrades on non-Linux, kernel
< 5.13, or when seccomp blocks the required syscalls.

## Build

```bash
# On Linux:
cargo build --release
# Output: target/release/open-apex-landlock-exec

# On macOS (for dev):
cargo check --target x86_64-unknown-linux-gnu
```

The binary is only built on Linux CI runners; it is not shipped from macOS
dev machines. At Milestone 2 the build and integration tests land on
Ubuntu 24.04 runners.

## Usage

```bash
open-apex-landlock-exec --worktree /tmp/open-apex-explore-<run_id> -- \
    bash -c 'python run_tests.py'
```

The helper:

1. Probes Landlock ABI. On unsupported kernels, logs and exec's without sandbox.
2. If supported: creates a ruleset with read-only access everywhere, read-write
   within `<worktree>`.
3. `restrict_self()` — applies the sandbox to the current process and all
   descendants.
4. `exec`s the command — the sandbox follows into the child process.

## Exit codes

- Replaced by the exec'd command's exit code on success.
- `2` — argument parse error.
- `127` — exec failure.

Sandbox-application failure is NOT a fatal error. The binary logs and exec's
without the sandbox. Open-Apex's M2 design uses four layers of isolation:

1. Structural (git worktree pinned to pre-exploration checkpoint).
2. Tool-layer (argv-level path rejection).
3. Kernel-layer (this binary, when available).
4. Post-hoc verification (shadow-git diff).

Layer 3 is the only best-effort layer; layers 1, 2, and 4 are always on.
