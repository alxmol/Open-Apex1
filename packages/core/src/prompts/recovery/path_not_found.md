Path not found: <path>
The tool reported: <error excerpt>

Before retrying, verify:

1. Does the path exist? (`list_tree <parent>`)
2. Is the spelling/case correct? Filesystems may be case-sensitive.
3. Is the path relative to the workspace root, not your cwd?
4. Was the file created in this session? If yes, re-check your earlier tool output.
   Do not assume the path will exist after a retry. If it genuinely doesn't exist, either create it (with `write_file`) or correct the path.
