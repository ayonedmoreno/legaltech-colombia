"""Synthetic documents for the OCR evaluation, round 1 (decision 8b).

Every document is invented: no real personal data, no logo or letterhead of any real authority,
generic templates only, and a fixed seed so that the set can be regenerated exactly. Each one is
stored with its ground truth (the exact text that was drawn), one entry per page.
"""

import json
import os
import random
import sys
from io import BytesIO

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

OUT = sys.argv[1] if len(sys.argv) > 1 else "/work/samples"
SEED = 20261002
DPI = 200
PAGE_PX = (int(8.27 * DPI), int(11.69 * DPI))  # A4
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

rng = random.Random(SEED)

# Neutral filler (no legal content): Spanish words with accents and ñ, to exercise NFC and the
# character set a Colombian document uses.
WORDS = (
    "texto sintético de prueba para medir el reconocimiento óptico de caracteres en páginas "
    "generadas con valores inventados sin ninguna validez el contenido no describe ningún hecho "
    "real ni ninguna norma la información aparece en párrafos de longitud variable con números "
    "fechas y nombres ficticios año señal pequeño acción región información técnica"
).split()
FIRST = ["Ana", "Luis", "Marta", "Jorge", "Sofía", "Andrés", "Lucía", "Tomás"]
LAST = ["Prueba", "Sintético", "Ejemplo", "Ficticio", "Modelo", "Muestra"]


def fake_fields(n):
    plate = "".join(rng.choice("ABCDEFGHJKLMNPRSTUVWXYZ") for _ in range(3)) + "".join(
        rng.choice("0123456789") for _ in range(3)
    )
    return [
        ("DOCUMENTO SINTÉTICO DE PRUEBA — SIN VALIDEZ", True),
        (f"Formato genérico de prueba n.º {n:05d}", False),
        (f"Número de referencia: {rng.randint(10**9, 10**10 - 1)}", False),
        (f"Fecha: {rng.randint(1, 28):02d}/{rng.randint(1, 12):02d}/{rng.randint(2019, 2026)}", False),
        (f"Placa: {plate}", False),
        (f"Nombre: {rng.choice(FIRST)} {rng.choice(LAST)} {rng.choice(LAST)}", False),
        (f"Identificación: {rng.randint(10**7, 10**10 - 1)}", False),
        (f"Valor: $ {rng.randint(100, 2000) * 1000:,}".replace(",", "."), False),
    ]


def paragraph(words):
    text = " ".join(rng.choice(WORDS) for _ in range(words))
    return text[0].upper() + text[1:] + "."


def page_lines(n, page):
    """The lines of one page: the header block on the first page, then filler paragraphs."""
    lines = fake_fields(n) if page == 0 else [(f"Página {page + 1} — continuación del documento {n:05d}", True)]
    for _ in range(rng.randint(5, 8)):
        lines.append((paragraph(rng.randint(30, 60)), False))
    return lines


def wrap(draw, text, font, width):
    out, line = [], ""
    for word in text.split():
        candidate = f"{line} {word}".strip()
        if draw.textlength(candidate, font=font) <= width:
            line = candidate
        else:
            out.append(line)
            line = word
    if line:
        out.append(line)
    return out


def render_page(lines):
    """A clean page image and the exact text drawn on it (the ground truth)."""
    img = Image.new("L", PAGE_PX, 255)
    draw = ImageDraw.Draw(img)
    regular = ImageFont.truetype(FONT, 30)
    bold = ImageFont.truetype(FONT_BOLD, 34)
    x, y, width = 140, 140, PAGE_PX[0] - 280
    truth = []
    for text, is_bold in lines:
        font = bold if is_bold else regular
        for row in wrap(draw, text, font, width):
            if y > PAGE_PX[1] - 180:
                break
            draw.text((x, y), row, fill=0, font=font)
            truth.append(row)
            y += 44
        y += 22
    return img, "\n".join(truth)


