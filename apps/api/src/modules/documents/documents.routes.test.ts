import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cookieHeader, findSetCookie } from "../../test-support/cookies.js";
import { buildTestApp } from "../../test-support/build-test-app.js";
import type { AuditLogEntry } from "../auth/auth.types.js";
import { FakeDocumentsRepository } from "./documents.repository.fake.js";
import { MemoryStorageProvider } from "@legaltech/storage";
import { FakeCasesRepository } from "../cases/cases.repository.fake.js";

/**
 * /api/cases/:caseId/documents, first Documents slice (API_SPEC.md): a USER uploads PDF, JPEG
 * or PNG files (by content) to their own DRAFT cases, lists them and gets a short-lived
 * download URL; everything else about other users' cases answers 404.
 */
const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct horse battery";
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;
interface Login {
  userId: string;
  sessionRaw: string;
  csrfRaw: string;
}

async function registerAndLogin(testApp: TestApp, email: string): Promise<Login> {
  await testApp.app.inject({
    method: "POST",
    url: "/api/auth/register",
    remoteAddress: `10.0.1.${testApp.repository.users.size + 1}`,
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password: PASSWORD, fullName: "Ana Gómez" },
  });
  const response = await testApp.app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password: PASSWORD },
  });
  return {
    userId: response.json().user.id,
    sessionRaw: findSetCookie(response.headers["set-cookie"], "__Host-session")!.value,
    csrfRaw: findSetCookie(response.headers["set-cookie"], "__Host-csrf")!.value,
  };
}

async function newCase(testApp: TestApp, as: Login): Promise<string> {
  const response = await testApp.app.inject({
    method: "POST",
    url: "/api/cases",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": as.csrfRaw,
      cookie: cookieHeader({ "__Host-session": as.sessionRaw, "__Host-csrf": as.csrfRaw }),
    },
    payload: { type: "TRAFFIC_CITATION" },
  });
  return response.json().case.id;
}

function upload(
  testApp: TestApp,
  as: Login | undefined,
  caseId: string,
  content: Buffer | string,
  options: {
    fileName?: string | null;
    contentType?: string;
    csrf?: string | null;
    origin?: string | null;
  } = {},
) {
  const headers: Record<string, string> = {
    "content-type": options.contentType ?? "application/octet-stream",
  };
  const fileName = options.fileName === undefined ? "comparendo.pdf" : options.fileName;
  if (fileName !== null) headers["x-file-name"] = encodeURIComponent(fileName);
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin) headers.origin = origin;
  const csrf = options.csrf === undefined ? as?.csrfRaw : options.csrf;
  if (csrf) headers["x-csrf-token"] = csrf;
  if (as) {
    headers.cookie = cookieHeader({ "__Host-session": as.sessionRaw, "__Host-csrf": as.csrfRaw });
  }
  return testApp.app.inject({
    method: "POST",
    url: `/api/cases/${caseId}/documents`,
    headers,
    payload: content,
  });
}

function get(testApp: TestApp, as: Login | undefined, url: string) {
  return testApp.app.inject({
    method: "GET",
    url,
    headers: as ? { cookie: cookieHeader({ "__Host-session": as.sessionRaw }) } : {},
  });
}

const uploadedEvents = (testApp: TestApp) =>
  testApp.documentsRepository.auditLog.filter((e) => e.action === "document.uploaded");

