# OCR evaluation (round 1, synthetic documents)

An experimental instrument for `docs/ocr-provider-evaluation.md`, **isolated from the
application**:

- it is not part of the pnpm workspace, the CI, any package or any runtime image;
- the application never imports it;
- it only reads the worker's metadata sanitizer to produce the "sanitized" representation (B3).

**Rules** (decision 8b):

- every document is synthetic: no real personal data, no logo or letterhead of any real
  authority, generic templates, a fixed seed (`generate.py`);
- the OCR engine is a local Tesseract (`spa`) in a Docker image, so nothing leaves this machine;
- no external provider, account or credential is used.

```bash
bash tools/ocr-evaluation/run.sh
```

Output goes outside the repository (`$OCR_EVAL_WORK`, by default the system temporary directory):
the samples with their ground truth (`samples/manifest.json`), the worker's sanitized copies, and
`results.json`. The figures are recorded, without any document content, in
`docs/ocr-provider-evaluation.md`.

Round 1 measures what synthetic documents allow: B3, B4, B5, B7 and B8. B2 (quality) is
provisional, since synthetic pages are cleaner than real ones. Provider idempotency does not apply
to a local engine. P4 needs round 2, with real anonymized documents (8a, blocked).
