"""OCR evaluation, round 1: a local Tesseract (spa) over the synthetic set (decision 8b).

Measures what synthetic documents allow (docs/ocr-provider-evaluation.md):
- B8: size of the OCR text per page and per document (UTF-8, after the technical normalization of
  OCR-A10.4: NFC and "\\n" line endings), the input of decision OCR-A10.5;
- B5: time per page; B7: pages per document and per 10 MiB; B4: PDF text layer vs rasterized;
- B3: original vs the worker's copy without metadata (incl. a JPEG upright only through EXIF);
- B2: character error rate against the ground truth, PROVISIONAL (synthetic pages are cleaner
  than real ones and can never justify P4 on their own).
Provider idempotency does not apply to a local engine. Nothing leaves this machine.
"""

import glob
import json
import os
import statistics
import subprocess
import sys
import tempfile
import time
import unicodedata

from rapidfuzz.distance import Levenshtein

WORK = sys.argv[1] if len(sys.argv) > 1 else "/work/out"
SAMPLES = os.path.join(WORK, "samples")
SANITIZED = os.path.join(SAMPLES, "sanitized")
MIB = 1024 * 1024


def technical(text):
    """OCR-A10.4 (n1): what the worker would store."""
    return unicodedata.normalize("NFC", text).replace("\r\n", "\n").replace("\r", "\n")


def comparable(text):
    return " ".join(unicodedata.normalize("NFC", text).split())


def cer(ocr, truth):
    t = comparable(truth)
    return Levenshtein.distance(comparable(ocr), t) / max(len(t), 1)


def tesseract(path, psm=3):
    start = time.perf_counter()
    out = subprocess.run(
        ["tesseract", path, "stdout", "-l", "spa", "--psm", str(psm)],
        capture_output=True, check=True,
    ).stdout.decode("utf-8")
    return out, time.perf_counter() - start


def pdf_text_layer(path, page):
    start = time.perf_counter()
    out = subprocess.run(
        ["pdftotext", "-f", str(page), "-l", str(page), "-layout", path, "-"],
        capture_output=True, check=True,
    ).stdout.decode("utf-8")
    return out, time.perf_counter() - start


def pdf_rasterized(path, page, tmp):
    start = time.perf_counter()
    prefix = os.path.join(tmp, f"p{page}")
    subprocess.run(
        ["pdftoppm", "-r", "200", "-png", "-f", str(page), "-l", str(page), path, prefix],
        check=True, capture_output=True,
    )
    raster = time.perf_counter() - start
    [png] = glob.glob(prefix + "*.png")
    text, ocr = tesseract(png)
    os.remove(png)
    return text, raster + ocr


def page_record(kind, method, ocr, seconds, truth):
    stored = technical(ocr)
    return {
        "kind": kind,
        "method": method,
        "seconds": round(seconds, 3),
        "bytes": len(stored.encode("utf-8")),
        "cer": round(cer(ocr, truth), 4),
    }


manifest = json.load(open(os.path.join(SAMPLES, "manifest.json"), encoding="utf-8"))
pages, documents = [], []
with tempfile.TemporaryDirectory() as tmp:
    for doc in manifest["documents"]:
        path = os.path.join(SAMPLES, doc["file"])
        kind = doc["kind"]
        if kind.startswith("pdf_"):
            methods = ["text_layer", "rasterized"] if kind == "pdf_digital" else ["rasterized"]
            for method in methods:
                doc_bytes, doc_seconds = 0, 0.0
                for i, truth in enumerate(doc["truth"], start=1):
                    if method == "text_layer":
                        ocr, s = pdf_text_layer(path, i)
                    else:
                        ocr, s = pdf_rasterized(path, i, tmp)
                    rec = page_record(kind, method, ocr, s, truth)
                    pages.append(rec)
                    doc_bytes += rec["bytes"]
                    doc_seconds += s
                documents.append({
                    "file": doc["file"], "kind": kind, "method": method, "pages": doc["pages"],
                    "file_bytes": doc["bytes"], "text_bytes": doc_bytes,
                    "seconds": round(doc_seconds, 2),
                })
            continue
        [truth] = doc["truth"]
        variants = [("original", path)]
        sanitized = os.path.join(SANITIZED, doc["file"])
        if os.path.exists(sanitized):
            variants.append(("sanitized", sanitized))
        for representation, file in variants:
            psms = [3, 1] if kind == "jpeg_exif_rotated" else [3]
            for psm in psms:
                ocr, s = tesseract(file, psm)
                rec = page_record(kind, f"{representation}/psm{psm}", ocr, s, truth)
                pages.append(rec)
        documents.append({"file": doc["file"], "kind": kind, "pages": 1, "file_bytes": doc["bytes"]})


def summary(rows):
    secs = sorted(r["seconds"] for r in rows)
    return {
        "n": len(rows),
        "cer_mean": round(statistics.mean(r["cer"] for r in rows), 4),
        "cer_max": round(max(r["cer"] for r in rows), 4),
        "bytes_mean": round(statistics.mean(r["bytes"] for r in rows)),
        "bytes_max": max(r["bytes"] for r in rows),
        "seconds_p50": round(secs[len(secs) // 2], 3),
        "seconds_p95": round(secs[min(len(secs) - 1, int(len(secs) * 0.95))], 3),
    }


groups = {}
for r in pages:
    groups.setdefault(f'{r["kind"]} · {r["method"]}', []).append(r)
by_group = {k: summary(v) for k, v in sorted(groups.items())}

scanned = [d for d in documents if d["kind"] == "pdf_scanned"]
bytes_per_scanned_page = statistics.mean(d["file_bytes"] / d["pages"] for d in scanned)
text_per_page = statistics.mean(r["bytes"] for r in pages if r["kind"].startswith("pdf_"))
pages_in_10mib = int(10 * MIB / bytes_per_scanned_page)

result = {
    "engine": subprocess.run(["tesseract", "--version"], capture_output=True).stdout.decode().split("\n")[0],
    "cpus": os.cpu_count(),
    "by_group": by_group,
    "documents": documents,
    "b7": {
        "scanned_pdf_bytes_per_page": round(bytes_per_scanned_page),
        "scanned_pages_in_10_mib": pages_in_10mib,
    },
    "b8": {
        "text_bytes_per_page_mean": round(text_per_page),
        "text_bytes_per_page_max": max(r["bytes"] for r in pages),
        "worst_case_document_text_bytes": pages_in_10mib * max(r["bytes"] for r in pages),
    },
}
with open(os.path.join(WORK, "results.json"), "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=1)
print(json.dumps({k: result[k] for k in ("engine", "cpus", "b7", "b8")}, ensure_ascii=False, indent=1))
for k, v in by_group.items():
    print(f"{k:45s} {v}")