describe("POST /api/cases/:caseId/documents", () => {
  it("stores the file and its metadata PENDING_SCAN / NOT_STARTED, with its event and scan job", async () => {
    const testApp = await buildTestApp();
    const ana = await registerAndLogin(testApp, "ana@example.com");
    const caseId = await newCase(testApp, ana);

    const response = await upload(testApp, ana, caseId, PDF, { fileName: "Resolución 1.pdf" });

    expect(response.statusCode).toBe(201);
    const { document } = response.json();
    expect(document).toEqual({
      id: expect.any(String),
      fileName: "Resolución 1.pdf",
      fileType: "PDF",
      fileSize: PDF.length,
      status: "PENDING_SCAN",
      ocrStatus: "NOT_STARTED",
      createdAt: expect.any(String),
    });
    const stored = testApp.documentsRepository.documents.get(document.id)!;
    expect(stored.storageKey).toBe(`cases/${caseId}/documents/${document.id}`);
    expect(stored.uploadedByUserId).toBe(ana.userId);
    // The file is in storage, under a key without its name, with the detected type.
    const object = testApp.storage.objects.get(stored.storageKey)!;
    expect(object.body.equals(PDF)).toBe(true);
    expect(object.contentType).toBe("application/pdf");
    // Neither the key nor the uploader is sent back.
    expect(JSON.stringify(response.json())).not.toContain("cases/");
    expect(uploadedEvents(testApp)).toEqual([
      expect.objectContaining({
        actorUserId: ana.userId,
        entityType: "Document",
        entityId: document.id,
        caseId,
        newValue: { fileType: "PDF", fileSize: PDF.length, status: "PENDING_SCAN" },
      }),
    ]);
    // The file name is never written to the audit log.
    expect(JSON.stringify(uploadedEvents(testApp))).not.toContain("Resoluci");
  });

  it("detects the type from the content, not from the name or the Content-Type", async () => {
    const testApp = await buildTestApp();
    const ana = await registerAndLogin(testApp, "ana@example.com");
    const caseId = await newCase(testApp, ana);

    const png = await upload(testApp, ana, caseId, PNG, { fileName: "foto.pdf" });
    expect(png.json().document.fileType).toBe("PNG");

    const fake = await upload(testApp, ana, caseId, "<html>no soy un pdf</html>", {
      fileName: "documento.pdf",
    });
    expect(fake.statusCode).toBe(400);
    expect(fake.json().error.code).toBe("VALIDATION_ERROR");
    expect(testApp.documentsRepository.documents.size).toBe(1);
    expect(testApp.storage.objects.size).toBe(1);
  });

  it.each([
    ["no X-File-Name", null],
    ["an empty name", ""],
    ["a path", "../../etc/passwd.pdf"],
    ["a name longer than 255", `${"a".repeat(252)}.pdf`],
  ])("rejects %s with 400 and stores nothing", async (_label, fileName) => {
    const testApp = await buildTestApp();
    const ana = await registerAndLogin(testApp, "ana@example.com");
    const caseId = await newCase(testApp, ana);

    const response = await upload(testApp, ana, caseId, PDF, { fileName });

    expect(response.statusCode).toBe(400);
    expect(testApp.storage.objects.size).toBe(0);
    expect(testApp.documentsRepository.documents.size).toBe(0);
  });

  it("rejects an empty body (400) and another Content-Type (415)", async () => {
    const testApp = await buildTestApp();
    const ana = await registerAndLogin(testApp, "ana@example.com");
    const caseId = await newCase(testApp, ana);

    expect((await upload(testApp, ana, caseId, Buffer.alloc(0))).statusCode).toBe(400);
    const json = await upload(testApp, ana, caseId, JSON.stringify({ a: 1 }), {
      contentType: "application/json",
    });
    expect(json.statusCode).toBe(415);
    expect(json.json().error.code).toBe("VALIDATION_ERROR");
    const pdf = await upload(testApp, ana, caseId, PDF, { contentType: "application/pdf" });
    expect(pdf.statusCode).toBe(415);
    expect(testApp.storage.objects.size).toBe(0);
  });

  it("answers 413 PAYLOAD_TOO_LARGE above the limit, and accepts exactly the limit", async () => {
    const limit = 64;
    const testApp = await buildTestApp({ documentMaxBytes: limit });
    const ana = await registerAndLogin(testApp, "ana@example.com");
    const caseId = await newCase(testApp, ana);
    const atLimit = Buffer.concat([PDF, Buffer.alloc(limit - PDF.length, 0x20)]);

    expect((await upload(testApp, ana, caseId, atLimit)).statusCode).toBe(201);
    const over = await upload(testApp, ana, caseId, Buffer.concat([atLimit, Buffer.from(" ")]));
    expect(over.statusCode).toBe(413);
    expect(over.json().error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(testApp.storage.objects.size).toBe(1);
  });

  it("checks the session before reading the body: 401 even for an oversized upload", async () => {
    const testApp = await buildTestApp({ documentMaxBytes: 64 });
    const response = await upload(testApp, undefined, randomUUID(), Buffer.alloc(1024));
    expect(response.statusCode).toBe(401);
  });

  it.each([
    ["without the CSRF header", { csrf: null }],
    ["with a wrong CSRF token", { csrf: "wrong" }],
    ["from another origin", { origin: "https://evil.example" }],
  ])("answers 403 %s and stores nothing", async (_label, options) => {
    const testApp = await buildTestApp();
    const ana = await registerAndLogin(testApp, "ana@example.com");
    const caseId = await newCase(testApp, ana);

    const response = await upload(testApp, ana, caseId, PDF, options);

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("CSRF_INVALID");
    expect(testApp.storage.objects.size).toBe(0);
  });

  it("answers another user's case, an unknown case and a malformed id with the same 404", async () => {
    const testApp = await buildTestApp();
    const ana = await registerAndLogin(testApp, "ana@example.com");
    const luis = await registerAndLogin(testApp, "luis@example.com");
    const anasCase = await newCase(testApp, ana);

    for (const caseId of [anasCase, randomUUID(), "not-a-uuid"]) {
      const response = await upload(testApp, luis, caseId, PDF);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("NOT_FOUND");
    }
    expect(testApp.storage.objects.size).toBe(0);
    expect(uploadedEvents(testApp)).toHaveLength(0);
  });

  it("refuses a case that is not in DRAFT (403) without storing anything", async () => {
    const testApp = await buildTestApp();
    const ana = await registerAndLogin(testApp, "ana@example.com");
    const caseId = await newCase(testApp, ana);
    // No transition exists yet: the state is set directly to check the guard.
    testApp.casesRepository.cases.get(caseId)!.status = "PAID";

    const response = await upload(testApp, ana, caseId, PDF);

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
    expect(testApp.storage.objects.size).toBe(0);
  });

  it("removes the stored file when the metadata and event cannot be written", async () => {
    const cases = new FakeCasesRepository();
    class FailingAuditRepository extends FakeDocumentsRepository {
      protected override recordAudit(_entry: AuditLogEntry): void {
        throw new Error("audit write failed");
      }
    }
    const storage = new MemoryStorageProvider();
    const testApp = await buildTestApp({
      casesRepository: cases,
      documentsRepository: new FailingAuditRepository(cases),
      storage,
    });
    const ana = await registerAndLogin(testApp, "ana@example.com");
    const caseId = await newCase(testApp, ana);

    const response = await upload(testApp, ana, caseId, PDF);

    expect(response.statusCode).toBe(500);
    expect(testApp.documentsRepository.documents.size).toBe(0);
    expect(storage.objects.size).toBe(0);
  });

  it.each(["PROFESSIONAL", "ADMIN", "SUPER_ADMIN"] as const)(
    "gives %s a 404 on every documents endpoint",
    async (role) => {
      const testApp = await buildTestApp();
      const staff = await registerAndLogin(testApp, "staff@legaltech.test");
      const caseId = await newCase(testApp, staff);
      testApp.repository.users.get(staff.userId)!.role = role;

      expect((await upload(testApp, staff, caseId, PDF)).statusCode).toBe(404);
      expect((await get(testApp, staff, `/api/cases/${caseId}/documents`)).statusCode).toBe(404);
      expect(testApp.storage.objects.size).toBe(0);
    },
  );
});

describe("GET /api/cases/:caseId/documents", () => {
  it("lists the documents of the caller's case, most recent first", async () => {
    let now = new Date("2026-09-27T12:00:00.000Z");
    const testApp = await buildTestApp({ clock: () => now });
    const ana = await registerAndLogin(testApp, "ana@example.com");
    const caseId = await newCase(testApp, ana);
    const otherCase = await newCase(testApp, ana);
    const first = (await upload(testApp, ana, caseId, PDF)).json().document;
    now = new Date(now.getTime() + 1_000);
    const second = (await upload(testApp, ana, caseId, PNG, { fileName: "foto.png" })).json()
      .document;
    await upload(testApp, ana, otherCase, PDF);

    const response = await get(testApp, ana, `/api/cases/${caseId}/documents`);

    expect(response.statusCode).toBe(200);
    expect(response.json().documents.map((d: { id: string }) => d.id)).toEqual([
      second.id,
      first.id,
    ]);
  });

  it("answers 401 without a session and 404 for another user's case", async () => {
    const testApp = await buildTestApp();
    const ana = await registerAndLogin(testApp, "ana@example.com");
    const luis = await registerAndLogin(testApp, "luis@example.com");
    const caseId = await newCase(testApp, ana);
    await upload(testApp, ana, caseId, PDF);

    expect((await get(testApp, undefined, `/api/cases/${caseId}/documents`)).statusCode).toBe(401);
    const foreign = await get(testApp, luis, `/api/cases/${caseId}/documents`);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).not.toContain("comparendo");
  });
});

