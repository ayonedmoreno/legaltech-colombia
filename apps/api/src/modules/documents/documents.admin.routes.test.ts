import { randomUUID } from "node:crypto";
import type { Role } from "@legaltech/database";
import { describe, expect, it } from "vitest";
import { buildTestApp } from "../../test-support/build-test-app.js";
import { cookieHeader, findSetCookie } from "../../test-support/cookies.js";

/**
 * POST /api/admin/documents/:documentId/reprocess (API_SPEC.md; decision of 2026-10-01): only an
 * ADMIN, with session, CSRF and a justification, and only for a SCAN_FAILED document. The request
 * is audited and queued; the worker does the transition.
 */
const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct horse battery";
const PDF = Buffer.from("%PDF-1.7\n%%EOF\n");

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;

async function login(testApp: TestApp, email: string, role: Role = "USER") {
  await testApp.app.inject({
    method: "POST",
    url: "/api/auth/register",
    remoteAddress: `10.0.2.${testApp.repository.users.size + 1}`,
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password: PASSWORD, fullName: "Persona" },
  });
  const user = [...testApp.repository.users.values()].find((u) => u.email === email)!;
  user.role = role;
  const response = await testApp.app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password: PASSWORD },
  });
  const sessionRaw = findSetCookie(response.headers["set-cookie"], "__Host-session")!.value;
  const csrfRaw = findSetCookie(response.headers["set-cookie"], "__Host-csrf")!.value;
  return { user, sessionRaw, csrfRaw };
}

type Login = Awaited<ReturnType<typeof login>>;

function headersOf(as: Login, csrf: string | null = as.csrfRaw) {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    "content-type": "application/json",
    cookie: cookieHeader({ "__Host-session": as.sessionRaw, "__Host-csrf": as.csrfRaw }),
  };
  if (csrf) headers["x-csrf-token"] = csrf;
  return headers;
}

/**
 * A user's document, uploaded through the API, then set to `status` and `ocrStatus` (as the worker
 * would).
 */
async function documentIn(testApp: TestApp, status: string, ocrStatus = "NOT_STARTED") {
  const owner = await login(testApp, `owner-${randomUUID()}@example.com`);
  const created = await testApp.app.inject({
    method: "POST",
    url: "/api/cases",
    headers: headersOf(owner),
    payload: { type: "OTHER" },
  });
  const caseId = created.json().case.id;
  const uploaded = await testApp.app.inject({
    method: "POST",
    url: `/api/cases/${caseId}/documents`,
    headers: {
      ...headersOf(owner),
      "content-type": "application/octet-stream",
      "x-file-name": "comparendo.pdf",
    },
    payload: PDF,
  });
  const id: string = uploaded.json().document.id;
  const stored = testApp.documentsRepository.documents.get(id)!;
  stored.status = status as typeof stored.status;
  stored.ocrStatus = ocrStatus as typeof stored.ocrStatus;
  return { id, caseId };
}

function reprocess(
  testApp: TestApp,
  as: Login | undefined,
  documentId: string,
  payload: unknown = { reason: "ClamAV no estuvo disponible" },
  csrf?: string | null,
) {
  return testApp.app.inject({
    method: "POST",
    url: `/api/admin/documents/${documentId}/reprocess`,
    headers: as ? headersOf(as, csrf === undefined ? as.csrfRaw : csrf) : { origin: ORIGIN },
    payload: payload as object,
  });
}

const requested = (testApp: TestApp) =>
  testApp.documentsRepository.auditLog.filter((e) => e.action === "document.reprocess_requested");

