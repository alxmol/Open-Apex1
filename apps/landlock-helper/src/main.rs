//! Landlock helper — best-effort kernel sandbox for Open-Apex exploratory-executor.
//!
//! Locked per §M2 of the build plan:
//!   - Runs before `exec`ing the exploratory subagent's shell command.
//!   - Applies a Landlock ruleset: read-write on <worktree>, read-only elsewhere.
//!   - Silently degrades on kernel < 5.13, Landlock disabled, seccomp blocking
//!     the syscalls, or non-Linux. In those cases the helper exits cleanly after
//!     performing the exec with NO sandbox applied — layers 1 (worktree) and 2
//!     (tool-layer rejection) + layer 4 (post-hoc shadow-git verification) still
//!     provide safety.
//!
//! Usage:
//!   open-apex-landlock-exec --worktree <abs-path> -- <cmd> [args...]
//!
//! On Linux with Landlock ABI >= 1 available, this:
//!   1. Creates a ruleset with fs access rights for read-only access everywhere.
//!   2. Adds a rule allowing read-write for the worktree path.
//!   3. `landlock_restrict_self()` — applies the sandbox to the current
//!      process (and all its descendants).
//!   4. `exec`s the command.
//!
//! Non-Linux builds compile out the landlock bits and just exec.
//!
//! Exit codes:
//!   on success:  replaced by exec()'d command's exit code
//!   on parse error:  2
//!   landlock_unavailable is NOT a failure; the binary logs and exec's without sandbox
//!   failure to exec:  127

use std::env;
use std::ffi::CString;
use std::process::ExitCode;

fn usage() -> ExitCode {
    eprintln!(
        "usage:\n  open-apex-landlock-exec --worktree <abs-path> -- <cmd> [args...]\n  open-apex-landlock-exec --probe"
    );
    ExitCode::from(2)
}

enum Mode {
    Probe,
    Exec { worktree: String, argv: Vec<String> },
}

fn parse_args() -> Result<Mode, ExitCode> {
    let mut args = env::args().skip(1);
    let mut worktree: Option<String> = None;
    let mut argv: Vec<String> = Vec::new();
    let mut probe = false;

    while let Some(arg) = args.next() {
        if arg == "--probe" {
            probe = true;
        } else if arg == "--worktree" {
            worktree = Some(args.next().ok_or_else(|| {
                eprintln!("missing value for --worktree");
                ExitCode::from(2)
            })?);
        } else if arg == "--" {
            argv = args.collect();
            break;
        } else if arg == "--help" || arg == "-h" {
            return Err(usage());
        } else {
            eprintln!("unknown flag: {arg}");
            return Err(ExitCode::from(2));
        }
    }

    if probe {
        return Ok(Mode::Probe);
    }

    let worktree = match worktree {
        Some(w) => w,
        None => {
            eprintln!("missing required --worktree");
            return Err(ExitCode::from(2));
        }
    };
    if argv.is_empty() {
        eprintln!("missing command after '--'");
        return Err(ExitCode::from(2));
    }
    Ok(Mode::Exec { worktree, argv })
}

#[cfg(target_os = "linux")]
fn try_apply_landlock(worktree: &str) -> bool {
    use landlock::{
        ABI, Access, AccessFs, CompatLevel, Compatible, PathBeneath, PathFd, Ruleset,
        RulesetAttr, RulesetCreatedAttr, RulesetStatus,
    };
    use std::path::Path;

    // Probe the current kernel's Landlock ABI. This silently returns 0 if
    // Landlock is unavailable.
    let abi = ABI::new_current();
    if abi == ABI::Unsupported {
        eprintln!("open-apex-landlock-exec: kernel does not support Landlock; degrading to soft isolation");
        return false;
    }

    // Build the ruleset: by default, read-only access filesystem-wide,
    // with a worktree rule that unlocks read+write inside <worktree>.
    let fs_all = AccessFs::from_all(abi);
    let fs_read = AccessFs::from_read(abi);

    let ruleset = match Ruleset::default()
        .set_compatibility(CompatLevel::BestEffort)
        .handle_access(fs_all)
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("open-apex-landlock-exec: ruleset build failed: {e:?}; degrading");
            return false;
        }
    };

    let Ok(worktree_fd) = PathFd::new(Path::new(worktree)) else {
        eprintln!("open-apex-landlock-exec: cannot open worktree path; degrading");
        return false;
    };

    let created = match ruleset.create() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("open-apex-landlock-exec: ruleset create failed: {e:?}; degrading");
            return false;
        }
    };

    let created = match created.add_rule(PathBeneath::new(worktree_fd, fs_all)) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("open-apex-landlock-exec: add_rule(worktree rw) failed: {e:?}; degrading");
            return false;
        }
    };

    let root_fd = match PathFd::new(Path::new("/")) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("open-apex-landlock-exec: cannot open / : {e:?}; degrading");
            return false;
        }
    };
    let created = match created.add_rule(PathBeneath::new(root_fd, fs_read)) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("open-apex-landlock-exec: add_rule(/ ro) failed: {e:?}; degrading");
            return false;
        }
    };

    let status = match created.restrict_self() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("open-apex-landlock-exec: restrict_self failed: {e:?}; degrading");
            return false;
        }
    };
    match status.ruleset {
        RulesetStatus::FullyEnforced => {
            eprintln!("open-apex-landlock-exec: sandbox fully enforced");
            true
        }
        RulesetStatus::PartiallyEnforced => {
            eprintln!("open-apex-landlock-exec: sandbox partially enforced (kernel ABI gap)");
            true
        }
        RulesetStatus::NotEnforced => {
            eprintln!("open-apex-landlock-exec: sandbox NOT enforced; degrading");
            false
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn try_apply_landlock(_worktree: &str) -> bool {
    eprintln!(
        "open-apex-landlock-exec: not running on Linux; degrading to soft isolation"
    );
    false
}

fn exec_cmd(argv: Vec<String>) -> ExitCode {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let mut cmd = std::process::Command::new(&argv[0]);
        cmd.args(&argv[1..]);
        let err = cmd.exec();
        eprintln!("open-apex-landlock-exec: exec failed: {err}");
        ExitCode::from(127)
    }
    #[cfg(not(unix))]
    {
        let _ = argv;
        eprintln!(
            "open-apex-landlock-exec: not supported on non-unix targets"
        );
        ExitCode::from(127)
    }
}

#[cfg(target_os = "linux")]
fn probe_landlock() -> ExitCode {
    use landlock::ABI;
    let abi = ABI::new_current();
    if abi == ABI::Unsupported {
        eprintln!("landlock_unavailable: kernel does not support Landlock");
        ExitCode::from(1)
    } else {
        eprintln!("landlock_available: ABI={abi:?}");
        ExitCode::from(0)
    }
}

#[cfg(not(target_os = "linux"))]
fn probe_landlock() -> ExitCode {
    eprintln!("landlock_unavailable: not running on Linux");
    ExitCode::from(1)
}

fn main() -> ExitCode {
    match parse_args() {
        Ok(Mode::Probe) => probe_landlock(),
        Ok(Mode::Exec { worktree, argv }) => {
            let _sandbox_applied = try_apply_landlock(&worktree);
            // Even if sandbox didn't apply, we still exec — soft isolation
            // layers 1, 2, and 4 are the real backstop. This binary's job is
            // "best effort".
            exec_cmd(argv)
        }
        Err(code) => code,
    }
}

// Silence the unused CString import on platforms where we don't end up using it.
#[allow(dead_code)]
fn _linker_dummy(_: CString) {}
