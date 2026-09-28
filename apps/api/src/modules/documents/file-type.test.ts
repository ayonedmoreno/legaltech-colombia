import { describe, expect, it } from "vitest";
import { attachmentDisposition } from "../../storage/storage.types.js";
import { detectFileType } from "./file-type.js";

const bytes = (...values: number[]) => Uint8Array.from(values);

describe("file type detection by content (magic bytes)", () => {
  it.each([
    ["PDF", Buffer.from("%PDF-1.7\n%âãÏÓ\n", "latin1")],
    ["JPEG", bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46)],
    ["PNG", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00)],
  ])("recognizes %s", (type, content) => {
    expect(detectFileType(content)).toBe(type);
  });

  it.each([
    ["an empty file", bytes()],
    ["a truncated PNG signature", bytes(0x89, 0x50, 0x4e, 0x47)],
    ["a text file named .pdf", Buffer.from("hola, esto no es un PDF")],
    ["a GIF", Buffer.from("GIF89a")],
    ["a ZIP (also DOCX)", bytes(0x50, 0x4b, 0x03, 0x04)],
    ["an HTML page", Buffer.from("<!doctype html><script>alert(1)</script>")],
    ["an SVG image", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["a PDF signature not at the start", Buffer.from(" %PDF-1.7")],
  ])("rejects %s", (_label, content) => {
    expect(detectFileType(content)).toBeNull();
  });
});

describe("download Content-Disposition", () => {
  it("is always an attachment, with an ASCII fallback and the exact UTF-8 name", () => {
    expect(attachmentDisposition('Resolución "final".pdf')).toBe(
      "attachment; filename=\"Resoluci_n _final_.pdf\"; filename*=UTF-8''Resoluci%C3%B3n%20%22final%22.pdf",
    );
  });

  it("cannot be broken out of with quotes, semicolons or line breaks", () => {
    const value = attachmentDisposition('a";\r\nx-evil: 1.pdf');
    expect(value).not.toMatch(/[\r\n]/);
    // The quote and the line breaks become "_"; inside the quoted name ";" is harmless.
    expect(value.startsWith('attachment; filename="a_;__x-evil: 1.pdf"; ')).toBe(true);
  });
});
