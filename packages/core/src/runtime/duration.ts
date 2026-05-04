/**
 * Shared duration parsing for runtime/benchmark knobs.
 *
 * Harbor config values are commonly expressed in seconds, while Open-Apex
 * internal deadlines are milliseconds. To make inherited environment values
 * safe, bare small numbers are treated as seconds for benchmark deadlines.
 */

export function parseDurationMs(value: string | undefined, fallbackMs: number): number {
  if (value === undefined || value.trim() === "") return fallbackMs;
  const raw = value.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(raw);
  if (!match) return fallbackMs;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return fallbackMs;

  const unit = match[2];
  if (unit === "ms") return Math.round(amount);
  if (unit === "s") return Math.round(amount * 1000);
  if (unit === "m") return Math.round(amount * 60_000);

  // Bare benchmark caps like `900` come from Harbor's seconds-based config.
  // Larger bare values are already millisecond-style knobs.
  return amount < 10_000 ? Math.round(amount * 1000) : Math.round(amount);
}

export function parseDurationMsEnv(name: string, fallbackMs: number): number {
  return parseDurationMs(process.env[name], fallbackMs);
}
