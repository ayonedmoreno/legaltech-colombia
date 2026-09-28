import { MemoryStorageProvider } from "@legaltech/storage";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AntivirusError,
  type AntivirusProvider,
  type ScanVerdict,
} from "../antivirus/antivirus.js";
import { FakeScanRepository } from "../test-support/scan.repository.fake.js";
import { sanitizedKeyOf, scanDocument, type ScanDocumentDeps } from "./scan-document.js";

const PDF = Buffer.from("%PDF-1.7\nun comparendo\n%%EOF\n");
// SOI, APP1 (EXIF with GPS), SOS + data, EOI.
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.from([0xff, 0xe1, 0x00, 0x18]),
  Buffer.from("Exif\0\0GPSLatitude 4.60", "latin1"),
  Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x55, 0x66, 0xff, 0xd9]),
]);

/** Antivirus stub: answers from a script, one entry per call (the last one repeats). */
class ScriptedAntivirus implements AntivirusProvider {
  calls = 0;
  constructor(private readonly script: Array<ScanVerdict | Error>) {}
  async scan(): Promise<ScanVerdict> {
    const step = this.script[Math.min(this.calls, this.script.length - 1)]!;
    this.calls += 1;
    if (step instanceof Error) throw step;
    return step;
  }
}

const CLEAN: ScanVerdict = { kind: "clean" };

