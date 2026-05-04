/**
 * §7.6.1 data-driven rule table for the permission classifier.
 *
 * Port target: `openai/codex` `codex-rs/shell-command/src/command_safety/`
 * (Apache-2.0). Apache notice for ported files carried in the adjacent
 * CHANGELOG; this TypeScript port covers the ~40 highest-leverage binaries
 * that drive TB2 smoke behaviour. Full 150-command table is a future
 * expansion — the classifier's composition law + unknown-command resolver
 * correctly handles missing rules (UNKNOWN → default-upward).
 *
 * Rule semantics:
 *   - `exec`            match on `path.basename(argv[0])`, case-insensitive on Windows.
 *   - `subcommand`      exact match on argv[1] (for git/docker/kubectl-style binaries).
 *   - `argv_require_absent_flags`  if ANY of these flags appear, the rule doesn't match
 *                       and we fall through to `else_tier`.
 *   - `argv_require_absent_pattern` argv joined must NOT match this regex.
 *   - `tier`            the tier applied when rule matches AND no absent-flag hits.
 *   - `else_tier`       tier to apply when an absent-flag check fires.
 *   - `subcommandRules` optional fine-grained overrides keyed by subcommand.
 */

import type { ClassifierTier } from "./types.ts";

export interface CommandRule {
  exec: string | string[] | RegExp;
  subcommand?: string;
  subcommandRules?: Record<string, SubRule>;
  /** When ANY listed flag is present in argv, promote to `elseTier`. */
  argvRequireAbsentFlags?: string[];
  /** When argv-joined matches this, promote to `elseTier`. */
  argvRequireAbsentPattern?: RegExp;
  tier: ClassifierTier;
  /** Tier to apply when an absent-flag check fires. */
  elseTier?: ClassifierTier;
  /** If true, the matched inner command cannot be elevated via sudo-unwrap. */
  noSudoElevate?: boolean;
  /** Human-readable description for telemetry / denial messages. */
  note?: string;
}

export interface SubRule {
  /** Present-flag list. If present, promote to `elseTier`. */
  argvRequireAbsentFlags?: string[];
  argvRequireAbsentPattern?: RegExp;
  tier: ClassifierTier;
  elseTier?: ClassifierTier;
  note?: string;
}

/**
 * The core rule table. Ordered by risk/frequency; first-matching exec
 * wins. Every tier-assignment is justified in the comment immediately
 * preceding or on the same line as the rule.
 */
