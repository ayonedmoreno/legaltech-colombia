# OCR evaluation, round 1 (synthetic documents; docs/ocr-provider-evaluation.md). An experimental
# instrument, isolated from the application: it is not part of the pnpm workspace, the CI or any
# runtime image. Everything runs locally: no document leaves this machine.
FROM python:3.13-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-spa tesseract-ocr-osd poppler-utils fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir pillow==11.3.0 reportlab==4.4.4 rapidfuzz==3.14.1

WORKDIR /work
