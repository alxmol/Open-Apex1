/**
 * Structured patch-engine errors. Surfaced to the model so it can react
 * (re-read the file, rewrite the patch, or fall back to search_replace).
 * Full M2 recovery flow (runtime-mediated write_file allowlist mutation)
 * is deferred per §1.2.
 */

export type PatchErrorCode =
  | "patch_parse_error"
  | "patch_context_mismatch"
  | "path_missing"
  | "hunk_offset_exhausted"
  | "binary_file"
  | "path_outside_workspace"
  | "encoding_error";

export interface PatchErrorDetail {
  code: PatchErrorCode;
  message: string;
  /** Which file path the error is about, when applicable. */
  path?: string;
  /** 1-based hunk index that failed, when applicable. */
  hunkIndex?: number;
  /** Line number in the target file where context mismatched. */
  lineNumber?: number;
  /** Expected context line (the patch's version). */
  expected?: string;
  /** Actual context line on disk. */
  actual?: string;
}

export class PatchError extends Error {
  readonly code: PatchErrorCode;
  readonly detail: PatchErrorDetail;
  constructor(detail: PatchErrorDetail) {
    super(detail.message);
    this.name = "PatchError";
    this.code = detail.code;
    this.detail = detail;
  }
}
