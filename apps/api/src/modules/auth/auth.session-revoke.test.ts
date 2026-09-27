import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cookieHeader, findSetCookie } from "../../test-support/cookies.js";
import { buildTestApp } from "../../test-support/build-test-app.js";

/**
 * DELETE /api/auth/sessions/:sessionId (API_SPEC.md; ADR-002 "revocación de una sesión propia
 * por ID"; ADR-003 `session:revoke`): revokes one of the user's own sessions with reason
 * `LOGOUT`; another user's, an unknown, a revoked or an expired session all answer 404.
 */
const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct horse battery";
const DAY_MS = 24 * 60 * 60 * 1000;

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;
type App = TestApp["app"];

interface Login {
  sessionRaw: string;
  csrfRaw: string;
  sessionId: string;
}

async function register(app: App, email: string) {
  await app.inject({
    method: "POST",
    url: "/api/auth/register",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password: PASSWORD, fullName: "Ana Gómez" },
  });
}

/** Logs in and returns the cookies plus the id of the session it created. */
async function login(testApp: TestApp, email: string): Promise<Login> {
  const response = await testApp.app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const sessionRaw = findSetCookie(response.headers["set-cookie"], "__Host-session")!.value;
  const csrfRaw = findSetCookie(response.headers["set-cookie"], "__Host-csrf")!.value;
  const sessions = [...testApp.repository.sessions.values()];
  return { sessionRaw, csrfRaw, sessionId: sessions[sessions.length - 1]!.id };
}

function revoke(
  app: App,
  as: Login | undefined,
  sessionId: string,
  options: { csrf?: string | null; origin?: string | null } = {},
) {
  const headers: Record<string, string> = {};
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin) headers.origin = origin;
  const csrf = options.csrf === undefined ? as?.csrfRaw : options.csrf;
  if (csrf) headers["x-csrf-token"] = csrf;
  if (as) {
    headers.cookie = cookieHeader({ "__Host-session": as.sessionRaw, "__Host-csrf": as.csrfRaw });
  }
  return app.inject({ method: "DELETE", url: `/api/auth/sessions/${sessionId}`, headers });
}

function me(app: App, as: Login) {
  return app.inject({
    method: "GET",
    url: "/api/auth/me",
    headers: { cookie: cookieHeader({ "__Host-session": as.sessionRaw }) },
  });
}

const revokedEvents = (testApp: TestApp) =>
  testApp.repository.auditLog.filter((e) => e.action === "auth.session.revoked");

