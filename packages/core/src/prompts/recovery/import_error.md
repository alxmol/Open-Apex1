Import error: <module> not found.
Context: <stderr excerpt>
Environment: <language> <version>, package manager: <manager>

Check in order:

1. Is <module> the correct spelling? Consult repo imports with `search_text "import <prefix>"`.
2. Is it installed? Inspect `package.json`/`pyproject.toml`/`Cargo.toml`/`go.sum`.
3. If missing, install with the repo's package manager (reversible), not a global install.
4. If it's a local module path issue, verify <language> path resolution (Node's `module.exports`, Python's `__init__.py`, Rust's `mod`, Go's package path).
