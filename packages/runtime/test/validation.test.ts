import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import type { ValidationResult, ValidatorRun } from "@open-apex/core";

import {
  discoverMinimalSafeFallback,
  discoverValidators,
  extractFromInstruction,
  routeValidation,
  runValidator,
  sanitizeValidatorCandidate,
} from "../src/validation/index.ts";

function mkWs(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "oa-val-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    const parent = path.dirname(abs);
    require("node:fs").mkdirSync(parent, { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
}

describe("discoverMinimalSafeFallback (§7.6.2)", () => {
  test("tsconfig.json → npx tsc --noEmit candidate", async () => {
    const ws = mkWs({ "tsconfig.json": "{}", "src/a.ts": "const x = 1;" });
    const candidates = await discoverMinimalSafeFallback(ws);
    expect(candidates.some((c) => c.candidate.command === "npx tsc --noEmit")).toBe(true);
  });

  test(".py files → py_compile candidate", async () => {
    const ws = mkWs({ "main.py": "x = 1\n" });
    const candidates = await discoverMinimalSafeFallback(ws);
    expect(candidates.some((c) => c.candidate.command.includes("python3 -m py_compile"))).toBe(
      true,
    );
  });

  test("Cargo.toml → cargo check", async () => {
    const ws = mkWs({ "Cargo.toml": '[package]\nname = "x"\n' });
    const candidates = await discoverMinimalSafeFallback(ws);
    expect(candidates.some((c) => c.candidate.command === "cargo check --all-targets")).toBe(true);
  });

  test("go.mod → go vet + go build", async () => {
    const ws = mkWs({ "go.mod": "module x\n" });
    const candidates = await discoverMinimalSafeFallback(ws);
    expect(candidates.some((c) => c.candidate.command === "go vet ./...")).toBe(true);
    expect(candidates.some((c) => c.candidate.command === "go build ./...")).toBe(true);
  });

  test("empty workspace → no candidates", async () => {
    const ws = mkWs();
    const candidates = await discoverMinimalSafeFallback(ws);
    expect(candidates.length).toBe(0);
  });

  test("all candidates emit source=minimal_safe_fallback with low confidence", async () => {
    const ws = mkWs({ "tsconfig.json": "{}", "main.py": "x=1\n" });
    const candidates = await discoverMinimalSafeFallback(ws);
    for (const c of candidates) {
      expect(c.candidate.source).toBe("minimal_safe_fallback");
      expect(c.candidate.confidence).toBe("low");
    }
  });

  test("suppresses fallback validators when required interpreters are unavailable", async () => {
    const ws = mkWs({
      "tsconfig.json": "{}",
      "main.py": "x = 1\n",
      "script.rb": "puts 'x'\n",
    });
    const candidates = await discoverMinimalSafeFallback(ws, {
      commandExists: () => false,
    });
    expect(candidates.length).toBe(0);
  });
});

describe("extractFromInstruction", () => {
  test("backtick-quoted test command → high-confidence candidate", () => {
    const out = extractFromInstruction("Please verify your fix by running `pytest -q`.");
    expect(out.length).toBe(1);
    expect(out[0]?.command).toBe("pytest -q");
    expect(out[0]?.confidence).toBe("high");
  });

  test("backtick command without test/check/build kw is ignored", () => {
    const out = extractFromInstruction("use `echo hello` to say hi");
    expect(out.length).toBe(0);
  });

  test("backtick sanity commands near verifier prose become high-confidence validators", () => {
    const pmars = extractFromInstruction(
      "As a sanity check, `pmars -r 1000 warrior.red` should complete successfully.",
    );
    expect(pmars[0]?.command).toBe("pmars -r 1000 warrior.red");
    expect(pmars[0]?.confidence).toBe("high");

    const povray = extractFromInstruction(
      "We will verify the scene with `povray +Iscene.pov +Oout.png +W64 +H64`; this should output a PNG.",
    );
    expect(povray[0]?.command).toBe("povray +Iscene.pov +Oout.png +W64 +H64");
    expect(povray[0]?.confidence).toBe("high");
  });

  test("nearby verifier prose does not promote path-only or data-file backticks", () => {
    const out = extractFromInstruction(
      [
        "Clone the project into `/app/pyknotid` and inspect `/app/deps/illum1.pov`.",
        "We will verify the build later with the hidden tests.",
        "The workspace root is `/app`.",
      ].join(" "),
    );

    expect(out.map((candidate) => candidate.command)).not.toContain("/app");
    expect(out.map((candidate) => candidate.command)).not.toContain("/app/pyknotid");
    expect(out.map((candidate) => candidate.command)).not.toContain("/app/deps/illum1.pov");
  });

  test("sanitizer rejects path-only/data/setup validators but allows real sanity commands", () => {
    expect(
      sanitizeValidatorCandidate({
        command: "/app/povray-2.2",
        confidence: "high",
        source: "task_instruction",
        justification: "",
      }),
    ).toEqual({ ok: false, reason: "path_only" });
    expect(
      sanitizeValidatorCandidate({
        command: "/app/deps/illum1.pov",
        confidence: "high",
        source: "task_instruction",
        justification: "",
      }),
    ).toEqual({ ok: false, reason: "data_file" });
    expect(
      sanitizeValidatorCandidate({
        command: "git clone https://example.com/repo /app/repo",
        confidence: "high",
        source: "task_instruction",
        justification: "",
      }),
    ).toEqual({ ok: false, reason: "setup_command" });
    expect(
      sanitizeValidatorCandidate({
        command: "pmars -r 1000 warrior.red",
        confidence: "high",
        source: "task_instruction",
        justification: "",
      }),
    ).toEqual({ ok: true });
  });

  test("'run the tests' with no concrete command → low-confidence hint", () => {
    const out = extractFromInstruction("Fix the bug and run the tests.");
    expect(out.length).toBe(1);
    expect(out[0]?.confidence).toBe("low");
  });

  test("output-file probes remain low-confidence internal routing signals", () => {
    const out = extractFromInstruction("Write the output to /app/out.txt.");
    expect(out[0]?.command).toBe("test -s /app/out.txt");
    expect(out[0]?.confidence).toBe("low");
  });
});

describe("discoverValidators full §7.6.2 ladder", () => {
  test("concrete instruction validator short-circuits lower rungs", async () => {
    const ws = mkWs({ "tsconfig.json": "{}" });
    const r = await discoverValidators({
      workspace: ws,
      taskInstruction: "run `bun test` to verify",
    });
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0]?.source).toBe("task_instruction");
  });

  test("empty workspace + no instruction → zero candidates", async () => {
    const r = await discoverValidators({ workspace: mkWs() });
    expect(r.candidates.length).toBe(0);
  });

  test("workspace-local run_tests.sh short-circuits lower rungs (rung 5 promoted)", async () => {
    const ws = mkWs({
      "run_tests.sh": "#!/usr/bin/env bash\nexit 0\n",
      "tsconfig.json": "{}",
    });
    const r = await discoverValidators({ workspace: ws });
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0]?.confidence).toBe("high");
    expect(r.candidates[0]?.command).toBe("bash ./run_tests.sh");
  });

  test("workspace-local Python verifier scripts outrank weak output-file probes", async () => {
    const ws = mkWs({
      "test_outputs.py": "def test_output(): assert True\n",
      "out.txt": "placeholder\n",
    });
    const r = await discoverValidators({
      workspace: ws,
      taskInstruction: "Write the decoded text to /app/out.txt",
    });
    expect(r.candidates[0]?.command).toBe("python3 -m pytest ./test_outputs.py -q");
    expect(r.candidates[0]?.confidence).toBe("high");
    expect(r.candidates[0]?.source).toBe("harbor_task_convention");
    expect(r.candidates.some((c) => c.command === "test -s /app/out.txt")).toBe(false);
  });

  test("workspace-local verify.py is treated as a high-confidence validator", async () => {
    const ws = mkWs({ "verify.py": "print('ok')\n" });
    const r = await discoverValidators({ workspace: ws });
    expect(r.candidates[0]?.command).toBe("python3 ./verify.py");
    expect(r.candidates[0]?.confidence).toBe("high");
  });

  test("package.json scripts.test discovered via repo manifest rung", async () => {
    const ws = mkWs({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
    });
    const r = await discoverValidators({ workspace: ws });
    const manifest = r.candidates.find((c) => c.source === "repo_manifest");
    expect(manifest).toBeDefined();
    expect(manifest?.command).toBe("npm run test --silent");
  });

  test("Makefile test target discovered", async () => {
    const ws = mkWs({ Makefile: "test:\n\techo ok\n" });
    const r = await discoverValidators({ workspace: ws });
    const make = r.candidates.find((c) => c.command === "make test");
    expect(make).toBeDefined();
    expect(make?.source).toBe("repo_manifest");
  });

  test("pytest config triggers framework convention rung", async () => {
    const ws = mkWs({
      "pytest.ini": "[pytest]\n",
      "tests/test_a.py": "def test_ok(): assert True\n",
    });
    const r = await discoverValidators({ workspace: ws });
    const pytest = r.candidates.find((c) => c.command === "python3 -m pytest -q");
    expect(pytest).toBeDefined();
  });

  test("file-existence claim in instruction yields LOW-confidence probe (§gcode-to-text downgrade)", async () => {
    // Regression: file-existence probes were `high` confidence, which meant
    // `test -s /app/out.txt` passing counted as a full validation. The
    // TB2 gcode-to-text trial exploited this: agent hallucinated a flag
    // string into the claimed path, our validator passed, Harbor rejected.
    // Fix: emit at `low` confidence so the completion-policy can downgrade
    // an all-file-existence pass-set to validation_unknown.
    const ws = mkWs();
    const r = await discoverValidators({
      workspace: ws,
      taskInstruction: "Write the output to /app/out.txt",
    });
    const probe = r.candidates.find((c) => c.command.startsWith("test -s /app/out.txt"));
    expect(probe).toBeDefined();
    expect(probe?.confidence).toBe("low");
    expect(probe?.justification).toContain("content not validated");
  });

  test("port claim in instruction yields curl probe", async () => {
    const ws = mkWs();
    const r = await discoverValidators({
      workspace: ws,
      taskInstruction: "The service should run on port 5000 and respond at /sentiment.",
    });
    const probe = r.candidates.find((c) => c.command.includes("127.0.0.1:5000"));
    expect(probe).toBeDefined();
  });

  test("port claim with explicit URL path probes that specific path, not just /", async () => {
    const ws = mkWs();
    const r = await discoverValidators({
      workspace: ws,
      taskInstruction:
        'And have this data then be pushed to a webserver running on port 8080 so if I run curl http://server:8080/hello.html then I see the output "hello world".',
    });
    const probe = r.candidates.find(
      (c) => c.command.includes("127.0.0.1:8080") && c.command.includes("/hello.html"),
    );
    expect(probe).toBeDefined();
    // Should NOT emit a plain `/` probe when a specific path is given.
    const rootOnly = r.candidates.find(
      (c) =>
        c.command.includes("127.0.0.1:8080/") &&
        !c.command.includes("/hello.html") &&
        c.command.includes("| grep -qE '^[234]'"),
    );
    expect(rootOnly).toBeUndefined();
  });

  test("bare pdflatex binary in prose triggers a pdflatex probe (overfull-hbox case)", async () => {
    const ws = mkWs({ "main.tex": "\\documentclass{article}\\begin{document}x\\end{document}\n" });
    const r = await discoverValidators({
      workspace: ws,
      taskInstruction:
        'Ensure that the LaTeX document main.tex compiles successfully using the installed TeX distribution and pdflatex compiler with no "overfull hbox" warnings.',
    });
    const probe = r.candidates.find((c) => c.command.startsWith("pdflatex"));
    expect(probe).toBeDefined();
    expect(probe?.command).toContain("main.tex");
  });

  test("bare pytest/cargo test/go test/make test in prose each trigger their probe", async () => {
    for (const [instr, expected] of [
      ["Run pytest to verify.", "python3 -m pytest -q"],
      ["Please run cargo test after your change.", "cargo test --all-targets"],
      ["Make sure go test ./... passes.", "go test ./..."],
      ["Run make test before declaring success.", "make test"],
      ["Use npm test for validation.", "npm test --silent"],
    ] as const) {
      const r = await discoverValidators({
        workspace: mkWs(),
        taskInstruction: instr,
      });
      const match = r.candidates.find((c) => c.command === expected);
      expect(match).toBeDefined();
      expect(match?.source).toBe("task_instruction");
    }
  });

  test("port probes accept 2xx/3xx/4xx; reject 5xx and curl-transport errors (§hf-model-inference refinement)", async () => {
    // Regression: our previous probe `| grep -qE '^[23]'` false-negatived
    // hf-model-inference because `POST /sentiment` with empty body
    // correctly returns 400 ("missing required text field"). Harbor's
    // verifier sends a valid payload (2xx), but our probe got 4xx and
    // marked the task as failed even though the agent's endpoint WORKED.
    // Fix: `| grep -qE '^[234]'` — 4xx means the server is up and
    // validating input, which is pass for our purposes.
    const ws = mkWs();
    const r = await discoverValidators({
      workspace: ws,
      taskInstruction: "The service runs on port 5000 and responds to POST /predict",
    });
    const probe = r.candidates.find((c) => c.command.includes("127.0.0.1:5000"));
    expect(probe).toBeDefined();
    expect(probe!.command).toContain("grep -qE '^[234]'");
    expect(probe!.command).not.toContain("grep -qE '^[23]'");

    // End-to-end: simulate curl returning each status class and verify
    // our grep logic pass/fail correctly.
    const passCases = ["200", "201", "301", "302", "400", "404", "422"];
    const failCases = ["500", "502", "503", "000" /* curl transport error */];
    for (const code of passCases) {
      const v = await runValidator(
        {
          command: `echo ${code} | grep -qE '^[234]'`,
          confidence: "medium",
          source: "task_instruction",
          justification: "",
        },
        { workspace: ws },
      );
      expect({ code, status: v.validatorStatus }).toEqual({ code, status: "pass" });
    }
    for (const code of failCases) {
      const v = await runValidator(
        {
          command: `echo ${code} | grep -qE '^[234]'`,
          confidence: "medium",
          source: "task_instruction",
          justification: "",
        },
        { workspace: ws },
      );
      expect({ code, status: v.validatorStatus }).toEqual({ code, status: "fail" });
    }
  }, 10_000);

  test("Endpoint: POST /path phrasing yields a POST probe (§hf-model-inference case)", async () => {
    // TB2 hf-model-inference instruction had:
    //   "API Schema: Endpoint: POST /sentiment ...
    //    The service should run on port 5000"
    // Previous extractor only looked at `curl http://host:port/path` strings,
    // not prose "Endpoint: METHOD /path" declarations — so the probe hit
    // `/` on port 5000 and got 404. Harbor's verifier passed, our internal
    // validator failed. Fix: parse endpoint declarations and upgrade the
    // port probe to a POST against the declared path.
    const ws = mkWs();
    const r = await discoverValidators({
      workspace: ws,
      taskInstruction: "The service should run on port 5000. API Schema: Endpoint: POST /sentiment",
    });
    const probe = r.candidates.find(
      (c) => c.command.includes("127.0.0.1:5000") && c.command.includes("/sentiment"),
    );
    expect(probe).toBeDefined();
    expect(probe?.command).toContain("-X POST");
  });

  test("Hugging Face model-cache tasks get a loadability validator", async () => {
    const ws = mkWs();
    const r = await discoverValidators({
      workspace: ws,
      taskInstruction:
        "Save the Hugging Face sentiment model to /app/model_cache/sentiment_model and serve POST /sentiment on port 5000.",
    });
    const loadValidator = r.candidates.find((c) => c.command.includes("from_pretrained"));
    expect(loadValidator).toBeDefined();
    expect(loadValidator?.command).toContain("/app/model_cache/sentiment_model");
  });

  test("overfull-hbox warning forbid + pdflatex emits a log-grep validator (§overfull-hbox case)", async () => {
    // TB2 overfull-hbox trial: `pdflatex -halt-on-error` exits 0 on
    // overfull-hbox warnings (they're not errors), so our probe passed
    // while Harbor's verifier greps the log for "Overfull \\hbox" and
    // rejected. Fix: when the prompt explicitly forbids a warning keyword
    // near a compile command, emit a secondary validator that scans the
    // compiler output for the keyword and fails if it appears.
    const ws = mkWs({ "main.tex": "\\documentclass{article}\\begin{document}x\\end{document}\n" });
    const r = await discoverValidators({
      workspace: ws,
      taskInstruction: 'Compile main.tex with pdflatex with no "overfull hbox" warnings.',
    });
    const grepValidator = r.candidates.find(
      (c) => c.command.includes("grep -qi") && c.command.toLowerCase().includes("overfull"),
    );
    expect(grepValidator).toBeDefined();
    expect(grepValidator?.source).toBe("task_instruction");
  });

  test(
    "overfull-hbox grep validator end-to-end: shell-quoting survives, backslash-tolerant regex " +
      "(tb2-smoke regression: plan Fix 2)",
    async () => {
      // Regression for the tb2-smoke overfull-hbox false-positive. Two
      // combined issues:
      //   (a) outer single-quote wrapper hand-concatenated with an
      //       inner `'keyword'` truncated the script (shell quoting).
      //   (b) grep pattern `overfull hbox` doesn't match TeX's actual
      //       `Overfull \hbox` output (backslash-h).
      // The fix: shell-escape the whole script once, and build a regex
      // that accepts `space+` or `space* backslash space*` between tokens.
      const ws = mkWs({
        "main.tex": "\\documentclass{article}\\begin{document}x\\end{document}\n",
      });
      const r = await discoverValidators({
        workspace: ws,
        taskInstruction: 'Compile main.tex with pdflatex with no "overfull hbox" warnings.',
      });
      const grepValidator = r.candidates.find(
        (c) => c.command.includes("grep -qiE") && c.command.toLowerCase().includes("overfull"),
      );
      expect(grepValidator).toBeDefined();
      const command = grepValidator!.command;

      // Pre-flight: the command should be syntactically valid bash. The
      // old hand-concatenated wrapper passed this check too (broken
      // quoting produces valid-but-wrong argv), so we follow up with an
      // actual run below.
      const syntaxCheck = Bun.spawn(["bash", "-n", "-c", command], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await syntaxCheck.exited;
      expect(syntaxCheck.exitCode).toBe(0);

      async function runWithPdflatexOutput(stdout: string): Promise<number> {
        // Install a PATH shim that prints `stdout` and exits 0 as
        // `pdflatex`, then run the real synthesized validator command.
        const shimDir = mkdtempSync(path.join(tmpdir(), "oa-val-pdflatex-shim-"));
        const shim = path.join(shimDir, "pdflatex");
        const body = `#!/usr/bin/env bash\ncat <<'__OUT__'\n${stdout}\n__OUT__\nexit 0\n`;
        writeFileSync(shim, body, { mode: 0o755 });
        const env = {
          ...process.env,
          PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        } as Record<string, string>;
        const p = Bun.spawn(["bash", "-c", command], {
          stdout: "pipe",
          stderr: "pipe",
          cwd: ws,
          env,
        });
        await p.exited;
        return p.exitCode ?? -1;
      }

      // TeX's actual emitted form: "Overfull \hbox (badness X)". Our regex
      // must match this via the optional-backslash tolerance.
      const dirty = await runWithPdflatexOutput(
        "This is pdfTeX\nOverfull \\hbox (badness 10000) in paragraph at lines 3--5",
      );
      expect(dirty).toBe(1);
      const clean = await runWithPdflatexOutput(
        "This is pdfTeX\nOutput written on main.pdf (1 page).",
      );
      expect(clean).toBe(0);
      // Also accept the no-backslash form "Overfull hbox" (some tools emit it).
      const dirtyNoSlash = await runWithPdflatexOutput(
        "This is pdfTeX\nOverfull hbox (badness 10000) in paragraph at lines 3--5",
      );
      expect(dirtyNoSlash).toBe(1);
    },
  );

  test("minimal-safe fallback is appended at the end, never short-circuited", async () => {
    const ws = mkWs({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "main.py": "x = 1\n",
    });
    const r = await discoverValidators({ workspace: ws });
    // We expect both a medium (manifest) candidate AND the low fallback.
    expect(r.candidates.some((c) => c.source === "repo_manifest")).toBe(true);
    expect(r.candidates.some((c) => c.source === "minimal_safe_fallback")).toBe(true);
  });
});

