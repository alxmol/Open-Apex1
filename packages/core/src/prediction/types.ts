/**
 * Prediction phase contracts.
 *
 * `PredictionResult` itself is locked in `orchestration/types.ts` (§3.4.3).
 * This file adds structures the classifier uses internally + a trace shape
 * the runtime emits for telemetry.
 */

import type { PredictionResult, TaskCategory } from "../orchestration/types.ts";

export type { PredictionResult, TaskCategory };

export interface PredictionTrace {
  /** Every (category, score) tuple the classifier considered. */
  categoryScores: Array<{ category: TaskCategory; score: number }>;
  /** Keywords that contributed to the winning category's score. */
  matchedKeywords: string[];
  /** Pattern that triggered multimodal detection, if any. */
  multimodalMatch?: string;
  /** Pattern that bumped risk, if any. */
  riskMatch?: string;
}

export interface PredictionInputs {
  taskText: string;
  /** Optional hint from repo-map (language counts). */
  repoLanguageCounts?: Record<string, number>;
}

export interface Prediction extends PredictionResult {
  trace: PredictionTrace;
}