describe("document.scan job", () => {
  let repository: FakeScanRepository;
  let storage: MemoryStorageProvider;

  function deps(antivirus: AntivirusProvider, overrides: Partial<ScanDocumentDeps> = {}) {
    return { repository, storage, antivirus, maxAttempts: 5, leaseSeconds: 600, ...overrides };
  }

  function addDocument(id: string, fileType: "PDF" | "JPEG" | "PNG", content: Buffer) {
    repository.add({ id, fileType, fileSize: content.length });
    const key = repository.documents.get(id)!.storageKey;
    void storage.putObject({ key, body: content, contentType: "application/octet-stream" });
    return key;
  }

  beforeEach(() => {
    repository = new FakeScanRepository();
    storage = new MemoryStorageProvider();
  });

  it("marks a clean PDF CLEAN, with no copy: the original is served untouched", async () => {
    const key = addDocument("d1", "PDF", PDF);

    expect(await scanDocument(deps(new ScriptedAntivirus([CLEAN])), "d1")).toBe("clean");

    const document = repository.documents.get("d1")!;
    expect(document).toMatchObject({ status: "CLEAN", sanitizedStorageKey: null, scanAttempts: 1 });
    expect((await storage.getObject(key)).equals(PDF)).toBe(true);
    expect([...storage.objects.keys()]).toEqual([key]);
    expect(repository.auditLog).toEqual([
      {
        action: "document.scan_clean",
        documentId: "d1",
        caseId: "case-1",
        newValue: { status: "CLEAN" },
      },
    ]);
  });

  it("stores a copy without metadata for a clean JPEG and never touches the original", async () => {
    const key = addDocument("d1", "JPEG", JPEG);

    expect(await scanDocument(deps(new ScriptedAntivirus([CLEAN])), "d1")).toBe("clean");

    expect(repository.documents.get("d1")!.sanitizedStorageKey).toBe(sanitizedKeyOf(key));
    const copy = await storage.getObject(sanitizedKeyOf(key));
    expect(copy.toString("latin1")).not.toContain("GPSLatitude");
    expect((await storage.getObject(key)).equals(JPEG)).toBe(true);
  });

  it("marks an infected document INFECTED with its signature: no copy, original kept private", async () => {
    const key = addDocument("d1", "JPEG", JPEG);
    const antivirus = new ScriptedAntivirus([
      { kind: "infected", signature: "Eicar-Test-Signature" },
    ]);

    expect(await scanDocument(deps(antivirus), "d1")).toBe("infected");

    expect(repository.documents.get("d1")).toMatchObject({
      status: "INFECTED",
      scanSignature: "Eicar-Test-Signature",
      sanitizedStorageKey: null,
    });
    expect([...storage.objects.keys()]).toEqual([key]);
    expect(repository.auditLog.map((e) => e.action)).toEqual(["document.scan_infected"]);
  });

  it.each([
    ["the antivirus is down", new AntivirusError("clamd is unavailable")],
    ["the antivirus gives an unexpected answer", new AntivirusError("unexpected clamd reply")],
    ["the antivirus times out", new AntivirusError("clamd did not answer in 60000 ms")],
  ])("releases the document and rethrows (pg-boss retries) when %s", async (_label, error) => {
    addDocument("d1", "PDF", PDF);

    await expect(scanDocument(deps(new ScriptedAntivirus([error])), "d1")).rejects.toBe(error);

    expect(repository.documents.get("d1")).toMatchObject({
      status: "PENDING_SCAN",
      scanAttempts: 1,
    });
    expect(repository.auditLog).toHaveLength(0);
  });

  it("retries until a later delivery succeeds", async () => {
    addDocument("d1", "PDF", PDF);
    const antivirus = new ScriptedAntivirus([
      new AntivirusError("down"),
      new AntivirusError("down"),
      CLEAN,
    ]);

    await expect(scanDocument(deps(antivirus), "d1")).rejects.toThrow();
    await expect(scanDocument(deps(antivirus), "d1")).rejects.toThrow();
    expect(await scanDocument(deps(antivirus), "d1")).toBe("clean");

    expect(repository.documents.get("d1")).toMatchObject({ status: "CLEAN", scanAttempts: 3 });
  });

  it("ends SCAN_FAILED, never CLEAN, when the last attempt fails", async () => {
    addDocument("d1", "PDF", PDF);
    const antivirus = new ScriptedAntivirus([new AntivirusError("down")]);

    for (let i = 0; i < 2; i++) {
      await expect(scanDocument(deps(antivirus, { maxAttempts: 3 }), "d1")).rejects.toThrow();
    }
    expect(await scanDocument(deps(antivirus, { maxAttempts: 3 }), "d1")).toBe("failed");

    expect(repository.documents.get("d1")).toMatchObject({
      status: "SCAN_FAILED",
      scanAttempts: 3,
    });
    expect(repository.auditLog).toEqual([
      expect.objectContaining({
        action: "document.scan_failed",
        newValue: { status: "SCAN_FAILED", attempts: 3 },
      }),
    ]);
    // Once failed, further deliveries do nothing.
    expect(await scanDocument(deps(new ScriptedAntivirus([CLEAN])), "d1")).toBe("skipped");
  });

  it("treats a missing or altered stored object as an error, never as clean", async () => {
    repository.add({ id: "missing", fileType: "PDF", fileSize: 10 });
    const altered = addDocument("altered", "PDF", PDF);
    void storage.putObject({ key: altered, body: Buffer.from("%PDF-other"), contentType: "x" });
    const antivirus = new ScriptedAntivirus([CLEAN]);

    await expect(scanDocument(deps(antivirus), "missing")).rejects.toThrow();
    await expect(scanDocument(deps(antivirus), "altered")).rejects.toThrow(/size/);

    expect(antivirus.calls).toBe(0);
    expect(repository.documents.get("missing")!.status).toBe("PENDING_SCAN");
    expect(repository.documents.get("altered")!.status).toBe("PENDING_SCAN");
  });

  it("keeps an image blocked when its metadata cannot be removed", async () => {
    addDocument("d1", "JPEG", Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from("corrupt")]));

    await expect(
      scanDocument(deps(new ScriptedAntivirus([CLEAN]), { maxAttempts: 1 }), "d1"),
    ).resolves.toBe("failed");
    expect(repository.documents.get("d1")).toMatchObject({
      status: "SCAN_FAILED",
      sanitizedStorageKey: null,
    });
  });

  it("keeps the document blocked when storing the copy fails after reading the original", async () => {
    addDocument("d1", "JPEG", JPEG);
    const failingPut = Object.assign(Object.create(storage) as MemoryStorageProvider, {
      putObject: () => Promise.reject(new Error("storage write failed")),
    });

    await expect(
      scanDocument(deps(new ScriptedAntivirus([CLEAN]), { storage: failingPut }), "d1"),
    ).rejects.toThrow("storage write failed");
    expect(repository.documents.get("d1")).toMatchObject({
      status: "PENDING_SCAN",
      sanitizedStorageKey: null,
    });
  });

  it("is idempotent: a job for a document already treated does nothing", async () => {
    addDocument("d1", "PDF", PDF);
    const antivirus = new ScriptedAntivirus([CLEAN]);
    await scanDocument(deps(antivirus), "d1");

    expect(await scanDocument(deps(antivirus), "d1")).toBe("skipped");
    expect(await scanDocument(deps(antivirus), "unknown")).toBe("skipped");
    expect(antivirus.calls).toBe(1);
    expect(repository.auditLog).toHaveLength(1);
  });

  it("treats a document once when two deliveries run at the same time", async () => {
    addDocument("d1", "PDF", PDF);
    const antivirus = new ScriptedAntivirus([CLEAN]);

    const outcomes = await Promise.all([
      scanDocument(deps(antivirus), "d1"),
      scanDocument(deps(antivirus), "d1"),
    ]);

    expect(outcomes.sort()).toEqual(["clean", "skipped"]);
    expect(antivirus.calls).toBe(1);
    expect(repository.documents.get("d1")!.scanAttempts).toBe(1);
    expect(repository.auditLog).toHaveLength(1);
  });

  it("lets a new worker take over an abandoned claim, and the old one cannot record a result", async () => {
    addDocument("d1", "PDF", PDF);
    let now = 1_000_000;
    repository.now = () => now;
    // The first worker claims and hangs in the antivirus.
    let finishFirst!: (verdict: ScanVerdict) => void;
    const slow: AntivirusProvider = {
      scan: () => new Promise<ScanVerdict>((resolve) => (finishFirst = resolve)),
    };
    const first = scanDocument(deps(slow), "d1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Within the lease, another delivery does nothing; after it, it takes over.
    expect(await scanDocument(deps(new ScriptedAntivirus([CLEAN])), "d1")).toBe("skipped");
    now += 601_000;
    expect(
      await scanDocument(deps(new ScriptedAntivirus([{ kind: "infected", signature: "X" }])), "d1"),
    ).toBe("infected");

    // The first worker's late "clean" is refused: its claim is gone.
    finishFirst(CLEAN);
    expect(await first).toBe("lost");
    expect(repository.documents.get("d1")!.status).toBe("INFECTED");
    expect(repository.auditLog.map((e) => e.action)).toEqual(["document.scan_infected"]);
  });

  it("never lets an old claim write while another worker holds the current one", async () => {
    addDocument("d1", "JPEG", JPEG);
    let now = 1_000_000;
    repository.now = () => now;
    // Worker A claims and is still processing.
    let finishA!: (verdict: ScanVerdict) => void;
    const first = scanDocument(
      deps({ scan: () => new Promise<ScanVerdict>((resolve) => (finishA = resolve)) }),
      "d1",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A's claim outlives the lease: worker B takes over and is, in turn, still processing.
    now += 601_000;
    let finishB!: (verdict: ScanVerdict) => void;
    const second = scanDocument(
      deps({ scan: () => new Promise<ScanVerdict>((resolve) => (finishB = resolve)) }),
      "d1",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(repository.documents.get("d1")).toMatchObject({ status: "SCANNING", scanAttempts: 2 });

    // A finishes first, while B's claim is valid: A's result must not be written.
    finishA(CLEAN);
    expect(await first).toBe("lost");
    expect(repository.documents.get("d1")).toMatchObject({
      status: "SCANNING",
      sanitizedStorageKey: null,
    });
    expect(repository.auditLog).toHaveLength(0);

    // Only B, the current holder, records the result.
    finishB({ kind: "infected", signature: "Eicar-Test-Signature" });
    expect(await second).toBe("infected");
    expect(repository.documents.get("d1")).toMatchObject({
      status: "INFECTED",
      sanitizedStorageKey: null,
    });
    expect(repository.auditLog.map((e) => e.action)).toEqual(["document.scan_infected"]);
  });
});