describe("runValidator", () => {
  test("exit 0 → pass", async () => {
    const run = await runValidator(
      {
        command: "true",
        confidence: "medium",
        source: "framework_convention",
        justification: "",
      },
      { workspace: mkWs() },
    );
    expect(run.validatorStatus).toBe("pass");
    expect(run.exitCode).toBe(0);
  });

  test("exit != 0 → fail", async () => {
    const run = await runValidator(
      {
        command: "exit 3",
        confidence: "medium",
        source: "framework_convention",
        justification: "",
      },
      { workspace: mkWs() },
    );
    expect(run.validatorStatus).toBe("fail");
    expect(run.exitCode).toBe(3);
  });

  test("pytest 'collected 0 items' → noop", async () => {
    const run = await runValidator(
      {
        command: "echo 'collected 0 items' && true",
        confidence: "low",
        source: "minimal_safe_fallback",
        justification: "",
      },
      { workspace: mkWs() },
    );
    expect(run.validatorStatus).toBe("noop");
  });

  test("timeout → crash with timeout reason", async () => {
    const run = await runValidator(
      {
        command: "sleep 5",
        confidence: "medium",
        source: "framework_convention",
        justification: "",
      },
      { workspace: mkWs(), timeoutMs: 500 },
    );
    expect(run.validatorStatus).toBe("crash");
    expect(run.crashReason).toBe("timeout");
  });

  test("missing pytest harness → crash/missing_interpreter, not task failure", async () => {
    const stream = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      });
    const run = await runValidator(
      {
        command: "python3 -m pytest ./test_outputs.py -q",
        confidence: "high",
        source: "harbor_task_convention",
        justification: "",
      },
      {
        workspace: mkWs(),
        spawn: (() =>
          ({
            exited: Promise.resolve(1),
            exitCode: 1,
            stdout: stream(""),
            stderr: stream("/usr/local/bin/python3: No module named pytest\n"),
            kill() {},
          }) as unknown as ReturnType<typeof Bun.spawn>) as typeof Bun.spawn,
      },
    );
    expect(run.validatorStatus).toBe("crash");
    expect(run.crashReason).toBe("missing_interpreter");
  });

  test("app-level ModuleNotFoundError remains a real validator failure", async () => {
    const stream = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      });
    const run = await runValidator(
      {
        command: "python3 -m pytest ./test_outputs.py -q",
        confidence: "high",
        source: "harbor_task_convention",
        justification: "",
      },
      {
        workspace: mkWs(),
        spawn: (() =>
          ({
            exited: Promise.resolve(1),
            exitCode: 1,
            stdout: stream(""),
            stderr: stream("ModuleNotFoundError: No module named 'app'\n"),
            kill() {},
          }) as unknown as ReturnType<typeof Bun.spawn>) as typeof Bun.spawn,
      },
    );
    expect(run.validatorStatus).toBe("fail");
  });
});

