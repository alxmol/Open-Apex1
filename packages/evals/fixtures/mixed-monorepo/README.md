# mixed-monorepo fixture

Small multi-language fixture used to exercise §M3 `buildRepoMap`, `detectStack`, and tree-sitter symbol indexing across Python + TypeScript + Rust + Go in one tree.

Not a benchmark target — there's no seeded failure. The indexer integration test (`packages/evals/test/indexer-integration.test.ts`) asserts the repo-map + symbol-index count contributions per language.

## Reset

`reset.sh` restores the checked-in files via `git checkout --`.
