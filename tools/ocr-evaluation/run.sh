#!/usr/bin/env bash
# OCR evaluation, round 1 (synthetic documents, local Tesseract). Isolated from the application:
# it only reads the worker's metadata sanitizer to produce the "sanitized" representation (B3).
# Nothing is sent outside this machine. Output goes outside the repository checkout:
# $OCR_EVAL_WORK, by default the system temporary directory.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="${OCR_EVAL_WORK:-${TMPDIR:-/tmp}/legaltech-ocr-evaluation}"
mkdir -p "$WORK"
# Docker Desktop on Windows needs a native path for the bind mounts.
to_host() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }

docker build -q -t legaltech-ocr-eval "$HERE" >/dev/null
MSYS_NO_PATHCONV=1 docker run --rm -v "$(to_host "$HERE"):/work/src:ro" -v "$(to_host "$WORK"):/work/out" \
  legaltech-ocr-eval python /work/src/generate.py /work/out/samples

# B3: the worker's own copy without metadata, for every JPEG (read-only use of its sanitizer).
mkdir -p "$WORK/samples/sanitized"
# The helper is written into the output directory: nothing of it lives in the repository.
cat > "$WORK/sanitize.mts" <<TS
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripJpegMetadata } from "file:///$(to_host "$ROOT")/apps/worker/src/sanitize/image-metadata.ts";
const dir = process.argv[2]!;
const files = readdirSync(dir).filter((n) => n.endsWith(".jpg"));
for (const f of files) writeFileSync(\`\${dir}/sanitized/\${f}\`, stripJpegMetadata(readFileSync(\`\${dir}/\${f}\`)));
console.log(\`sanitized \${files.length} JPEG files with the worker's own sanitizer\`);
TS
(cd "$ROOT/apps/worker" && npx tsx "$(to_host "$WORK")/sanitize.mts" "$(to_host "$WORK/samples")")

MSYS_NO_PATHCONV=1 docker run --rm -v "$(to_host "$HERE"):/work/src:ro" -v "$(to_host "$WORK"):/work/out" \
  legaltech-ocr-eval python /work/src/evaluate.py /work/out
echo "results: $(to_host "$WORK")/results.json"