/** What the worker writes at the end of a treatment (the fake stands in for PostgreSQL). */
function setScanResult(
  testApp: TestApp,
  documentId: string,
  status: "UPLOADED" | "PENDING_SCAN" | "SCANNING" | "CLEAN" | "INFECTED" | "SCAN_FAILED",
  sanitizedStorageKey: string | null = null,
) {
  const stored = testApp.documentsRepository.documents.get(documentId)!;
  stored.status = status;
  stored.sanitizedStorageKey = sanitizedStorageKey;
}

describe("GET /api/cases/:caseId/documents/:documentId/download", () => {
  it("returns a short-lived URL for a CLEAN PDF: the untouched original, uncached, without auditing", async () => {
    const now = new Date("2026-09-27T12:00:00.000Z");
    const testApp = await buildTestApp({ clock: () => now });
    const ana = await registerAndLogin(testApp, "ana@example.com");
    const caseId = await newCase(testApp, ana);
    const document = (
      await upload(testApp, ana, caseId, PDF, { fileName: "Resolución.pdf" })
    ).json().document;
    setScanResult(testApp, document.id, "CLEAN");

    const response = await get(
      testApp,
      ana,
      `/api/cases/${caseId}/documents/${document.id}/download`,
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      url: expect.stringContaining(`cases/${caseId}/documents/${document.id}`),
      expiresAt: "2026-09-27T12:01:00.000Z",
    });
    expect(testApp.storage.downloadUrls).toEqual([
      expect.objectContaining({
        key: `cases/${caseId}/documents/${document.id}`,
        fileName: "Resolución.pdf",
        expiresInSeconds: 60,
      }),
    ]);
    expect(testApp.documentsRepository.auditLog).toHaveLength(1); // only the upload
  });

  it("serves the copy without metadata for a CLEAN image, never its original", async () => {
    const testApp = await buildTestApp();
    const ana = await registerAndLogin(testApp, "ana@example.com");
    const caseId = await newCase(testApp, ana);
    const document = (await upload(testApp, ana, caseId, PNG, { fileName: "foto.png" })).json()
      .document;
    const original = `cases/${caseId}/documents/${document.id}`;
    setScanResult(testApp, document.id, "CLEAN", `${original}.sanitized`);

    const response = await get(
      testApp,
      ana,
      `/api/cases/${caseId}/documents/${document.id}/download`,
    );

    expect(response.statusCode).toBe(200);
    expect(testApp.storage.downloadUrls.map((u) => u.key)).toEqual([`${original}.sanitized`]);
  });

  it("refuses a CLEAN image whose copy without metadata is missing: its original is never served", async () => {
    const testApp = await buildTestApp();
    const ana = await registerAndLogin(testApp, "ana@example.com");
    const caseId = await newCase(testApp, ana);
    const document = (await upload(testApp, ana, caseId, PNG, { fileName: "foto.png" })).json()
      .document;
    setScanResult(testApp, document.id, "CLEAN", null);

    const response = await get(
      testApp,
      ana,
      `/api/cases/${caseId}/documents/${document.id}/download`,
    );

    expect(response.statusCode).toBe(403);
    expect(testApp.storage.downloadUrls).toHaveLength(0);
  });

  it("is blocked right after the upload: the document waits for its security treatment", async () => {
    const testApp = await buildTestApp();
    const ana = await registerAndLogin(testApp, "ana@example.com");
    const caseId = await newCase(testApp, ana);
    const document = (await upload(testApp, ana, caseId, PDF)).json().document;

    const response = await get(
      testApp,
      ana,
      `/api/cases/${caseId}/documents/${document.id}/download`,
    );

    expect(document.status).toBe("PENDING_SCAN");
    expect(testApp.documentsRepository.enqueuedScans).toEqual([document.id]);
    expect(response.statusCode).toBe(403);
    expect(testApp.storage.downloadUrls).toHaveLength(0);
  });

  it.each(["UPLOADED", "PENDING_SCAN", "SCANNING", "INFECTED", "SCAN_FAILED"] as const)(
    "never issues a URL for a %s document: 403 with one generic message",
    async (status) => {
      const testApp = await buildTestApp();
      const ana = await registerAndLogin(testApp, "ana@example.com");
      const caseId = await newCase(testApp, ana);
      const pdf = (await upload(testApp, ana, caseId, PDF)).json().document;
      const png = (await upload(testApp, ana, caseId, PNG, { fileName: "f.png" })).json().document;
      // Even with a copy recorded, only CLEAN may be served.
      setScanResult(testApp, pdf.id, status);
      setScanResult(testApp, png.id, status, `cases/${caseId}/documents/${png.id}.sanitized`);

      for (const document of [pdf, png]) {
        const response = await get(
          testApp,
          ana,
          `/api/cases/${caseId}/documents/${document.id}/download`,
        );
        expect(response.statusCode).toBe(403);
        expect(response.json().error).toMatchObject({
          code: "FORBIDDEN",
          message: "El documento no está disponible para descarga.",
        });
      }
      expect(testApp.storage.downloadUrls).toHaveLength(0);
    },
  );

  it("answers the same 404 for another user's document, another case's id and bad ids (IDOR)", async () => {
    const testApp = await buildTestApp();
    const ana = await registerAndLogin(testApp, "ana@example.com");
    const luis = await registerAndLogin(testApp, "luis@example.com");
    const anasCase = await newCase(testApp, ana);
    const anasOtherCase = await newCase(testApp, ana);
    const luisCase = await newCase(testApp, luis);
    const doc = (await upload(testApp, ana, anasCase, PDF)).json().document;

    const attempts = [
      [luis, `/api/cases/${anasCase}/documents/${doc.id}/download`],
      [luis, `/api/cases/${luisCase}/documents/${doc.id}/download`],
      [ana, `/api/cases/${anasOtherCase}/documents/${doc.id}/download`],
      [ana, `/api/cases/${anasCase}/documents/${randomUUID()}/download`],
      [ana, `/api/cases/${anasCase}/documents/not-a-uuid/download`],
    ] as const;
    for (const [as, url] of attempts) {
      const response = await get(testApp, as, url);
      expect(response.statusCode, url).toBe(404);
      expect(response.json().error.code).toBe("NOT_FOUND");
    }
    expect(testApp.storage.downloadUrls).toHaveLength(0);
  });

  it("needs a session (401)", async () => {
    const testApp = await buildTestApp();
    const url = `/api/cases/${randomUUID()}/documents/${randomUUID()}/download`;
    expect((await get(testApp, undefined, url)).statusCode).toBe(401);
  });
});
