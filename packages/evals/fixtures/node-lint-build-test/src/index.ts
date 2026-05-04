// Open-Apex fixture: SEEDED BUG — `path` is imported but not used, tripping
// eslint's @typescript-eslint/no-unused-vars rule.
// The agent should remove the unused import to make lint pass.
import * as path from "node:path";

export function greet(name: string): string {
  return `hello, ${name}`;
}
