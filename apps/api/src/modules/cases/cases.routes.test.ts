import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cookieHeader, findSetCookie } from "../../test-support/cookies.js";
import { buildTestApp } from "../../test-support/build-test-app.js";
import type { AuditLogEntry } from "../auth/auth.types.js";
import { FakeCasesRepository } from "./cases.repository.fake.js";

/**
 * /api/cases, first Case slice (API_SPEC.md; ADR-003): a USER creates cases in DRAFT, lists and
 * reads only their own; any other case, an unknown one or a malformed id answers the same 404;
 * other roles are out of this slice. The case, its first history entry and `case.created` are
 * written together.
 */
const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct horse battery";

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
    remoteAddress: `10.0.0.${testApp.repository.users.size + 1}`,
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password: PASSWORD, fullName: "Ana Gómez" },
  });
  const response = await testApp.app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  return {
    userId: response.json().user.id,
    sessionRaw: findSetCookie(response.headers["set-cookie"], "__Host-session")!.value,
    csrfRaw: findSetCookie(response.headers["set-cookie"], "__Host-csrf")!.value,
  };
}

function createCase(
  testApp: TestApp,
  as: Login | undefined,
  payload: Record<string, unknown>,
  options: { csrf?: string | null; origin?: string | null } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin) headers.origin = origin;
  const csrf = options.csrf === undefined ? as?.csrfRaw : options.csrf;
  if (csrf) headers["x-csrf-token"] = csrf;
  if (as) {
    headers.cookie = cookieHeader({ "__Host-session": as.sessionRaw, "__Host-csrf": as.csrfRaw });
  }
  return testApp.app.inject({ method: "POST", url: "/api/cases", headers, payload });
}

function get(testApp: TestApp, as: Login | undefined, url: string) {
  return testApp.app.inject({
    method: "GET",
    url,
    headers: as ? { cookie: cookieHeader({ "__Host-session": as.sessionRaw }) } : {},
  });
}

const createdEvents = (testApp: TestApp) =>
  testApp.casesRepository.auditLog.filter((e) => e.action === "case.created");

