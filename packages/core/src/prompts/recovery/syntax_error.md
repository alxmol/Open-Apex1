The previous tool call produced a syntax error:
<language>: <error_excerpt>
File: <path>
Context (5 lines before and after the error line):
<excerpt>

1. Identify the exact cause. Do not assume it is the same as the last syntax error.
2. Propose a minimal fix via `apply_patch`. If the patch would touch more than 30 lines, first explain why.
3. After applying, re-run the validator that surfaced the error.
   If this is the second syntax error on the same file in this turn, stop and consider whether the overall approach is wrong.
