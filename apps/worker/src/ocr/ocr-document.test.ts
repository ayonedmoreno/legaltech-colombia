import { createHash } from "node:crypto";
import { MemoryStorageProvider } from "@legaltech/storage";
import { describe, expect, it } from "vitest";
import { FakeOcrRepository } from "../test-support/ocr.repository.fake.js";
import { normalizeOcrText } from "./normalize-text.js";
import { ocrDocument, type OcrDocumentDeps } from "./ocr-document.js";
import { OcrProviderError, type OcrInput, type OcrProvider } from "./ocr-provider.js";
import type { OcrTextInput, OcrTextStore } from "./ocr-text-store.js";

const ID = "7b1f5c2e-0d4a-4a4e-9a38-3d5c1f0e2b11";
const ORIGINAL = Buffer.from("original-jpeg-bytes");
const SANITIZED = Buffer.from("sanitized-jpeg-bytes");
const SECRET = "Comparendo 123456 de Ana Gómez";

class FakeProvider implements OcrProvider {
  readonly engine = "fake-ocr";
  readonly external = false;
  calls: OcrInput[] = [];
  constructor(
    private readonly answer: () => Promise<{ pages: string[]; engineVersion: string | null }>,
  ) {}
  recognize(input: OcrInput) {
    this.calls.push(input);
    return this.answer();
  }
}

class FakeTextStore implements OcrTextStore {
  saved: OcrTextInput[] = [];
  fail = false;
  async save(input: OcrTextInput): Promise<void> {
    if (this.fail) throw new Error(`text store down: ${input.pages.join(" ")}`);
    this.saved.push(input);
  }
}

async function setup(
  answer: () => Promise<{ pages: string[]; engineVersion: string | null }>,
  options: Partial<OcrDocumentDeps> & { fileType?: "PDF" | "JPEG" | "PNG"; attempts?: number } = {},
) {
  const repository = new FakeOcrRepository();
  const storage = new MemoryStorageProvider();
  const doc = repository.add({
    id: ID,
    fileType: options.fileType ?? "JPEG",
    fileSize: ORIGINAL.length,
    ocrAttempts: options.attempts ?? 0,
  });
  await storage.putObject({ key: doc.storageKey, body: ORIGINAL, contentType: "image/jpeg" });
  await storage.putObject({
    key: doc.sanitizedStorageKey!,
    body: SANITIZED,
    contentType: "image/jpeg",
  });
  const provider = new FakeProvider(answer);
  const textStore = new FakeTextStore();
  const events: Array<Record<string, unknown>> = [];
  let n = 0;
  const deps: OcrDocumentDeps = {
    repository,
    storage,
    provider,
    textStore,
    imageRepresentation: "SANITIZED",
    maxAttempts: 3,
    leaseSeconds: 600,
    maxPages: 5,
    retryDelaySeconds: 30,
    log: (event) => events.push(event),
    newId: () => `00000000-0000-4000-8000-00000000000${++n}`,
    ...options,
  };
  return { repository, storage, provider, textStore, events, deps, doc };
}