describe("POST /api/cases", () => {
  it("creates a DRAFT case for the caller, with its history entry and its audit event", async () => {
    const testApp = await buildTestApp();
    const ana = await registerAndLogin(testApp, "ana@example.com");

    const response = await createCase(testApp, ana, { type: "TRAFFIC_CITATION" });

    expect(response.statusCode).toBe(201);
    const { case: created } = response.json();
    expect(created).toEqual({
      id: expect.any(String),
      type: "TRAFFIC_CITATION",
      status: "DRAFT",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    // The owner is never sent back.
    expect(JSON.stringify(response.json())).not.toContain(ana.userId);

    const stored = testApp.casesRepository.cases.get(created.id)!;
    expect(stored).toMatchObject({ userId: ana.userId, status: "DRAFT" });
    expect(testApp.casesRepository.statusHistory).toEqual([
      expect.objectContaining({
        caseId: created.id,
        fromStatus: null,
        toStatus: "DRAFT",
        changedByUserId: ana.userId,
      }),
    ]);
    expect(createdEvents(testApp)).toEqual([
      expect.objectContaining({
        actorUserId: ana.userId,
        actorRole: "USER",
        entityType: "Case",
        entityId: created.id,
        caseId: created.id,
        newValue: { type: "TRAFFIC_CITATION", status: "DRAFT" },
      }),
    ]);
  });

  it("does not require a verified email (decision E)", async () => {
    const testApp = await buildTestApp();
    const ana = await registerAndLogin(testApp, "ana@example.com");
    expect(testApp.repository.users.get(ana.userId)!.emailVerifiedAt).toBeNull();

    expect((await createCase(testApp, ana, { type: "OTHER" })).statusCode).toBe(201);
  });

  it.each([
    ["an unknown type", { type: "PARKING" }],
    ["a missing type", {}],
    ["a status chosen by the client", { type: "OTHER", status: "PAID" }],
    ["an owner chosen by the client", { type: "OTHER", userId: randomUUID() }],
  ])("rejects %s with 400 and creates nothing", async (_label, payload) => {
    const testApp = await buildTestApp();
    const ana = await registerAndLogin(testApp, "ana@example.com");

    const response = await createCase(testApp, ana, payload);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    expect(testApp.casesRepository.cases.size).toBe(0);
    expect(createdEvents(testApp)).toHaveLength(0);
  });

  it("needs a session: 401 and nothing created", async () => {
    const testApp = await buildTestApp();
    const response = await createCase(testApp, undefined, { type: "OTHER" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHENTICATED");
    expect(testApp.casesRepository.cases.size).toBe(0);
  });

  it.each([
    ["without the CSRF header", { csrf: null }],
    ["with a wrong CSRF token", { csrf: "wrong-token" }],
    ["from another origin", { origin: "https://evil.example" }],
    ["without an Origin", { origin: null }],
  ])("answers 403 %s and creates nothing", async (_label, options) => {
    const testApp = await buildTestApp();
    const ana = await registerAndLogin(testApp, "ana@example.com");

    const response = await createCase(testApp, ana, { type: "OTHER" }, options);

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("CSRF_INVALID");
    expect(testApp.casesRepository.cases.size).toBe(0);
  });

  it("keeps nothing if the audit write fails: no case, no history (one transaction)", async () => {
    class FailingAuditRepository extends FakeCasesRepository {
      protected override recordAudit(_entry: AuditLogEntry): void {
        throw new Error("audit write failed");
      }
    }
    const testApp = await buildTestApp({ casesRepository: new FailingAuditRepository() });
    const ana = await registerAndLogin(testApp, "ana@example.com");

    const response = await createCase(testApp, ana, { type: "OTHER" });

    expect(response.statusCode).toBe(500);
    expect(testApp.casesRepository.cases.size).toBe(0);
    expect(testApp.casesRepository.statusHistory).toHaveLength(0);
  });
});

describe("GET /api/cases", () => {
  it("lists only the caller's cases, most recent first", async () => {
    let now = new Date("2026-09-27T12:00:00.000Z");
    const testApp = await buildTestApp({ clock: () => now });
    const ana = await registerAndLogin(testApp, "ana@example.com");
    const luis = await registerAndLogin(testApp, "luis@example.com");

    const first = (await createCase(testApp, ana, { type: "INFRACTION" })).json().case;
    now = new Date(now.getTime() + 1_000);
    const second = (await createCase(testApp, ana, { type: "TRANSPORT" })).json().case;
    await createCase(testApp, luis, { type: "OTHER" });

    const response = await get(testApp, ana, "/api/cases");

    expect(response.statusCode).toBe(200);
    expect(response.json().cases.map((c: { id: string }) => c.id)).toEqual([second.id, first.id]);
  });

  it("returns an empty list for a user without cases", async () => {
    const testApp = await buildTestApp();
    const ana = await registerAndLogin(testApp, "ana@example.com");
    const response = await get(testApp, ana, "/api/cases");
    expect(response.json()).toEqual({ cases: [] });
  });

  it("needs a session (401)", async () => {
    const testApp = await buildTestApp();
    expect((await get(testApp, undefined, "/api/cases")).statusCode).toBe(401);
  });

  it("writes no audit event (a safe read)", async () => {
    const testApp = await buildTestApp();
    const ana = await registerAndLogin(testApp, "ana@example.com");
    await get(testApp, ana, "/api/cases");
    expect(testApp.casesRepository.auditLog).toHaveLength(0);
  });
});

describe("GET /api/cases/:caseId", () => {
  it("returns the caller's case with its status history (NULL → DRAFT)", async () => {
    const testApp = await buildTestApp();
    const ana = await registerAndLogin(testApp, "ana@example.com");
    const created = (await createCase(testApp, ana, { type: "PHOTO_ENFORCEMENT" })).json().case;

    const response = await get(testApp, ana, `/api/cases/${created.id}`);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      case: created,
      statusHistory: [{ fromStatus: null, toStatus: "DRAFT", changedAt: created.createdAt }],
    });
  });

  it("answers another user's case, an unknown id and a malformed id with the same 404 (IDOR)", async () => {
    const testApp = await buildTestApp();
    const ana = await registerAndLogin(testApp, "ana@example.com");
    const luis = await registerAndLogin(testApp, "luis@example.com");
    const anasCase = (await createCase(testApp, ana, { type: "OTHER" })).json().case;

    const responses = await Promise.all(
      [anasCase.id, randomUUID(), "not-a-uuid", "1"].map((id) =>
        get(testApp, luis, `/api/cases/${id}`),
      ),
    );

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toMatchObject({
        code: "NOT_FOUND",
        message: "Recurso no encontrado.",
      });
    }
    // Nothing distinguishes the existing foreign case from an unknown one.
    const bodies = responses.map((r) => ({ ...r.json().error, requestId: undefined }));
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("needs a session (401) before looking at the id", async () => {
    const testApp = await buildTestApp();
    expect((await get(testApp, undefined, "/api/cases/not-a-uuid")).statusCode).toBe(401);
    expect((await get(testApp, undefined, `/api/cases/${randomUUID()}`)).statusCode).toBe(401);
  });
});

describe("roles outside this slice and suspended users", () => {
  it.each(["PROFESSIONAL", "ADMIN", "SUPER_ADMIN"] as const)(
    "%s gets 404 on every case endpoint and creates nothing",
    async (role) => {
      const testApp = await buildTestApp();
      const ana = await registerAndLogin(testApp, "ana@example.com");
      const anasCase = (await createCase(testApp, ana, { type: "OTHER" })).json().case;
      const staff = await registerAndLogin(testApp, "staff@legaltech.test");
      testApp.repository.users.get(staff.userId)!.role = role;

      const create = await createCase(testApp, staff, { type: "OTHER" });
      const list = await get(testApp, staff, "/api/cases");
      const read = await get(testApp, staff, `/api/cases/${anasCase.id}`);

      expect([create.statusCode, list.statusCode, read.statusCode]).toEqual([404, 404, 404]);
      expect(testApp.casesRepository.cases.size).toBe(1);
      expect(createdEvents(testApp)).toHaveLength(1);
    },
  );

  it("a suspended user is not authenticated (401)", async () => {
    const testApp = await buildTestApp();
    const ana = await registerAndLogin(testApp, "ana@example.com");
    testApp.repository.users.get(ana.userId)!.status = "SUSPENDED";

    expect((await createCase(testApp, ana, { type: "OTHER" })).statusCode).toBe(401);
    expect((await get(testApp, ana, "/api/cases")).statusCode).toBe(401);
  });
});
