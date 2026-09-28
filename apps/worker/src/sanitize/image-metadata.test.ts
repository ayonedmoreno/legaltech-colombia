import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  MetadataSanitizationError,
  stripJpegMetadata,
  stripPngMetadata,
} from "./image-metadata.js";

/** A JPEG segment: marker + big-endian length (which counts itself) + payload. */
function segment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.from([0xff, marker, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

const SOI = Buffer.from([0xff, 0xd8]);
const APP0 = segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"));
const APP1_EXIF = segment(
  0xe1,
  Buffer.from("Exif\0\0GPSLatitude 4.6097N GPSLongitude 74.0817W", "latin1"),
);
const APP1_XMP = segment(
  0xe1,
  Buffer.from(
    "http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><dc:creator>Ana Gómez</dc:creator>",
    "utf8",
  ),
);
const APP2_ICC = segment(0xe2, Buffer.from("ICC_PROFILE\0\x01\x01colour-data", "latin1"));
const APP13_IPTC = segment(0xed, Buffer.from("Photoshop 3.0\x008BIM author: Ana", "latin1"));
const APP14_ADOBE = segment(0xee, Buffer.from("Adobe\0d\0\0\0\0\x01", "latin1"));
const COM = segment(0xfe, Buffer.from("Tomada por Ana en su casa", "utf8"));
const DQT = segment(0xdb, Buffer.alloc(65, 1));
const SOF0 = segment(0xc0, Buffer.from([8, 0, 16, 0, 16, 1, 1, 0x11, 0]));
const DHT = segment(0xc4, Buffer.alloc(20, 2));
// Scan header + entropy-coded data (which may contain 0xFF 0x00 stuffing) + EOI.
const SCAN = Buffer.concat([
  segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
  Buffer.from([0x12, 0xff, 0x00, 0x34, 0xe1, 0xfe, 0x56]),
  Buffer.from([0xff, 0xd9]),
]);

describe("JPEG metadata removal", () => {
  const jpeg = Buffer.concat([
    SOI,
    APP0,
    APP1_EXIF,
    APP1_XMP,
    APP2_ICC,
    APP13_IPTC,
    APP14_ADOBE,
    COM,
    DQT,
    SOF0,
    DHT,
    SCAN,
  ]);

  it("removes EXIF (with GPS), XMP, IPTC and comments, and keeps everything else byte for byte", () => {
    const clean = stripJpegMetadata(jpeg);

    expect(
      clean.equals(Buffer.concat([SOI, APP0, APP2_ICC, APP14_ADOBE, DQT, SOF0, DHT, SCAN])),
    ).toBe(true);
    const text = clean.toString("latin1");
    for (const secret of ["GPSLatitude", "xmpmeta", "author", "Tomada"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("copies the image data verbatim (never decoded or re-encoded)", () => {
    const clean = stripJpegMetadata(jpeg);
    expect(clean.subarray(clean.length - SCAN.length).equals(SCAN)).toBe(true);
  });

  it("removes metadata that appears between the scans of a progressive JPEG", () => {
    const SOF2 = segment(0xc2, Buffer.from([8, 0, 16, 0, 16, 1, 1, 0x11, 0]));
    // Two scans; entropy data with byte stuffing (FF 00) and a restart marker (FF D0) inside.
    const scan1 = Buffer.concat([
      segment(0xda, Buffer.from([1, 1, 0, 0, 0, 0])),
      Buffer.from([0x11, 0xff, 0x00, 0x22, 0xff, 0xd0, 0x33]),
    ]);
    const scan2 = Buffer.concat([
      segment(0xda, Buffer.from([1, 1, 0, 1, 5, 0])),
      Buffer.from([0x44, 0xff, 0x00, 0x55]),
    ]);
    const DHT2 = segment(0xc4, Buffer.alloc(20, 3));
    const EOI = Buffer.from([0xff, 0xd9]);
    const progressive = Buffer.concat([
      SOI,
      APP0,
      DQT,
      SOF2,
      DHT,
      scan1,
      APP1_EXIF,
      COM,
      DHT2,
      APP1_XMP,
      scan2,
      EOI,
    ]);

    const clean = stripJpegMetadata(progressive);

    // Exactly the image's own bytes, in order: nothing decoded or re-encoded.
    expect(clean.equals(Buffer.concat([SOI, APP0, DQT, SOF2, DHT, scan1, DHT2, scan2, EOI]))).toBe(
      true,
    );
    for (const secret of ["GPSLatitude", "xmpmeta", "Tomada"]) {
      expect(clean.toString("latin1")).not.toContain(secret);
    }
  });

  it("drops anything after the EOI marker", () => {
    const trailer = Buffer.from("Exif appended: GPSLatitude 4.6097N", "latin1");
    const withTrailer = Buffer.concat([SOI, APP0, DQT, SOF0, DHT, SCAN, trailer]);

    const clean = stripJpegMetadata(withTrailer);

    expect(clean.equals(Buffer.concat([SOI, APP0, DQT, SOF0, DHT, SCAN]))).toBe(true);
  });

  it("refuses a JPEG whose scan data is cut before its EOI", () => {
    const cut = Buffer.concat([SOI, APP0, DQT, SOF0, DHT, SCAN.subarray(0, SCAN.length - 2)]);
    expect(() => stripJpegMetadata(cut)).toThrow(MetadataSanitizationError);
  });

  it("leaves a JPEG without metadata unchanged", () => {
    const plain = Buffer.concat([SOI, APP0, DQT, SOF0, DHT, SCAN]);
    expect(stripJpegMetadata(plain).equals(plain)).toBe(true);
  });

  it("skips fill bytes before a marker", () => {
    const filled = Buffer.concat([SOI, Buffer.from([0xff, 0xff]), APP1_EXIF, DQT, SCAN]);
    expect(stripJpegMetadata(filled).toString("latin1")).not.toContain("GPSLatitude");
  });

  it.each([
    ["no SOI", Buffer.concat([APP0, SCAN])],
    [
      "a segment longer than the file",
      Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0xff, 0xff, 1, 2])]),
    ],
    ["garbage instead of a marker", Buffer.concat([SOI, Buffer.from("not a marker")])],
    ["no scan", Buffer.concat([SOI, APP0, DQT])],
    ["a truncated length", Buffer.concat([SOI, Buffer.from([0xff, 0xdb, 0x00])])],
  ])("refuses %s", (_label, input) => {
    expect(() => stripJpegMetadata(input)).toThrow(MetadataSanitizationError);
  });
});

/** A PNG chunk with a valid CRC. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0);
  return Buffer.concat([length, typeAndData, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR = chunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]));
const ICCP = chunk("iCCP", Buffer.from("icc\0\0profile", "latin1"));
const PLTE = chunk("PLTE", Buffer.from([0, 0, 0]));
const EXIF = chunk("eXIf", Buffer.from("MM\0*GPSLatitude 4.6097", "latin1"));
const TEXT = chunk("tEXt", Buffer.from("Author\0Ana Gomez", "latin1"));
const ZTXT = chunk("zTXt", Buffer.from("Comment\0\0compressed", "latin1"));
const ITXT_XMP = chunk("iTXt", Buffer.from("XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>", "latin1"));
const IDAT = chunk(
  "IDAT",
  Buffer.from([0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]),
);
const TIME = chunk("tIME", Buffer.from([7, 234, 9, 28, 12, 0, 0]));
const IEND = chunk("IEND", Buffer.alloc(0));

describe("PNG metadata removal", () => {
  const png = Buffer.concat([
    SIGNATURE,
    IHDR,
    ICCP,
    EXIF,
    TEXT,
    PLTE,
    ZTXT,
    IDAT,
    ITXT_XMP,
    TIME,
    IEND,
  ]);

  it("removes eXIf, tEXt, zTXt and iTXt (XMP) and keeps every other chunk unchanged", () => {
    const clean = stripPngMetadata(png);
    expect(clean.equals(Buffer.concat([SIGNATURE, IHDR, ICCP, PLTE, IDAT, TIME, IEND]))).toBe(true);
    const text = clean.toString("latin1");
    for (const secret of ["GPSLatitude", "Ana Gomez", "xmpmeta", "compressed"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("drops anything after IEND (not part of the image)", () => {
    const withTrailer = Buffer.concat([SIGNATURE, IHDR, IDAT, IEND, Buffer.from("hidden trailer")]);
    expect(stripPngMetadata(withTrailer).equals(Buffer.concat([SIGNATURE, IHDR, IDAT, IEND]))).toBe(
      true,
    );
  });

  it.each([
    ["a bad signature", Buffer.concat([Buffer.from("PNG"), IHDR, IEND])],
    ["a truncated chunk", Buffer.concat([SIGNATURE, IHDR.subarray(0, 10)])],
    [
      "a chunk longer than the file",
      Buffer.concat([
        SIGNATURE,
        Buffer.from([0x7f, 0xff, 0xff, 0xff]),
        Buffer.from("IDAT"),
        Buffer.alloc(8),
      ]),
    ],
    ["an invalid chunk type", Buffer.concat([SIGNATURE, chunk("I1AT", Buffer.alloc(1)), IEND])],
    ["no IEND", Buffer.concat([SIGNATURE, IHDR, IDAT])],
  ])("refuses %s", (_label, input) => {
    expect(() => stripPngMetadata(input)).toThrow(MetadataSanitizationError);
  });
});