def photo_like(img):
    """A phone photo of the page: slightly rotated, blurred, noisy and with less contrast."""
    rot = img.convert("RGB").rotate(rng.uniform(-3, 3), expand=True, fillcolor=(235, 232, 225))
    rot = rot.filter(ImageFilter.GaussianBlur(1.1))
    noise = Image.effect_noise(rot.size, 18).convert("RGB")
    rot = Image.blend(rot, noise, 0.08)
    return rot.point(lambda v: int(40 + v * 0.75))


def jpeg_bytes(img, quality, exif=None):
    buf = BytesIO()
    kwargs = {"quality": quality}
    if exif is not None:
        kwargs["exif"] = exif
    img.convert("RGB").save(buf, "JPEG", **kwargs)
    return buf.getvalue()


def png_bytes(img):
    buf = BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def scanned_pdf(images, quality=80):
    buf = BytesIO()
    pages = [i.convert("RGB") for i in images]
    pages[0].save(buf, "PDF", save_all=True, append_images=pages[1:], resolution=DPI, quality=quality)
    return buf.getvalue()


def digital_pdf(pages_lines):
    """A PDF with a real text layer, as an authority's system would emit it (generic layout)."""
    pdfmetrics.registerFont(TTFont("DejaVu", FONT))
    buf = BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    truths = []
    for lines in pages_lines:
        y = A4[1] - 60
        truth = []
        for text, _ in lines:
            c.setFont("DejaVu", 10)
            words, line = text.split(), ""
            for word in words:
                candidate = f"{line} {word}".strip()
                if pdfmetrics.stringWidth(candidate, "DejaVu", 10) <= A4[0] - 120:
                    line = candidate
                else:
                    c.drawString(60, y, line)
                    truth.append(line)
                    y -= 14
                    line = word
            if line:
                c.drawString(60, y, line)
                truth.append(line)
                y -= 14
            y -= 8
            if y < 60:
                break
        truths.append("\n".join(truth))
        c.showPage()
    c.save()
    return buf.getvalue(), truths


def write(name, data, truths, kind, pages, meta=None):
    with open(os.path.join(OUT, name), "wb") as f:
        f.write(data)
    manifest.append(
        {"file": name, "kind": kind, "pages": pages, "bytes": len(data), "truth": truths, **(meta or {})}
    )


os.makedirs(OUT, exist_ok=True)
manifest = []
doc = 0

# Single-page images: clean PNG, JPEG, phone photo, and a sideways JPEG upright only by EXIF (B3).
for _ in range(6):
    doc += 1
    img, truth = render_page(page_lines(doc, 0))
    write(f"d{doc:03d}-clean.png", png_bytes(img), [truth], "png_clean", 1)
    write(f"d{doc:03d}-clean.jpg", jpeg_bytes(img, 85), [truth], "jpeg_clean", 1)
    write(f"d{doc:03d}-photo.jpg", jpeg_bytes(photo_like(img), 75), [truth], "jpeg_photo", 1)
    exif = Image.Exif()
    exif[0x0112] = 6  # Orientation: rotate 90° CW to display; the pixels are stored sideways.
    sideways = img.transpose(Image.Transpose.ROTATE_90)
    write(f"d{doc:03d}-exif-rotated.jpg", jpeg_bytes(sideways, 85, exif), [truth], "jpeg_exif_rotated", 1)

# Multi-page PDFs: with a text layer (digital) and image-only (scanned), 1, 5 and 20 pages.
for pages in (1, 5, 20):
    doc += 1
    lines = [page_lines(doc, p) for p in range(pages)]
    data, truths = digital_pdf(lines)
    write(f"d{doc:03d}-digital-{pages}p.pdf", data, truths, "pdf_digital", pages)
    images, truths = zip(*(render_page(l) for l in lines))
    data = scanned_pdf([photo_like(i) for i in images])
    write(f"d{doc:03d}-scanned-{pages}p.pdf", data, list(truths), "pdf_scanned", pages)

with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump({"seed": SEED, "dpi": DPI, "documents": manifest}, f, ensure_ascii=False, indent=1)
print(f"generated {len(manifest)} files in {OUT}")
