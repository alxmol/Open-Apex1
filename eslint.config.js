// ESLint 9 flat config for the Open-Apex monorepo.
// §5.2 regression philosophy: lint runs on every code change.

import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  // Monorepo-wide ignores — don't lint built artifacts, deps, or fixtures.
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/coverage/**",
      "**/target/**",
      "**/.venv/**",
      // Fixtures are intentionally seeded with bugs; do not lint them.
      "packages/evals/fixtures/**",
      // Verification-gate JSON artifacts aren't source.
      "packages/config/verification-gates/**",
      // Generated / data-only.
      "gate-result-*.json",
      "gates/**/*.json",
    ],
  },
  // TypeScript source + tests.
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2023,
      sourceType: "module",
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      // Unused vars/args are allowed if prefixed with `_`.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "prefer-const": "error",
      // The CLI surface writes to stdout/stderr deliberately. No ban on console.
      "no-console": "off",
      // `any` shows up in adapter / SDK-boundary code with unavoidable escape hatches.
      // We allow it for now; contract tests guard the actual shape.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