export const COMMAND_RULES: CommandRule[] = [
  // ─── READ_ONLY: pure inspection ────────────────────────────────────────
  {
    exec: [
      "ls",
      "pwd",
      "cat",
      "head",
      "tail",
      "wc",
      "sort",
      "uniq",
      "cut",
      "tr",
      "nl",
      "less",
      "more",
    ],
    tier: "READ_ONLY",
    note: "read-only text tools",
  },
  // tail -f is a potentially blocking follow; model should know. Keep READ_ONLY
  // because it doesn't mutate, but note it for long-running observation.
  { exec: "stat", tier: "READ_ONLY" },
  { exec: "file", tier: "READ_ONLY" },
  { exec: ["which", "whereis", "type", "command"], tier: "READ_ONLY" },
  { exec: "cd", tier: "READ_ONLY", note: "shell builtin directory change inside wrapper" },
  {
    exec: ["grep", "egrep", "fgrep"],
    argvRequireAbsentFlags: ["-r", "-R"],
    argvRequireAbsentPattern: /--include-from=|--exclude-from=/,
    tier: "READ_ONLY",
    elseTier: "READ_ONLY", // grep -r is still safe; retain
    note: "grep is read-only even recursive",
  },
  {
    exec: "rg",
    argvRequireAbsentFlags: ["--pre"], // --pre invokes an arbitrary binary → upgrade
    tier: "READ_ONLY",
    elseTier: "MUTATING",
    note: "ripgrep --pre runs arbitrary preprocessor; unsafe",
  },
  {
    exec: "find",
    argvRequireAbsentFlags: ["-exec", "-execdir", "-delete", "-ok", "-okdir"],
    tier: "READ_ONLY",
    elseTier: "DESTRUCTIVE",
    note: "find -exec / -delete are mutation escape hatches",
  },
  {
    exec: ["ps", "top", "htop", "pgrep", "pidof", "lsof", "pstree", "ss", "netstat"],
    tier: "READ_ONLY",
  },
  { exec: ["df", "du", "free", "uptime", "vmstat", "iostat", "nproc"], tier: "READ_ONLY" },
  {
    exec: ["od", "hexdump", "xxd", "sha1sum", "sha256sum", "sha512sum", "md5sum"],
    tier: "READ_ONLY",
    note: "binary / checksum inspection tools",
  },
  {
    exec: [
      "ldd",
      "strings",
      "objdump",
      "readelf",
      "nm",
      "size",
      "ar",
      "ranlib",
      "strip",
      "kpsewhich",
      "isoinfo",
    ],
    tier: "READ_ONLY",
    note: "local binary / TeX inspection tools",
  },
  { exec: ["uname", "arch", "whoami", "id", "hostname", "date"], tier: "READ_ONLY" },
  {
    exec: "env",
    argvRequireAbsentPattern: /=/, // env FOO=bar cmd... is a prefix-set, mutating call chain
    tier: "READ_ONLY",
    elseTier: "MUTATING",
  },
  { exec: ["echo", "printf", "yes", "seq"], tier: "READ_ONLY", note: "pure output" },
  { exec: ["true", "false", ":", "set", "export"], tier: "READ_ONLY" },
  { exec: "basename", tier: "READ_ONLY" },
  { exec: "dirname", tier: "READ_ONLY" },
  { exec: "realpath", tier: "READ_ONLY" },
  { exec: "readlink", tier: "READ_ONLY" },
  { exec: "compgen", tier: "READ_ONLY", note: "shell builtin command discovery" },
  { exec: ["sleep", "wait"], tier: "READ_ONLY" },
  { exec: "tee", tier: "REVERSIBLE", note: "tee writes; classified as write" },
  { exec: ["test", "[", "[["], tier: "READ_ONLY" },
  {
    exec: ["diff", "cmp", "patch"],
    tier: "READ_ONLY",
    note: "diff/cmp inspect; patch apply is handled via apply_patch tool",
  },

  // ─── Git ─────────────────────────────────────────────────────────────────
  {
    exec: "git",
    subcommandRules: {
      status: { tier: "READ_ONLY" },
      log: { tier: "READ_ONLY" },
      show: { tier: "READ_ONLY" },
      diff: { tier: "READ_ONLY" },
      blame: { tier: "READ_ONLY" },
      "rev-parse": { tier: "READ_ONLY" },
      "ls-files": { tier: "READ_ONLY" },
      "ls-tree": { tier: "READ_ONLY" },
      "show-ref": { tier: "READ_ONLY" },
      grep: { tier: "READ_ONLY" },
      "cat-file": { tier: "READ_ONLY" },
      branch: {
        argvRequireAbsentFlags: ["-D", "-d", "--delete", "-M"], // branch -D is destructive
        tier: "READ_ONLY",
        elseTier: "DESTRUCTIVE",
      },
      tag: {
        argvRequireAbsentFlags: ["-d", "--delete"],
        tier: "READ_ONLY",
        elseTier: "DESTRUCTIVE",
      },
      add: { tier: "REVERSIBLE" },
      restore: {
        argvRequireAbsentFlags: ["--worktree", "-W"],
        tier: "REVERSIBLE",
        elseTier: "DESTRUCTIVE", // --worktree wipes working tree copy
      },
      commit: { tier: "REVERSIBLE" },
      checkout: {
        argvRequireAbsentPattern: /\s(?:--force|-f)\b/,
        tier: "REVERSIBLE",
        elseTier: "DESTRUCTIVE",
      },
      switch: { tier: "REVERSIBLE" },
      stash: { tier: "REVERSIBLE" },
      merge: {
        argvRequireAbsentFlags: ["--abort", "--no-commit"],
        tier: "REVERSIBLE",
        elseTier: "REVERSIBLE",
      },
      rebase: { tier: "REVERSIBLE" },
      cherry: { tier: "READ_ONLY" },
      "cherry-pick": { tier: "REVERSIBLE" },
      fetch: { tier: "MUTATING", note: "network" },
      pull: { tier: "MUTATING", note: "network + working-tree merge" },
      push: {
        // --force handled by CATASTROPHIC regex for protected branches; non-protected still DESTRUCTIVE.
        argvRequireAbsentFlags: ["--force", "-f", "--force-with-lease", "--mirror"],
        tier: "MUTATING",
        elseTier: "DESTRUCTIVE",
      },
      clone: { tier: "MUTATING" },
      remote: { tier: "MUTATING" },
      init: { tier: "REVERSIBLE" },
      config: { tier: "REVERSIBLE" },
      worktree: { tier: "REVERSIBLE" },
      reset: {
        argvRequireAbsentFlags: ["--hard"],
        tier: "REVERSIBLE",
        elseTier: "DESTRUCTIVE",
      },
      clean: {
        argvRequireAbsentFlags: ["-f", "--force", "-d", "-x", "-X"],
        tier: "REVERSIBLE",
        elseTier: "DESTRUCTIVE",
      },
    },
    tier: "MUTATING", // fallback for uncataloged git subcommands
  },

  // ─── Package managers ────────────────────────────────────────────────────
  {
    exec: "npm",
    subcommandRules: {
      test: { tier: "REVERSIBLE" },
      run: { tier: "REVERSIBLE" },
      ci: { tier: "REVERSIBLE" },
      install: {
        argvRequireAbsentFlags: ["-g", "--global"],
        tier: "REVERSIBLE",
        elseTier: "MUTATING",
      },
      uninstall: {
        argvRequireAbsentFlags: ["-g", "--global"],
        tier: "REVERSIBLE",
        elseTier: "MUTATING",
      },
      publish: { tier: "DESTRUCTIVE", note: "publishing cannot be unpublished reliably" },
      audit: { tier: "READ_ONLY" },
      list: { tier: "READ_ONLY" },
      ls: { tier: "READ_ONLY" },
      outdated: { tier: "READ_ONLY" },
      view: { tier: "READ_ONLY" },
      init: { tier: "REVERSIBLE" },
    },
    tier: "REVERSIBLE",
  },
  { exec: "npx", tier: "MUTATING", note: "npx runs arbitrary downloaded packages" },
  { exec: "yarn", tier: "REVERSIBLE" },
  { exec: "pnpm", tier: "REVERSIBLE" },
  { exec: "bun", tier: "REVERSIBLE" },
  { exec: "deno", tier: "REVERSIBLE" },
  {
    exec: "pip",
    subcommand: "install",
    argvRequireAbsentFlags: ["--user"],
    tier: "REVERSIBLE",
    elseTier: "MUTATING",
  },
  {
    exec: "pip3",
    subcommand: "install",
    argvRequireAbsentFlags: ["--user"],
    tier: "REVERSIBLE",
    elseTier: "MUTATING",
  },
  { exec: "pip", tier: "REVERSIBLE", note: "pip list/show/uninstall within venv are reversible" },
  { exec: "pip3", tier: "REVERSIBLE" },
  { exec: "uv", tier: "REVERSIBLE" },
  { exec: "poetry", tier: "REVERSIBLE" },
  { exec: "pipenv", tier: "REVERSIBLE" },
  { exec: "gem", tier: "MUTATING", note: "gem install touches system unless with --user" },
  { exec: "bundle", tier: "REVERSIBLE" },
  { exec: "cargo", tier: "REVERSIBLE" },
  { exec: "rustup", tier: "MUTATING" },
  { exec: "go", tier: "REVERSIBLE" },
  { exec: "make", tier: "REVERSIBLE" },
  { exec: "cmake", tier: "REVERSIBLE" },
  { exec: "ninja", tier: "REVERSIBLE" },
  { exec: "meson", tier: "REVERSIBLE" },
  { exec: "protoc", tier: "REVERSIBLE" },
  { exec: ["zig", "cobc"], tier: "REVERSIBLE" },
  { exec: "pkg-config", tier: "READ_ONLY" },
  {
    exec: [
      "gcc",
      "g++",
      "cc",
      "c++",
      "clang",
      "clang++",
      "cpp",
      "ld",
      "as",
      "autoconf",
      "automake",
      "autoreconf",
      "configure",
    ],
    tier: "REVERSIBLE",
  },
  { exec: ["install"], tier: "REVERSIBLE", note: "GNU install copies workspace artifacts" },
  { exec: ["mvn", "gradle", "ant"], tier: "REVERSIBLE" },
  { exec: ["sbt", "lein"], tier: "REVERSIBLE" },
  { exec: ["composer"], tier: "REVERSIBLE" },

  // ─── Linters / formatters / testers ──────────────────────────────────────
  {
    exec: ["tsc", "eslint", "prettier", "biome"],
    tier: "REVERSIBLE",
    note: "lint + format; --write is intentional",
  },
  {
    exec: ["ruff", "black", "isort", "flake8", "pylint", "mypy", "pyright", "pyre"],
    tier: "REVERSIBLE",
  },
  { exec: ["pytest", "unittest", "nose", "nose2", "tox"], tier: "REVERSIBLE" },
  { exec: ["jest", "vitest", "mocha", "ava", "tap", "playwright", "cypress"], tier: "REVERSIBLE" },
  { exec: "rspec", tier: "REVERSIBLE" },
  { exec: "rubocop", tier: "REVERSIBLE" },
  { exec: "gofmt", tier: "REVERSIBLE" },
  { exec: "golint", tier: "READ_ONLY" },
  { exec: "rustfmt", tier: "REVERSIBLE" },
  { exec: "clippy", tier: "READ_ONLY" },

  // ─── System / OS package managers ────────────────────────────────────────
  {
    exec: ["apt", "apt-get", "dpkg", "yum", "dnf", "zypper", "pacman", "apk", "brew"],
    tier: "MUTATING",
    note: "OS package install touches system",
  },
  { exec: "apt-cache", tier: "READ_ONLY", note: "Debian package metadata inspection" },
  {
    exec: ["dpkg-source", "dpkg-buildpackage", "debuild"],
    tier: "REVERSIBLE",
    note: "Debian source/build tooling writes workspace files",
  },
  { exec: ["systemctl", "service"], tier: "MUTATING" },
  {
    exec: "ldconfig",
    tier: "MUTATING",
    note: "updates or inspects the system dynamic linker cache",
  },
  {
    exec: "nginx",
    subcommandRules: {
      "-t": { tier: "READ_ONLY" },
      "-v": { tier: "READ_ONLY" },
      "-V": { tier: "READ_ONLY" },
    },
    tier: "MUTATING",
    note: "nginx test/version are read-only; start/reload/signal mutates service state",
  },
  {
    exec: ["chmod", "chown"],
    tier: "REVERSIBLE",
    note: "mode changes in workspace; CATASTROPHIC regex catches system-path -R",
  },
  { exec: ["mkdir"], tier: "REVERSIBLE" },
  { exec: ["touch"], tier: "REVERSIBLE" },
  {
    exec: "cp",
    argvRequireAbsentFlags: ["-f", "--force"],
    tier: "REVERSIBLE",
    elseTier: "DESTRUCTIVE",
  },
  {
    exec: "mv",
    argvRequireAbsentFlags: ["-f", "--force"],
    tier: "REVERSIBLE",
    elseTier: "DESTRUCTIVE",
  },
  {
    exec: "rm",
    // The CATASTROPHIC regex catches rm -rf / etc. Any rm is DESTRUCTIVE below that.
    tier: "DESTRUCTIVE",
  },
  { exec: "unlink", tier: "DESTRUCTIVE" },
  { exec: "rmdir", tier: "REVERSIBLE" },
  { exec: ["ln"], tier: "REVERSIBLE" },
  {
    exec: "tar",
    // tar without -x is READ_ONLY (create/list), -x extracts (REVERSIBLE)
    tier: "REVERSIBLE",
  },
  {
    exec: ["zip", "unzip", "gzip", "gunzip", "bzip2", "xz", "uncompress"],
    tier: "REVERSIBLE",
  },
  {
    exec: ["zcat", "xzcat"],
    tier: "READ_ONLY",
    note: "compressed stream inspection",
  },
  {
    exec: ["bsdtar", "7z", "7zz", "7za", "xorriso"],
    tier: "REVERSIBLE",
    note: "archive/ISO inspection or extraction helpers; may write outputs",
  },
  {
    exec: ["mtype", "mdir", "minfo"],
    tier: "READ_ONLY",
    note: "mtools read-only DOS image inspection",
  },
  {
    exec: ["mcopy", "mmd", "mdel", "mren", "mattrib"],
    tier: "REVERSIBLE",
    note: "mtools image edits are reversible within task-local disk copies",
  },
  {
    exec: ["fdisk", "sfdisk", "gdisk", "parted"],
    subcommandRules: {
      "-l": { tier: "READ_ONLY" },
    },
    tier: "MUTATING",
    note: "partition inspection is read-only; non-listing operations may mutate images/devices",
  },
  {
    exec: ["mount", "umount"],
    tier: "MUTATING",
    note: "mount namespace changes are runtime mutations",
  },

  // ─── Network / HTTP ─────────────────────────────────────────────────────
  // curl / wget are tiered by the network analyzer (network.ts); these fallback rules
  // provide a safe default when the analyzer can't resolve a method.
  {
    exec: ["curl", "wget", "httpie", "http", "xh", "aria2c", "fetch"],
    tier: "MUTATING",
    note: "defer to HTTP-method analyzer; MUTATING is the safe default",
  },
  {
    exec: "ssh",
    argvRequireAbsentFlags: ["-V", "-G"],
    tier: "MUTATING",
    elseTier: "READ_ONLY",
    note: "ssh can execute remote commands; -V/-G are local inspection only",
  },
  {
    exec: ["nc", "netcat", "telnet", "socat"],
    tier: "MUTATING",
    note: "socket clients can send data or control local services",
  },
  {
    exec: "vncsnapshot",
    tier: "READ_ONLY_NETWORK",
    note: "VNC screenshot capture reads from a local/remote display",
  },
  {
    exec: "websockify",
    tier: "MUTATING",
    note: "websockify opens proxy/listener processes",
  },

  // ─── Container / cloud ─────────────────────────────────────────────────
  {
    exec: "docker",
    subcommandRules: {
      ps: { tier: "READ_ONLY" },
      images: { tier: "READ_ONLY" },
      inspect: { tier: "READ_ONLY" },
      logs: { tier: "READ_ONLY" },
      version: { tier: "READ_ONLY" },
      info: { tier: "READ_ONLY" },
      pull: { tier: "MUTATING" },
      build: { tier: "MUTATING" },
      run: { tier: "MUTATING" },
      exec: { tier: "MUTATING" },
      stop: { tier: "MUTATING" },
      start: { tier: "MUTATING" },
      restart: { tier: "MUTATING" },
      rm: { tier: "DESTRUCTIVE" },
      rmi: { tier: "DESTRUCTIVE" },
      kill: { tier: "DESTRUCTIVE" },
      prune: { tier: "DESTRUCTIVE" },
      "system prune": { tier: "DESTRUCTIVE" },
    },
    tier: "MUTATING",
  },
  {
    exec: "podman",
    subcommandRules: {
      ps: { tier: "READ_ONLY" },
      images: { tier: "READ_ONLY" },
      inspect: { tier: "READ_ONLY" },
      logs: { tier: "READ_ONLY" },
      version: { tier: "READ_ONLY" },
      info: { tier: "READ_ONLY" },
      pull: { tier: "MUTATING" },
      build: { tier: "MUTATING" },
      run: { tier: "MUTATING" },
      exec: { tier: "MUTATING" },
      stop: { tier: "MUTATING" },
      start: { tier: "MUTATING" },
      restart: { tier: "MUTATING" },
      rm: { tier: "DESTRUCTIVE" },
      rmi: { tier: "DESTRUCTIVE" },
      kill: { tier: "DESTRUCTIVE" },
      prune: { tier: "DESTRUCTIVE" },
      "system prune": { tier: "DESTRUCTIVE" },
    },
    tier: "MUTATING",
  },
  {
    exec: "kubectl",
    subcommandRules: {
      get: { tier: "READ_ONLY" },
      describe: { tier: "READ_ONLY" },
      logs: { tier: "READ_ONLY" },
      explain: { tier: "READ_ONLY" },
      version: { tier: "READ_ONLY" },
      apply: { tier: "MUTATING" },
      create: { tier: "MUTATING" },
      delete: { tier: "DESTRUCTIVE" },
      run: { tier: "MUTATING" },
      rollout: { tier: "MUTATING" },
      scale: { tier: "MUTATING" },
    },
    tier: "MUTATING",
  },

  // ─── Script interpreters ────────────────────────────────────────────────
  // These are NEVER auto-approvable via allowlist — they can execute arbitrary code.
  { exec: ["python", "python3"], tier: "MUTATING", noSudoElevate: false },
  { exec: ["ruby", "perl", "php", "lua"], tier: "MUTATING" },
  { exec: ["node", "deno", "bun"], tier: "MUTATING" },
  { exec: ["java", "R", "Rscript"], tier: "MUTATING" },
  {
    exec: ["pdflatex", "latexmk", "bibtex", "povray", "pmars"],
    tier: "REVERSIBLE",
    note: "local render / benchmark executables that write workspace outputs",
  },
  {
    exec: /^qemu-system-/,
    tier: "MUTATING",
    note: "QEMU VM launch may create processes, sockets, disks, and network listeners",
  },
  {
    exec: ["qemu-img", "qemu-io", "qemu-nbd", "qemu-storage-daemon", "qemu-pr-helper"],
    tier: "MUTATING",
    note: "QEMU image/device helpers may mutate disk images or attach local services",
  },
  {
    exec: ["pdftotext", "pdfinfo", "pdfimages", "mutool", "qpdf"],
    tier: "REVERSIBLE",
    note: "PDF inspection/extraction tools; may write local outputs",
  },
  {
    exec: ["ffmpeg", "ffprobe", "convert", "magick", "identify"],
    tier: "REVERSIBLE",
    note: "media inspection/conversion tools; may write local outputs",
  },
  { exec: ["awk", "sed"], tier: "REVERSIBLE" },
  {
    exec: "strace",
    tier: "MUTATING",
    note: "strace launches or attaches to processes and writes traces",
  },
  {
    exec: ["pkill", "killall"],
    tier: "MUTATING",
    note: "process termination mutates runtime state",
  },
  {
    exec: "tmux",
    tier: "MUTATING",
    note: "tmux creates or controls terminal server sessions",
  },

  // ─── Shell wrappers (handled specially; included so unknown-command won't fire) ──
  {
    exec: ["bash", "sh", "zsh", "ksh", "dash", "fish", "pwsh", "powershell"],
    tier: "MUTATING",
    note: "handled by composition law",
  },

  // ─── Databases ─────────────────────────────────────────────────────────
  {
    exec: ["psql", "mysql", "mysqldump", "sqlite3", "mongosh", "mongo", "redis-cli"],
    tier: "MUTATING",
    note: "heredoc bodies scanned for destructive SQL by composition law",
  },

  // ─── Process helpers that we pass-through ──────────────────────────────
  {
    exec: ["timeout", "nice", "nohup", "stdbuf", "xargs"],
    tier: "READ_ONLY",
    note: "stripped by composition law before rule lookup",
  },
  {
    exec: ["watch", "setsid", "flock", "direnv", "devbox", "mise"],
    tier: "READ_ONLY",
    note: "NOT stripped; classified as READ_ONLY themselves",
  },
];