describe("DELETE /api/auth/sessions/:sessionId", () => {
  it("revokes another of the user's own sessions and keeps the current one", async () => {
    const testApp = await buildTestApp();
    await register(testApp.app, "ana@example.com");
    const current = await login(testApp, "ana@example.com");
    const other = await login(testApp, "ana@example.com");

    const response = await revoke(testApp.app, current, other.sessionId);

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    // Not the current session: no cookie is touched.
    expect(response.headers["set-cookie"]).toBeUndefined();
    const target = testApp.repository.sessions.get(other.sessionId)!;
    expect(target.revokedAt).not.toBeNull();
    expect(target.revokedReason).toBe("LOGOUT");
    expect((await me(testApp.app, other)).statusCode).toBe(401);
    expect((await me(testApp.app, current)).statusCode).toBe(200);
    expect(testApp.repository.sessions.get(current.sessionId)!.revokedAt).toBeNull();

    const [user] = [...testApp.repository.users.values()];
    expect(revokedEvents(testApp)).toEqual([
      expect.objectContaining({
        actorUserId: user!.id,
        actorRole: "USER",
        entityType: "Session",
        entityId: other.sessionId,
      }),
    ]);
    await testApp.app.close();
  });

  it("revokes the current session and clears both cookies, like logout", async () => {
    const testApp = await buildTestApp();
    await register(testApp.app, "ana@example.com");
    const current = await login(testApp, "ana@example.com");

    const response = await revoke(testApp.app, current, current.sessionId);

    expect(response.statusCode).toBe(204);
    expect(testApp.repository.sessions.get(current.sessionId)!.revokedReason).toBe("LOGOUT");
    for (const [name, httpOnly] of [
      ["__Host-session", true],
      ["__Host-csrf", false],
    ] as const) {
      const cleared = findSetCookie(response.headers["set-cookie"], name);
      expect(cleared?.value).toBe("");
      const attributes = cleared!.attributes.map((a) => a.toLowerCase());
      expect(attributes).toEqual(
        expect.arrayContaining(["secure", "samesite=lax", "path=/", "max-age=0"]),
      );
      expect(attributes.includes("httponly")).toBe(httpOnly);
    }
    expect((await me(testApp.app, current)).statusCode).toBe(401);
    await testApp.app.close();
  });

  it("answers 404 for another user's session, and leaves it untouched", async () => {
    const testApp = await buildTestApp();
    await register(testApp.app, "ana@example.com");
    await register(testApp.app, "luis@example.com");
    const ana = await login(testApp, "ana@example.com");
    const luis = await login(testApp, "luis@example.com");

    const response = await revoke(testApp.app, ana, luis.sessionId);

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(testApp.repository.sessions.get(luis.sessionId)!.revokedAt).toBeNull();
    expect((await me(testApp.app, luis)).statusCode).toBe(200);
    expect((await me(testApp.app, ana)).statusCode).toBe(200);
    expect(revokedEvents(testApp)).toEqual([]);
    await testApp.app.close();
  });

  it("answers another user's, an unknown and a malformed id identically", async () => {
    const testApp = await buildTestApp();
    await register(testApp.app, "ana@example.com");
    await register(testApp.app, "luis@example.com");
    const ana = await login(testApp, "ana@example.com");
    const luis = await login(testApp, "luis@example.com");

    const shapes = [];
    for (const id of [luis.sessionId, randomUUID(), "not-a-uuid"]) {
      const response = await revoke(testApp.app, ana, id);
      const error = { ...response.json().error };
      delete error.requestId;
      shapes.push({ status: response.statusCode, error, cookies: response.headers["set-cookie"] });
    }
    expect(shapes[0]).toEqual({
      status: 404,
      error: { code: "NOT_FOUND", message: "Recurso no encontrado.", details: [] },
      cookies: undefined,
    });
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
    // Nothing about the other user leaks into the answer.
    const raw = JSON.stringify(shapes);
    expect(raw).not.toContain(luis.sessionId);
    expect(raw).not.toContain("luis@example.com");
    await testApp.app.close();
  });

  it("answers 404 for a session already revoked, without changing its first revocation", async () => {
    const testApp = await buildTestApp();
    await register(testApp.app, "ana@example.com");
    const current = await login(testApp, "ana@example.com");
    const other = await login(testApp, "ana@example.com");
    await testApp.repository.revokeSession(other.sessionId, "ADMIN_REVOKE");
    const first = testApp.repository.sessions.get(other.sessionId)!.revokedAt;

    const response = await revoke(testApp.app, current, other.sessionId);

    expect(response.statusCode).toBe(404);
    const target = testApp.repository.sessions.get(other.sessionId)!;
    expect(target.revokedReason).toBe("ADMIN_REVOKE");
    expect(target.revokedAt).toBe(first);
    expect(revokedEvents(testApp)).toEqual([]);
    await testApp.app.close();
  });

  it("answers 404 for an own session that has already expired", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const testApp = await buildTestApp({ clock: () => now });
    await register(testApp.app, "ana@example.com");
    const stale = await login(testApp, "ana@example.com");
    now = new Date(now.getTime() + 6 * DAY_MS);
    const current = await login(testApp, "ana@example.com");
    now = new Date(now.getTime() + 1 * DAY_MS + 1); // `stale` is past its 7-day idle window

    const response = await revoke(testApp.app, current, stale.sessionId);

    expect(response.statusCode).toBe(404);
    expect(testApp.repository.sessions.get(stale.sessionId)!.revokedAt).toBeNull();
    await testApp.app.close();
  });

  it("requires a valid session: 401 before anything about the target is looked at", async () => {
    const testApp = await buildTestApp();
    await register(testApp.app, "ana@example.com");
    const ana = await login(testApp, "ana@example.com");

    const response = await revoke(testApp.app, undefined, ana.sessionId, { csrf: ana.csrfRaw });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHENTICATED");
    expect(testApp.repository.sessions.get(ana.sessionId)!.revokedAt).toBeNull();
    await testApp.app.close();
  });

  it("requires CSRF: no token, a wrong token, or another origin is 403 and revokes nothing", async () => {
    const testApp = await buildTestApp();
    await register(testApp.app, "ana@example.com");
    const current = await login(testApp, "ana@example.com");
    const other = await login(testApp, "ana@example.com");

    for (const options of [
      { csrf: null },
      { csrf: "not-the-csrf-token" },
      { origin: "https://evil.example" },
      { origin: null },
    ]) {
      const response = await revoke(testApp.app, current, other.sessionId, options);
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("CSRF_INVALID");
    }
    // CSRF is checked before the target, so a foreign id does not turn a 403 into a 404.
    const foreign = await revoke(testApp.app, current, randomUUID(), { csrf: null });
    expect(foreign.statusCode).toBe(403);

    expect(testApp.repository.sessions.get(other.sessionId)!.revokedAt).toBeNull();
    expect(revokedEvents(testApp)).toEqual([]);
    await testApp.app.close();
  });
});
