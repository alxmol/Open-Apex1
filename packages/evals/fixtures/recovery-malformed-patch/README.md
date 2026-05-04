# recovery-malformed-patch fixture

Exercises the §1.2 patch-failure recovery flow: the file on disk contains
subtly-different whitespace from what any naive patch attempt would
expect, so the first apply_patch always context-mismatches. The runtime
injects a synthetic read_file with the fresh content; the model's second
attempt should succeed.

## What the model sees

- `src/lib.py` contains a `greet(name)` function that currently returns
  `"Hi " + name` (no exclamation, different wording).
- Task instruction: make `greet('Alice')` return `'Hello, Alice!'`.
- The first apply_patch usually cites a "Hi " context that no longer
  matches once the agent has made an intermediate edit; the runtime's
  patch-recovery flow (see `packages/runtime/src/patch-recovery.ts`)
  hands back the current on-disk content.

## Reset

`./reset.sh` restores the seeded state (extra whitespace, original
greeting) and wipes pyc caches.

## Validator

`python3 -c 'from src.lib import greet; assert greet("Alice") == "Hello, Alice!"'` must exit 0.