describe("POST /api/admin/documents/:documentId/reprocess", () => {
  it("lets an ADMIN ask for a SCAN_FAILED document to be treated again: audited and queued", async () => {
    const testApp = await buildTestApp();
    const doc = await documentIn(testApp, "SCAN_FAILED");
    const admin = await login(testApp, "admin@example.com", "ADMIN");

    const response = await reprocess(testApp, admin, doc.id);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "accepted" });
    expect(testApp.documentsRepository.enqueuedReprocesses).toEqual([doc.id]);
    const [event] = requested(testApp);
    expect(event).toMatchObject({
      actorUserId: admin.user.id,
      actorRole: "ADMIN",
      entityType: "Document",
      entityId: doc.id,
      caseId: doc.caseId,
      metadata: { reason: "ClamAV no estuvo disponible" },
    });
    expect(JSON.stringify(event)).not.toContain("comparendo");
    // The API does not change the state: the worker does, only if it is still SCAN_FAILED.
    expect(testApp.documentsRepository.documents.get(doc.id)!.status).toBe("SCAN_FAILED");
  });

  it.each(["USER", "PROFESSIONAL", "SUPER_ADMIN"] as const)(
    "answers 404 to a %s, even the document's owner, and queues nothing",
    async (role) => {
      const testApp = await buildTestApp();
      const doc = await documentIn(testApp, "SCAN_FAILED");
      const someone = await login(testApp, `someone-${role.toLowerCase()}@example.com`, role);

      const response = await reprocess(testApp, someone, doc.id);

      expect(response.statusCode).toBe(404);
      expect(testApp.documentsRepository.enqueuedReprocesses).toEqual([]);
      expect(requested(testApp)).toHaveLength(0);
    },
  );

  it("needs a session (401) and the CSRF token (403)", async () => {
    const testApp = await buildTestApp();
    const doc = await documentIn(testApp, "SCAN_FAILED");
    const admin = await login(testApp, "admin@example.com", "ADMIN");

    expect((await reprocess(testApp, undefined, doc.id)).statusCode).toBe(401);
    const noCsrf = await reprocess(testApp, admin, doc.id, undefined, null);
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe("CSRF_INVALID");
    expect(testApp.documentsRepository.enqueuedReprocesses).toEqual([]);
  });

  it("answers 404 for an unknown or malformed id, and 400 without a justification", async () => {
    const testApp = await buildTestApp();
    const admin = await login(testApp, "admin@example.com", "ADMIN");
    const doc = await documentIn(testApp, "SCAN_FAILED");

    expect((await reprocess(testApp, admin, randomUUID())).statusCode).toBe(404);
    expect((await reprocess(testApp, admin, "not-a-uuid")).statusCode).toBe(404);
    expect((await reprocess(testApp, admin, doc.id, {})).statusCode).toBe(400);
    expect((await reprocess(testApp, admin, doc.id, { reason: "   " })).statusCode).toBe(400);
    expect(
      (await reprocess(testApp, admin, doc.id, { reason: "x", status: "CLEAN" })).statusCode,
    ).toBe(400);
    expect(testApp.documentsRepository.enqueuedReprocesses).toEqual([]);
  });

  it.each(["UPLOADED", "PENDING_SCAN", "SCANNING", "CLEAN", "INFECTED"])(
    "refuses a %s document (403): only a failed treatment can be retried",
    async (status) => {
      const testApp = await buildTestApp();
      const doc = await documentIn(testApp, status);
      const admin = await login(testApp, "admin@example.com", "ADMIN");

      const response = await reprocess(testApp, admin, doc.id);

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("FORBIDDEN");
      expect(testApp.documentsRepository.enqueuedReprocesses).toEqual([]);
      expect(requested(testApp)).toHaveLength(0);
    },
  );

  it("answers 401 to a suspended ADMIN", async () => {
    const testApp = await buildTestApp();
    const doc = await documentIn(testApp, "SCAN_FAILED");
    const admin = await login(testApp, "admin@example.com", "ADMIN");
    admin.user.status = "SUSPENDED";

    expect((await reprocess(testApp, admin, doc.id)).statusCode).toBe(401);
  });
});

function reprocessOcr(
  testApp: TestApp,
  as: Login | undefined,
  documentId: string,
  payload: unknown = { reason: "El proveedor de OCR estuvo caído" },
  csrf?: string | null,
) {
  return testApp.app.inject({
    method: "POST",
    url: `/api/admin/documents/${documentId}/ocr/reprocess`,
    headers: as ? headersOf(as, csrf === undefined ? as.csrfRaw : csrf) : { origin: ORIGIN },
    payload: payload as object,
  });
}

