import { randomUUID } from "node:crypto";
import type { Role } from "@legaltech/database";
import { describe, expect, it } from "vitest";
import { buildTestApp } from "../../test-support/build-test-app.js";
import { cookieHeader, findSetCookie } from "../../test-support/cookies.js";

/**
 * GET /api/cases/:caseId/documents/:documentId/ocr (decisions OCR-A3, OCR-A12, OCR-A13): only the
 * USER who owns the case reads the OCR text of their document, and only the current execution
 * while the OCR is COMPLETED. Everyone else, and every unknown or foreign id, gets a 404.
 */
const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct horse battery";
const PDF = Buffer.from("%PDF-1.7\n%%EOF\n");
const HOSTILE = "<script>alert('x')</script>'); DROP TABLE documents; --";

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;

async function login(testApp: TestApp, email: string, role: Role = "USER") {
  await testApp.app.inject({
    method: "POST",
    url: "/api/auth/register",
    remoteAddress: `10.0.3.${testApp.repository.users.size + 1}`,
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
  return {
    user,
    sessionRaw: findSetCookie(response.headers["set-cookie"], "__Host-session")!.value,
    csrfRaw: findSetCookie(response.headers["set-cookie"], "__Host-csrf")!.value,
  };
}

type Login = Awaited<ReturnType<typeof login>>;

const headersOf = (as: Login) => ({
  origin: ORIGIN,
  "content-type": "application/json",
  cookie: cookieHeader({ "__Host-session": as.sessionRaw, "__Host-csrf": as.csrfRaw }),
  "x-csrf-token": as.csrfRaw,
});

/** An owner with a CLEAN document whose OCR is in `ocrStatus`, with the given executions. */
async function ownerWithDocument(
  testApp: TestApp,
  ocrStatus: string,
  executions: Array<{ outcome: "COMPLETED" | "FAILED"; pages: string[] }> = [],
) {
  const owner = await login(testApp, `owner-${randomUUID()}@example.com`);
  const created = await testApp.app.inject({
    method: "POST",
    url: "/api/cases",
    headers: headersOf(owner),
    payload: { type: "OTHER" },
  });
  const caseId: string = created.json().case.id;
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
  const documentId: string = uploaded.json().document.id;
  const stored = testApp.documentsRepository.documents.get(documentId)!;
  stored.status = "CLEAN";
  stored.ocrStatus = ocrStatus as typeof stored.ocrStatus;
  testApp.documentsRepository.ocrExecutions.set(documentId, executions);
  return { owner, caseId, documentId };
}

const read = (testApp: TestApp, as: Login | undefined, caseId: string, documentId: string) =>
  testApp.app.inject({
    method: "GET",
    url: `/api/cases/${caseId}/documents/${documentId}/ocr`,
    headers: as ? headersOf(as) : { origin: ORIGIN },
  });

describe("GET /api/cases/:caseId/documents/:documentId/ocr", () => {
  it("gives the owner the text of the current execution, per page, never cached", async () => {
    const testApp = await buildTestApp();
    const doc = await ownerWithDocument(testApp, "COMPLETED", [
      { outcome: "COMPLETED", pages: ["texto antiguo"] },
      { outcome: "FAILED", pages: [] },
      { outcome: "COMPLETED", pages: ["página uno", HOSTILE] },
    ]);

    const response = await read(testApp, doc.owner, doc.caseId, doc.documentId);

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    // Only the latest COMPLETED execution, and the hostile text as plain JSON data.
    expect(response.json()).toEqual({
      ocrStatus: "COMPLETED",
      pages: [
        { number: 1, text: "página uno" },
        { number: 2, text: HOSTILE },
      ],
    });
  });

  it.each(["NOT_STARTED", "PENDING", "PROCESSING", "FAILED", "EXCLUDED", "NOT_APPLICABLE"])(
    "answers 200 with no text while the OCR is %s, even if an earlier execution completed",
    async (state) => {
      const testApp = await buildTestApp();
      const doc = await ownerWithDocument(testApp, state, [
        { outcome: "COMPLETED", pages: ["texto de una ejecución anterior"] },
      ]);

      const response = await read(testApp, doc.owner, doc.caseId, doc.documentId);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ocrStatus: state, pages: [] });
    },
  );

  it("answers 404 to another user, with their ids or mixed with their own (IDOR)", async () => {
    const testApp = await buildTestApp();
    const victim = await ownerWithDocument(testApp, "COMPLETED", [
      { outcome: "COMPLETED", pages: ["secreto"] },
    ]);
    const attacker = await ownerWithDocument(testApp, "COMPLETED", [
      { outcome: "COMPLETED", pages: ["propio"] },
    ]);

    for (const [caseId, documentId] of [
      [victim.caseId, victim.documentId],
      [attacker.caseId, victim.documentId],
      [victim.caseId, attacker.documentId],
    ]) {
      const response = await read(testApp, attacker.owner, caseId!, documentId!);
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain("secreto");
    }
  });

  it("stops answering the former owner once the case belongs to someone else", async () => {
    const testApp = await buildTestApp();
    const doc = await ownerWithDocument(testApp, "COMPLETED", [
      { outcome: "COMPLETED", pages: ["secreto"] },
    ]);
    expect((await read(testApp, doc.owner, doc.caseId, doc.documentId)).statusCode).toBe(200);

    testApp.casesRepository.cases.get(doc.caseId)!.userId = randomUUID();

    const response = await read(testApp, doc.owner, doc.caseId, doc.documentId);
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("secreto");
  });

  it.each(["ADMIN", "PROFESSIONAL", "SUPER_ADMIN"] as const)(
    "answers 404 to a %s: no access to the text, not even for an administrator",
    async (role) => {
      const testApp = await buildTestApp();
      const doc = await ownerWithDocument(testApp, "COMPLETED", [
        { outcome: "COMPLETED", pages: ["secreto"] },
      ]);
      const someone = await login(testApp, `ocr-${role.toLowerCase()}@example.com`, role);

      const response = await read(testApp, someone, doc.caseId, doc.documentId);

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain("secreto");
    },
  );

  it("needs a session (401) and answers 404 for unknown or malformed ids", async () => {
    const testApp = await buildTestApp();
    const doc = await ownerWithDocument(testApp, "COMPLETED", [
      { outcome: "COMPLETED", pages: ["secreto"] },
    ]);

    expect((await read(testApp, undefined, doc.caseId, doc.documentId)).statusCode).toBe(401);
    expect((await read(testApp, doc.owner, doc.caseId, randomUUID())).statusCode).toBe(404);
    expect((await read(testApp, doc.owner, randomUUID(), doc.documentId)).statusCode).toBe(404);
    expect((await read(testApp, doc.owner, doc.caseId, "not-a-uuid")).statusCode).toBe(404);
    expect((await read(testApp, doc.owner, "x' OR '1'='1", doc.documentId)).statusCode).toBe(404);
  });

  it("never exposes the text in an error answer", async () => {
    const testApp = await buildTestApp();
    const doc = await ownerWithDocument(testApp, "COMPLETED");
    testApp.documentsRepository.findOwnDocumentOcr = () =>
      Promise.reject(new Error(`database failed while reading: ${HOSTILE}`));

    const response = await read(testApp, doc.owner, doc.caseId, doc.documentId);

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("DROP TABLE");
    expect(response.body).not.toContain("<script>");
  });
});
