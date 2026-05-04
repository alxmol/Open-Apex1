# docs-image-pdf fixture

A tiny multimodal fixture used by §M3 canaries + integration tests. Contains:

- `canary.png` — 1×1 PNG used as a trivial image payload.
- `canary.pdf` — minimal 1-page PDF embedding the sentinel string `OPEN-APEX-CANARY-2026-04-24` so live multimodal canaries can assert the model read the document.

The canary string is unlikely to appear in the model's training data and is distinctive enough that tests can grep the model's text output for it.

## Reset

`reset.sh` is a no-op (fixture files are committed) but is provided for parity with other fixtures.