describe("routeValidation (§M4)", () => {
  const mkRun = (
    status: ValidatorRun["validatorStatus"],
    source: ValidatorRun["validator"]["source"] = "framework_convention",
  ): ValidatorRun => ({
    validator: { command: "x", confidence: "medium", source, justification: "" },
    validatorStatus: status,
    exitCode: status === "pass" ? 0 : 1,
    signal: null,
    stdoutTail: "",
    stderrTail: "",
    wallMs: 0,
  });

  test("all pass (stronger source) → success", () => {
    const r: ValidationResult = {
      passed: true,
      validatorsRun: [mkRun("pass"), mkRun("pass", "framework_convention")],
      incompleteReasons: [],
    };
    const route = routeValidation(r);
    expect(route.status).toBe("success");
    expect(route.exitCode).toBe(0);
  });

  test("any fail → task_failure", () => {
    const r: ValidationResult = {
      passed: false,
      validatorsRun: [mkRun("pass"), mkRun("fail")],
      incompleteReasons: ["validator failed"],
    };
    expect(routeValidation(r).status).toBe("task_failure");
    expect(routeValidation(r).exitCode).toBe(1);
  });

  test("only minimal-safe fallback passes → validation_unknown", () => {
    const r: ValidationResult = {
      passed: true,
      validatorsRun: [mkRun("pass", "minimal_safe_fallback")],
      incompleteReasons: [],
    };
    const route = routeValidation(r);
    expect(route.status).toBe("validation_unknown");
    expect(route.exitCode).toBe(2);
  });

  test("no validators → validation_unknown", () => {
    const r: ValidationResult = {
      passed: false,
      validatorsRun: [],
      incompleteReasons: ["no candidates"],
    };
    expect(routeValidation(r).status).toBe("validation_unknown");
  });

  test("crash-only → validation_unknown", () => {
    const r: ValidationResult = {
      passed: false,
      validatorsRun: [mkRun("crash")],
      incompleteReasons: ["timeout"],
    };
    expect(routeValidation(r).status).toBe("validation_unknown");
  });

  test("all passes but only file-existence probes → validation_unknown (gcode-to-text downgrade)", () => {
    const fileExistenceRun = (path: string): ValidatorRun => ({
      validator: {
        command: `test -s ${path}`,
        confidence: "low",
        source: "task_instruction",
        justification: `file existence probe for ${path}`,
      },
      validatorStatus: "pass",
      exitCode: 0,
      signal: null,
      stdoutTail: "",
      stderrTail: "",
      wallMs: 10,
    });
    const r: ValidationResult = {
      passed: true,
      validatorsRun: [fileExistenceRun("/app/out.txt")],
      incompleteReasons: [],
    };
    const route = routeValidation(r);
    expect(route.status).toBe("validation_unknown");
    expect(route.exitCode).toBe(2);
    expect(route.summary).toContain("weak");
  });

  test("mixed pass-set (file-existence + real validator) → success (only downgrades if ALL are weak)", () => {
    const fileExistenceRun: ValidatorRun = {
      validator: {
        command: "test -s /app/out.txt",
        confidence: "low",
        source: "task_instruction",
        justification: "",
      },
      validatorStatus: "pass",
      exitCode: 0,
      signal: null,
      stdoutTail: "",
      stderrTail: "",
      wallMs: 10,
    };
    const realRun = mkRun("pass", "framework_convention");
    const r: ValidationResult = {
      passed: true,
      validatorsRun: [fileExistenceRun, realRun],
      incompleteReasons: [],
    };
    expect(routeValidation(r).status).toBe("success");
  });

  describe("weak-validator downgrade (tb2-smoke regression: plan Fix 4)", () => {
    // The tb2-smoke sonnet gcode-to-text trial reported "success" when
    // only `test -s /app/out.txt` + `python3 -m py_compile analyze2.py`
    // passed — neither asserts task correctness. These tests lock in the
    // generalized weak-validator detection so we downgrade to
    // validation_unknown instead.
    const weakRun = (command: string): ValidatorRun => ({
      validator: {
        command,
        confidence: "low",
        source: "task_instruction",
        justification: "weak probe",
      },
      validatorStatus: "pass",
      exitCode: 0,
      signal: null,
      stdoutTail: "",
      stderrTail: "",
      wallMs: 5,
    });

    test.each([
      "test -s /app/out.txt",
      "test -f some/file.py",
      "test -d build",
      "test -e /tmp/x",
      "[ -f PATH ]",
      "[ -s PATH ]",
      "python3 -m py_compile a.py b.py",
      "python -m py_compile src/foo.py",
      "python3 -c 'import mymodule'",
      `python3 -c "import mymodule.submod"`,
      "node -e \"require('mypackage')\"",
      "ruby -e 'require \"mygem\"'",
    ])("solo weak validator %s → validation_unknown", (cmd) => {
      const r: ValidationResult = {
        passed: true,
        validatorsRun: [weakRun(cmd)],
        incompleteReasons: [],
      };
      expect(routeValidation(r).status).toBe("validation_unknown");
    });

    test("gcode-to-text regression: test -s + py_compile combined → validation_unknown", () => {
      const r: ValidationResult = {
        passed: true,
        validatorsRun: [
          weakRun("test -s /app/out.txt"),
          weakRun("python3 -m py_compile analyze2.py analyze_gcode.py"),
        ],
        incompleteReasons: [],
      };
      const route = routeValidation(r);
      expect(route.status).toBe("validation_unknown");
      expect(route.summary).toContain("weak");
    });

    test("weak + substantive → success (downgrade requires ALL weak)", () => {
      const r: ValidationResult = {
        passed: true,
        validatorsRun: [
          weakRun("python3 -m py_compile a.py"),
          mkRun("pass", "framework_convention"), // substantive
        ],
        incompleteReasons: [],
      };
      expect(routeValidation(r).status).toBe("success");
    });

    test("substantive commands are NOT flagged as weak", () => {
      // These should remain `success` when passed alone — they actually
      // exercise runtime behavior and are legitimate validators.
      const cases = [
        "pytest -q",
        "npm test",
        "cargo test",
        "python3 tests/run.py",
        "node tests/index.js",
        `python3 -c "from app import run; run()"`, // invokes code, not just import
      ];
      for (const cmd of cases) {
        const r: ValidationResult = {
          passed: true,
          validatorsRun: [weakRun(cmd)],
          incompleteReasons: [],
        };
        expect(routeValidation(r).status).toBe("success");
      }
    });

    test("endpoint reachability plus py_compile remains validation_unknown", () => {
      const r: ValidationResult = {
        passed: true,
        validatorsRun: [
          weakRun(
            "curl -sS -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:5000/sentiment | grep -qE '^[234]'",
          ),
          weakRun("python3 -m py_compile app.py"),
        ],
        incompleteReasons: [],
      };
      const route = routeValidation(r);
      expect(route.status).toBe("validation_unknown");
      expect(route.summary).toContain("shallow");
    });

    test("model-cache semantic constraint requires a loadable-model validator", () => {
      const r: ValidationResult = {
        passed: true,
        validatorsRun: [
          weakRun(
            "curl -sS -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:5000/sentiment | grep -qE '^[234]'",
          ),
          weakRun("python3 -m py_compile app.py"),
        ],
        incompleteReasons: [],
      };
      const route = routeValidation(r, {
        taskInstruction:
          "Save the Hugging Face model to /app/model_cache/sentiment_model and serve it.",
      });
      expect(route.status).toBe("validation_unknown");
      expect(route.summary).toContain("loadable_model_cache");
    });

    test("overfull warning probes do not cover synonym-only edit constraints", () => {
      const r: ValidationResult = {
        passed: true,
        validatorsRun: [
          weakRun("pdflatex -interaction=nonstopmode -halt-on-error main.tex"),
          weakRun(
            "sh -c 'OUT=$(pdflatex main.tex 2>&1); echo \"$OUT\" | grep -qiE overfull && exit 1 || exit 0'",
          ),
        ],
        incompleteReasons: [],
      };
      const route = routeValidation(r, {
        taskInstruction:
          "Fix overfull hbox warnings, but only edit words according to synonyms.txt.",
      });
      expect(route.status).toBe("validation_unknown");
      expect(route.summary).toContain("allowed_edit_constraints");
    });

    test("source-build task cannot succeed on runtime smoke validator alone", () => {
      const r: ValidationResult = {
        passed: true,
        validatorsRun: [
          {
            validator: {
              command: "pmars -r 1000 warrior.red",
              confidence: "high",
              source: "task_instruction",
              justification: "sanity command from task instruction",
            },
            validatorStatus: "pass",
            exitCode: 0,
            signal: null,
            stdoutTail: "",
            stderrTail: "",
            wallMs: 5,
          },
        ],
        incompleteReasons: [],
      };
      const route = routeValidation(r, {
        taskInstruction: "Build pMARS from the Debian source package, not from a prebuilt binary.",
      });
      expect(route.status).toBe("validation_unknown");
      expect(route.summary).toContain("source_provenance");
    });

    test("Debian package/source phrasing still requires source provenance beyond runtime smoke", () => {
      const r: ValidationResult = {
        passed: true,
        validatorsRun: [
          {
            validator: {
              command: "povray +Iscene.pov +Oscene.png",
              confidence: "high",
              source: "task_instruction",
              justification: "task-provided POV-Ray smoke command",
            },
            validatorStatus: "pass",
            exitCode: 0,
            signal: null,
            stdoutTail: "",
            stderrTail: "",
            wallMs: 5,
          },
        ],
        incompleteReasons: [],
      };
      const route = routeValidation(r, {
        taskInstruction:
          "Get the source from Debian packages. Extract the source, build POV-Ray from source, and verify the renderer runs.",
      });
      expect(route.status).toBe("validation_unknown");
      expect(route.summary).toContain("source_provenance");
    });

    test("explicit source-provenance validator covers source-build requirement", () => {
      const r: ValidationResult = {
        passed: true,
        validatorsRun: [
          {
            validator: {
              command:
                "sh -c 'test -d pmars-0.9.2 && test -f pmars-0.9.2/src/pmars.c && ./pmars -r 1000 warrior.red'",
              confidence: "medium",
              source: "task_instruction",
              justification: "checks source tree and built-from-source runtime behavior",
            },
            validatorStatus: "pass",
            exitCode: 0,
            signal: null,
            stdoutTail: "",
            stderrTail: "",
            wallMs: 5,
          },
        ],
        incompleteReasons: [],
      };
      const route = routeValidation(r, {
        taskInstruction: "Compile pMARS from source and verify it runs.",
      });
      expect(route.status).toBe("success");
    });
  });
});
