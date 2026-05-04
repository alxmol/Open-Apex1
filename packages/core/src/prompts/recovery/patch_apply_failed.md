Patch application failed. Reported reason: <structured_error>
Target file: <path>

The file has likely drifted from what you expected. Before retrying:

1. Read the relevant range of the file with `read_file <path> <start> <end>`.
2. Verify your assumed context still holds.
3. Rewrite the patch against the actual current content.

If `apply_patch` fails twice on the same file, the runtime will temporarily offer `write_file` for that file as a recovery fallback. Use it only with the full, current content of the file. Do not use `write_file` for partial edits.
