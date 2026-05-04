import { mkdirSync } from "node:fs";
import * as path from "node:path";

export type GateMilestone = "M0" | "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7";

export const REPO_ROOT = path.resolve(new URL("../../../../", import.meta.url).pathname);

export function gateArtifactsRoot(): string {
  return path.join(REPO_ROOT, "gates");
}

export function milestoneArtifactsDir(milestone: GateMilestone): string {
  return path.join(gateArtifactsRoot(), milestone);
}

export function milestoneCanariesDir(milestone: GateMilestone): string {
  return path.join(milestoneArtifactsDir(milestone), "canaries");
}

export function milestoneGateResultPath(milestone: GateMilestone): string {
  mkdirSync(milestoneArtifactsDir(milestone), { recursive: true });
  return path.join(milestoneArtifactsDir(milestone), `gate-result-${milestone}.json`);
}

export function milestoneCanaryResultPath(
  milestone: GateMilestone,
  timestamp: number = Date.now(),
): string {
  mkdirSync(milestoneCanariesDir(milestone), { recursive: true });
  return path.join(milestoneCanariesDir(milestone), `gate-result-canaries-${timestamp}.json`);
}

export function repoRelativeArtifactPath(targetPath: string): string {
  return path.relative(REPO_ROOT, targetPath) || ".";
}