const ok =
  (pages: string[], engineVersion: string | null = "1.0") =>
  async () => ({
    pages,
    engineVersion,
  });
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe('ocrDocument (DATABASE_SPEC.md, "OCR del documento")', () => {
  it("processes the configured representation and records the normalized text per page", async () => {
    const t = await setup(ok(["Café 1\r\nlínea 2", "página\r3"]));

    expect(await ocrDocument(t.deps, ID)).toBe("completed");

    expect(t.provider.calls).toHaveLength(1);
    expect(t.provider.calls[0]!.content.equals(SANITIZED)).toBe(true);
    expect(t.provider.calls[0]!.contentType).toBe("image/jpeg");
    expect(t.textStore.saved).toEqual([
      {
        executionId: "00000000-0000-4000-8000-000000000001",
        documentId: ID,
        caseId: t.doc.caseId,
        pages: ["Café 1\nlínea 2", "página\n3"],
      },
    ]);
    // The text and the result belong to one execution, whose id the worker generated.
    expect(t.repository.completed).toEqual([
      {
        documentId: ID,
        execution: {
          id: "00000000-0000-4000-8000-000000000001",
          engine: "fake-ocr",
          engineVersion: "1.0",
          representation: "SANITIZED",
          processedSha256: sha(SANITIZED),
          pages: 2,
        },
      },
    ]);
  });

  it("reads the original when configured, and refuses an original that changed size", async () => {
    const t = await setup(ok(["x"]), { imageRepresentation: "ORIGINAL" });
    expect(await ocrDocument(t.deps, ID)).toBe("completed");
    expect(t.provider.calls[0]!.content.equals(ORIGINAL)).toBe(true);
    expect(t.repository.completed[0]!.execution.representation).toBe("ORIGINAL");

    const changed = await setup(ok(["x"]), { imageRepresentation: "ORIGINAL" });
    changed.doc.fileSize = ORIGINAL.length + 1;
    expect(await ocrDocument(changed.deps, ID)).toBe("failed");
    expect(changed.provider.calls).toHaveLength(0);
    expect(changed.repository.failed[0]!.execution.errorCode).toBe("object_mismatch");
  });

  it("processes a PDF as received, whatever the image representation", async () => {
    const t = await setup(ok(["p1"]), { fileType: "PDF" });
    expect(await ocrDocument(t.deps, ID)).toBe("completed");
    expect(t.provider.calls[0]!.content.equals(ORIGINAL)).toBe(true);
    expect(t.provider.calls[0]!.contentType).toBe("application/pdf");
    expect(t.repository.completed[0]!.execution.representation).toBe("ORIGINAL");
  });

  it("does nothing, and never calls the provider, without a valid claim", async () => {
    for (const state of ["NOT_STARTED", "PROCESSING", "COMPLETED", "FAILED", "EXCLUDED"] as const) {
      const t = await setup(ok(["x"]));
      t.doc.ocrStatus = state;
      expect(await ocrDocument(t.deps, ID)).toBe("skipped");
      expect(t.provider.calls).toHaveLength(0);
    }
    const notClean = await setup(ok(["x"]));
    notClean.doc.status = "SCAN_FAILED";
    expect(await ocrDocument(notClean.deps, ID)).toBe("skipped");
    expect(notClean.provider.calls).toHaveLength(0);
  });

  it("retries a transient error with a growing delay while attempts are left", async () => {
    const t = await setup(async () => {
      throw new OcrProviderError("transient", "rate_limited", 429);
    });

    expect(await ocrDocument(t.deps, ID)).toBe("retry");
    expect(await ocrDocument(t.deps, ID)).toBe("retry");
    expect(t.repository.retries.map((r) => r.delaySeconds)).toEqual([30, 60]);
    expect(t.repository.failed).toEqual([]);

    // The last attempt ends FAILED with the normalized code.
    expect(await ocrDocument(t.deps, ID)).toBe("failed");
    expect(t.repository.failed).toEqual([
      {
        documentId: ID,
        execution: expect.objectContaining({ errorCode: "rate_limited", engine: "fake-ocr" }),
      },
    ]);
  });

  it("caps the retry delay at one hour", async () => {
    const t = await setup(
      async () => {
        throw new OcrProviderError("transient", "timeout");
      },
      { maxAttempts: 20, retryDelaySeconds: 3000 },
    );
    await ocrDocument(t.deps, ID);
    await ocrDocument(t.deps, ID);
    expect(t.repository.retries.map((r) => r.delaySeconds)).toEqual([3000, 3600]);
  });

  it("ends a permanent error at once, without retrying (it would only cost money)", async () => {
    const t = await setup(async () => {
      throw new OcrProviderError("permanent", "unsupported_document", 400);
    });

    expect(await ocrDocument(t.deps, ID)).toBe("failed");
    expect(t.provider.calls).toHaveLength(1);
    expect(t.repository.retries).toEqual([]);
    expect(t.repository.failed[0]!.execution).toMatchObject({
      errorCode: "unsupported_document",
      representation: "SANITIZED",
      processedSha256: sha(SANITIZED),
    });
  });

  it("refuses more pages than allowed, without storing any text", async () => {
    const t = await setup(ok(["1", "2", "3", "4", "5", "6"]));
    expect(await ocrDocument(t.deps, ID)).toBe("failed");
    expect(t.provider.calls[0]!.maxPages).toBe(5);
    expect(t.textStore.saved).toEqual([]);
    expect(t.repository.failed[0]!.execution.errorCode).toBe("too_many_pages");
  });

  it("classifies storage, provider and text-store failures without their messages", async () => {
    const missing = await setup(ok(["x"]));
    await missing.storage.deleteObject(missing.doc.sanitizedStorageKey!);
    expect(await ocrDocument(missing.deps, ID)).toBe("failed");
    expect(missing.repository.failed[0]!.execution.errorCode).toBe("object_missing");

    const noCopy = await setup(ok(["x"]));
    noCopy.doc.sanitizedStorageKey = null;
    expect(await ocrDocument(noCopy.deps, ID)).toBe("failed");
    expect(noCopy.repository.failed[0]!.execution.errorCode).toBe("object_missing");

    const crash = await setup(async () => {
      throw new Error(`provider exploded while reading: ${SECRET}`);
    });
    expect(await ocrDocument(crash.deps, ID)).toBe("retry");

    const malformed = await setup(async () => ({
      pages: [42 as unknown as string],
      engineVersion: null,
    }));
    expect(await ocrDocument(malformed.deps, ID)).toBe("retry");

    const store = await setup(ok([SECRET]));
    store.textStore.fail = true;
    expect(await ocrDocument(store.deps, ID)).toBe("retry");

    const codes = [crash, malformed, store].map((t) => t.events[0]!.code);
    expect(codes).toEqual(["provider_error", "invalid_response", "text_store_unavailable"]);
  });

  it("never logs text, a provider's message or a file name: codes, kinds and statuses only", async () => {
    const leaking = await setup(async () => {
      throw new OcrProviderError("transient", "provider_unavailable", 503);
    });
    await ocrDocument(leaking.deps, ID);
    const crashing = await setup(async () => {
      throw new Error(`echo of the document: ${SECRET}`);
    });
    await ocrDocument(crashing.deps, ID);
    const completed = await setup(ok([SECRET]));
    await ocrDocument(completed.deps, ID);

    const all = JSON.stringify([...leaking.events, ...crashing.events, ...completed.events]);
    expect(all).not.toContain("Gómez");
    expect(all).not.toContain("123456");
    expect(leaking.events).toEqual([
      {
        level: "warn",
        event: "ocr.error",
        document: ID,
        code: "provider_unavailable",
        kind: "transient",
        httpStatus: 503,
        attempts: 1,
      },
    ]);
    expect(completed.events).toEqual([]);
  });

  it("reports a lost claim, and never records a result for it", async () => {
    const t = await setup(async () => {
      t.repository.steal(ID);
      return { pages: ["x"], engineVersion: null };
    });
    expect(await ocrDocument(t.deps, ID)).toBe("lost");
    expect(t.repository.completed).toEqual([]);
  });

  it("lets a database failure while recording the result propagate (not an OCR error)", async () => {
    const t = await setup(ok(["x"]));
    t.repository.markCompleted = () => Promise.reject(new Error("database unavailable"));
    await expect(ocrDocument(t.deps, ID)).rejects.toThrow("database unavailable");
    expect(t.repository.failed).toEqual([]);
    expect(t.repository.retries).toEqual([]);
  });
});

describe("normalizeOcrText (decision OCR-A10.4, n1)", () => {
  it("applies NFC and line endings only, keeping case, spacing and characters", () => {
    expect(normalizeOcrText("Café\r\nPLACA  ABC-123\rfin")).toBe("Café\nPLACA  ABC-123\nfin");
    expect(normalizeOcrText(" O0 l1 ")).toBe(" O0 l1 ");
  });
});
