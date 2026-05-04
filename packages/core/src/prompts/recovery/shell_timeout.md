Command exceeded its timeout.
Command: <argv>
Timeout: <seconds>s
Last stdout: <tail>

Options:

1. Increase the timeout if the operation is known to be long-running (ML training, large builds, data downloads).
2. If the command is hung (no output for a long time), kill it and try a different approach.
3. For interactive commands, either use the non-interactive flag (--no-ask, --yes, -n) or pipe empty input.
