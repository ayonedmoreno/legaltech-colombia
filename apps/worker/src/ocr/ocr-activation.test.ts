import type { PrismaClient } from "@legaltech/database";
import { describe, expect, it } from "vitest";
import { assertOcrStartupPreconditions } from "./ocr-activation.js";
import type { OcrProvider } from "./ocr-provider.js";

/** A client whose only query is the invariant's count. */
const prismaWith = (violations: number) =>
  ({ $queryRaw: async () => [{ count: BigInt(violations) }] }) as unknown as PrismaClient;

const provider = (external: boolean): OcrProvider => ({
  engine: "fake",
  external,
  recognize: async () => ({ pages: [], engineVersion: null }),
});

const base = {
  prisma: prismaWith(0),
  provider: provider(false),
  pdfEnabled: false,
  pdfP7Resolved: false,
};

describe("assertOcrStartupPreconditions (decisions P4, OCR-A7, OCR-A12)", () => {
  it("refuses to start without a provider (P4 is open)", async () => {
    await expect(assertOcrStartupPreconditions({ ...base, provider: null })).rejects.toThrow(/P4/);
  });

  it("never sends a PDF to an external provider before P7 is resolved", async () => {
    await expect(
      assertOcrStartupPreconditions({ ...base, provider: provider(true), pdfEnabled: true }),
    ).rejects.toThrow(/P7/);
    await expect(
      assertOcrStartupPreconditions({
        ...base,
        provider: provider(true),
        pdfEnabled: true,
        pdfP7Resolved: true,
      }),
    ).resolves.toBeUndefined();
    // Our own OCR: the PDF does not leave our infrastructure, P7 does not block it.
    await expect(
      assertOcrStartupPreconditions({ ...base, pdfEnabled: true }),
    ).resolves.toBeUndefined();
    // An external provider without PDFs is fine.
    await expect(
      assertOcrStartupPreconditions({ ...base, provider: provider(true) }),
    ).resolves.toBeUndefined();
  });

  it("refuses to start while a CLEAN document is still NOT_STARTED (activation invariant)", async () => {
    await expect(assertOcrStartupPreconditions({ ...base, prisma: prismaWith(2) })).rejects.toThrow(
      /2 CLEAN documents .*activation/,
    );
  });
});