const ocrRequested = (testApp: TestApp) =>
  testApp.documentsRepository.auditLog.filter(
    (e) => e.action === "document.ocr_reprocess_requested",
  );

describe("POST /api/admin/documents/:documentId/ocr/reprocess (decisions OCR-A11, OCR-A12)", () => {
  it("lets an ADMIN ask for a FAILED OCR to run again: audited and queued, never the text", async () => {
    const testApp = await buildTestApp();
    const doc = await documentIn(testApp, "CLEAN", "FAILED");
    const admin = await login(testApp, "admin@example.com", "ADMIN");

    const response = await reprocessOcr(testApp, admin, doc.id);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "accepted" });
    expect(testApp.documentsRepository.enqueuedOcrReprocesses).toEqual([doc.id]);
    expect(testApp.documentsRepository.enqueuedReprocesses).toEqual([]);
    const [event] = ocrRequested(testApp);
    expect(event).toMatchObject({
      actorUserId: admin.user.id,
      actorRole: "ADMIN",
      entityType: "Document",
      entityId: doc.id,
      caseId: doc.caseId,
      metadata: { reason: "El proveedor de OCR estuvo caído" },
    });
    expect(JSON.stringify(event)).not.toContain("comparendo");
    // The answer carries nothing of the document: no access to content or text.
    expect(Object.keys(response.json())).toEqual(["status"]);
    // The API does not change the state: the worker does, only if it is still FAILED.
    expect(testApp.documentsRepository.documents.get(doc.id)!.ocrStatus).toBe("FAILED");
  });

  it.each(["USER", "PROFESSIONAL", "SUPER_ADMIN"] as const)(
    "answers 404 to a %s, even the document's owner, and queues nothing",
    async (role) => {
      const testApp = await buildTestApp();
      const doc = await documentIn(testApp, "CLEAN", "FAILED");
      const someone = await login(testApp, `ocr-${role.toLowerCase()}@example.com`, role);

      expect((await reprocessOcr(testApp, someone, doc.id)).statusCode).toBe(404);
      expect(testApp.documentsRepository.enqueuedOcrReprocesses).toEqual([]);
      expect(ocrRequested(testApp)).toHaveLength(0);
    },
  );

  it("needs a session (401), the CSRF token (403) and a justification (400)", async () => {
    const testApp = await buildTestApp();
    const doc = await documentIn(testApp, "CLEAN", "FAILED");
    const admin = await login(testApp, "admin@example.com", "ADMIN");

    expect((await reprocessOcr(testApp, undefined, doc.id)).statusCode).toBe(401);
    const noCsrf = await reprocessOcr(testApp, admin, doc.id, undefined, null);
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe("CSRF_INVALID");
    expect((await reprocessOcr(testApp, admin, doc.id, {})).statusCode).toBe(400);
    expect((await reprocessOcr(testApp, admin, randomUUID())).statusCode).toBe(404);
    expect((await reprocessOcr(testApp, admin, "not-a-uuid")).statusCode).toBe(404);
    expect(testApp.documentsRepository.enqueuedOcrReprocesses).toEqual([]);
  });

  it.each([
    ["CLEAN", "NOT_STARTED"],
    ["CLEAN", "PENDING"],
    ["CLEAN", "PROCESSING"],
    ["CLEAN", "COMPLETED"],
    ["CLEAN", "EXCLUDED"],
    ["INFECTED", "NOT_APPLICABLE"],
    ["SCAN_FAILED", "NOT_STARTED"],
    ["SCAN_FAILED", "FAILED"],
  ])(
    "refuses a %s document whose OCR is %s (403): only a failed OCR is retried",
    async (status, ocr) => {
      const testApp = await buildTestApp();
      const doc = await documentIn(testApp, status, ocr);
      const admin = await login(testApp, "admin@example.com", "ADMIN");

      const response = await reprocessOcr(testApp, admin, doc.id);

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("FORBIDDEN");
      expect(testApp.documentsRepository.enqueuedOcrReprocesses).toEqual([]);
      expect(ocrRequested(testApp)).toHaveLength(0);
    },
  );
});
