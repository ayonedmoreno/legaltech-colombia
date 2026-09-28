/**
 * Removal of identifying metadata from images (decision of 2026-09-28, DATABASE_SPEC.md): the
 * structure is rewritten without some segments, the image data is copied byte for byte and never
 * decoded or re-encoded. PDFs are not handled here: they are never modified. Anything that does
 * not parse cleanly is refused (MetadataSanitizationError) rather than passed through.
 */

export class MetadataSanitizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataSanitizationError";
  }
}

/**
 * JPEG segments removed wherever they appear (before the first scan or between the scans of a
 * progressive image): APP1 (EXIF, with GPS, and XMP), APP13 (IPTC / Photoshop) and COM
 * (comments). Everything else is kept, since it is needed to render the image correctly (e.g.
 * APP0 JFIF, APP2 ICC colour profile, APP14 Adobe colour transform, tables, frame headers).
 */
const JPEG_REMOVED_MARKERS = new Set([0xe1, 0xed, 0xfe]);
/** Markers without a length field: TEM, RST0-RST7. */
const JPEG_STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);
const SOS = 0xda;
const EOI = 0xd9;

/**
 * Walks the whole JPEG: every marker segment, and the entropy-coded data of every scan, which is
 * copied byte for byte (never decoded). Metadata segments are dropped wherever they are, and
 * nothing after the EOI marker is kept (appended data is not part of the image).
 */
export function stripJpegMetadata(input: Buffer): Buffer {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) {
    throw new MetadataSanitizationError("not a JPEG (no SOI marker)");
  }
  const kept: Buffer[] = [input.subarray(0, 2)];
  let offset = 2;
  let scans = 0;
  while (offset < input.length) {
    if (input[offset] !== 0xff) throw new MetadataSanitizationError("JPEG marker expected");
    // Fill bytes (0xFF) may precede a marker.
    let markerOffset = offset;
    while (markerOffset + 1 < input.length && input[markerOffset + 1] === 0xff) markerOffset++;
    if (markerOffset + 1 >= input.length) throw new MetadataSanitizationError("truncated JPEG");
    const marker = input[markerOffset + 1]!;

    if (marker === EOI) {
      if (scans === 0) throw new MetadataSanitizationError("JPEG without image data (no SOS)");
      kept.push(input.subarray(markerOffset, markerOffset + 2));
      return Buffer.concat(kept);
    }
    if (JPEG_STANDALONE.has(marker)) {
      kept.push(input.subarray(markerOffset, markerOffset + 2));
      offset = markerOffset + 2;
      continue;
    }
    if (markerOffset + 4 > input.length) throw new MetadataSanitizationError("truncated JPEG");
    const length = input.readUInt16BE(markerOffset + 2);
    const end = markerOffset + 2 + length;
    if (length < 2 || end > input.length) {
      throw new MetadataSanitizationError("JPEG segment runs past the end of the file");
    }
    if (!JPEG_REMOVED_MARKERS.has(marker)) kept.push(input.subarray(markerOffset, end));
    offset = end;

    if (marker === SOS) {
      // The scan's entropy-coded data runs up to the next marker that is not a stuffed 0xFF00
      // or a restart marker (RST0-RST7); both belong to the data and are copied with it.
      scans += 1;
      let dataEnd = offset;
      for (;;) {
        if (dataEnd + 1 >= input.length) throw new MetadataSanitizationError("truncated JPEG scan");
        if (input[dataEnd] === 0xff) {
          const next = input[dataEnd + 1]!;
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) break;
          dataEnd += 2;
        } else {
          dataEnd += 1;
        }
      }
      kept.push(input.subarray(offset, dataEnd));
      offset = dataEnd;
    }
  }
  throw new MetadataSanitizationError("JPEG without EOI marker");
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/**
 * PNG chunks removed: eXIf (EXIF, with GPS) and the text chunks tEXt, zTXt and iTXt (which also
 * carry XMP). No other chunk is touched: the rest describe or contain the image. Anything after
 * IEND is not part of the image and is dropped.
 */
const PNG_REMOVED_CHUNKS = new Set(["eXIf", "tEXt", "zTXt", "iTXt"]);

export function stripPngMetadata(input: Buffer): Buffer {
  if (input.length < 8 || !input.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new MetadataSanitizationError("not a PNG (bad signature)");
  }
  const kept: Buffer[] = [PNG_SIGNATURE];
  let offset = 8;
  while (offset < input.length) {
    if (offset + 12 > input.length) throw new MetadataSanitizationError("truncated PNG chunk");
    const length = input.readUInt32BE(offset);
    const type = input.subarray(offset + 4, offset + 8).toString("latin1");
    if (!/^[A-Za-z]{4}$/.test(type)) throw new MetadataSanitizationError("invalid PNG chunk type");
    const end = offset + 12 + length;
    if (end > input.length) throw new MetadataSanitizationError("PNG chunk runs past the end");
    if (!PNG_REMOVED_CHUNKS.has(type)) kept.push(input.subarray(offset, end));
    offset = end;
    if (type === "IEND") return Buffer.concat(kept);
  }
  throw new MetadataSanitizationError("PNG without IEND chunk");
}
