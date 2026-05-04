import { describe, expect, test } from "bun:test";

import { probeEnvironment } from "../src/env-probe.ts";
import type { Subprocess } from "bun";

type SpawnFn = typeof Bun.spawn;

interface ScriptedCall {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

function makeSpawn(replies: Record<string, ScriptedCall | undefined>): SpawnFn {
  return ((argv: string[]) => {
    const key = argv.join(" ");
    const reply = replies[key] ?? replies[argv[0] ?? ""];
    const exitCode = reply?.exitCode ?? 0;
    const stdoutText = reply?.stdout ?? "";
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(stdoutText));
        ctrl.close();
      },
    });
    return {
      exited: Promise.resolve(exitCode),
      exitCode,
      stdout: stream,
      stderr: new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      }),
      kill(): void {
        /* no-op */
      },
    } as unknown as Subprocess;
  }) as unknown as SpawnFn;
}

describe("probeEnvironment", () => {
  test("captures runtime versions via scripted subprocesses", async () => {
    const spawn = makeSpawn({
      "python3 --version": { stdout: "Python 3.12.0\n" },
      "node --version": { stdout: "v22.3.0\n" },
      "bun --version": { stdout: "1.3.12\n" },
      "rustc --version": { stdout: "rustc 1.82.0\n" },
      "go version": { stdout: "go version go1.22.1 darwin/arm64\n" },
      "java -version": { stdout: 'openjdk version "17"\n' },
      "ruby --version": { stdout: "ruby 3.3.0\n" },
      "git --version": { stdout: "git version 2.49.0\n" },
      "df -h /tmp": {
        stdout: "Filesystem Size Used Avail Use% Mounted\n/dev/foo 100G 50G 40G 56% /\n",
      },
      vm_stat: { stdout: "Mach Virtual Memory Statistics:\nPages free:    123456\n" },
      "free -h": {
        stdout:
          "              total        used        free\nMem:           16Gi         4Gi         8Gi\n",
      },
      "ps ax -o pid,comm,%cpu": { stdout: "PID COMM %CPU\n1 init 0.1\n2 bun 3.2\n" },
    });
    const r = await probeEnvironment({ workspace: "/tmp", spawn });
    expect(r.runtimeVersions.python).toContain("Python 3.12.0");
    expect(r.runtimeVersions.node).toContain("v22.3");
    expect(r.diskFree).toContain("available");
    expect(r.memoryFree).toContain("free");
    expect(r.runningProcesses.length).toBeGreaterThan(0);
  });

  test("subprocess failure is recorded but doesn't throw", async () => {
    const spawn = makeSpawn({
      "python3 --version": { exitCode: 127 },
    });
    const r = await probeEnvironment({ workspace: "/tmp", spawn });
    expect(r.runtimeVersions.python).toBeUndefined();
    // Other probes may still produce empty output without throwing.
    expect(Array.isArray(r.probeErrors)).toBe(true);
  });
});
