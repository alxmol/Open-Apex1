/**
 * Fixture repo contract (§7.6.6).
 *
 * Each fixture is a self-contained repo with:
 *   - reset.sh: restores clean state
 *   - expected.json: validator commands + expected outputs
 *   - seeded failure modes
 */

export interface FixtureExpected {
  /** Validator commands to run. */
  validators: Array<{
    command: string[];
    /** Exit code that indicates success. */
    expectedExitCode: number;
    /** Optional stdout regex to match. */
    stdoutMatches?: string;
  }>;
  /** Human-readable description of the seeded failure mode. */
  seededFailure: string;
}

export interface Fixture {
  id: string;
  description: string;
  /** Absolute path to the fixture repo (resolved at load time). */
  rootPath: string;
  expected: FixtureExpected;
  /** Tags that scenarios can filter by. */
  tags: string[];
}

export interface FixtureResetReport {
  id: string;
  ok: boolean;
  durationMs: number;
  output: string;
}
