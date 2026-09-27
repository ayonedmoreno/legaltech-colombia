import { describe, expect, it } from "vitest";
import { cookieHeader, findSetCookie } from "../../test-support/cookies.js";
import { buildTestApp } from "../../test-support/build-test-app.js";

/**
 * POST /api/auth/logout-all (API_SPEC.md; ADR-002 "cierre de todas las sesiones"; ADR-003
 * `session:revoke` on one's own sessions): revokes every session of the user, the current one
 * included, with reason `LOGOUT_ALL`, clears the cookies and audits `auth.logout_all`.
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

async function login(testApp: TestApp, email: string): Promise<Login> {
  const response = await testApp.app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const sessions = [...testApp.repository.sessions.values()];
  return {
    sessionRaw: findSetCookie(response.headers["set-cookie"], "__Host-session")!.value,
    csrfRaw: findSetCookie(response.headers["set-cookie"], "__Host-csrf")!.value,
    sessionId: sessions[sessions.length - 1]!.id,
  };
}

function logoutAll(
  app: App,
  as: Login | undefined,
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
  return app.inject({ method: "POST", url: "/api/auth/logout-all", headers });
}

function me(app: App, as: Login) {
  return app.inject({
    method: "GET",
    url: "/api/auth/me",
    headers: { cookie: cookieHeader({ "__Host-session": as.sessionRaw }) },
  });
}

const events = (testApp: TestApp) =>
  testApp.repository.auditLog.filter((e) => e.action === "auth.logout_all");

describe("POST /api/auth/logout-all", () => {
  it("revokes every one of the user's sessions with LOGOUT_ALL, the current one included", async () => {
    const testApp = await buildTestApp();
    await register(testApp.app, "ana@example.com");
    const sessions = [
      await login(testApp, "ana@example.com"),
      await login(testApp, "ana@example.com"),
      await login(testApp, "ana@example.com"),
    ];

    const response = await logoutAll(testApp.app, sessions[0]);

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    for (const session of sessions) {
      const record = testApp.repository.sessions.get(session.sessionId)!;
      expect(record.revokedAt).not.toBeNull();
      expect(record.revokedReason).toBe("LOGOUT_ALL");
      expect((await me(testApp.app, session)).statusCode).toBe(401);
    }
    await testApp.app.close();
  });

  it("clears both __Host- cookies with the attributes they were set with", async () => {
    const testApp = await buildTestApp();
    await register(testApp.app, "ana@example.com");
    const current = await login(testApp, "ana@example.com");

    const response = await logoutAll(testApp.app, current);

    expect(response.statusCode).toBe(204);
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
    await testApp.app.close();
  });

  it("never touches another user's sessions", async () => {
    const testApp = await buildTestApp();
    await register(testApp.app, "ana@example.com");
    await register(testApp.app, "luis@example.com");
    const ana = await login(testApp, "ana@example.com");
    const luis = [
      await login(testApp, "luis@example.com"),
      await login(testApp, "luis@example.com"),
    ];

    expect((await logoutAll(testApp.app, ana)).statusCode).toBe(204);

    for (const session of luis) {
      expect(testApp.repository.sessions.get(session.sessionId)!.revokedAt).toBeNull();
      expect((await me(testApp.app, session)).statusCode).toBe(200);
    }
    await testApp.app.close();
  });

  it("audits one auth.logout_all event attributed to the user", async () => {
    const testApp = await buildTestApp();
    await register(testApp.app, "ana@example.com");
    const current = await login(testApp, "ana@example.com");
    await login(testApp, "ana@example.com");
    const [user] = [...testApp.repository.users.values()];

    await logoutAll(testApp.app, current);

    expect(events(testApp)).toEqual([
      expect.objectContaining({
        actorUserId: user!.id,
        actorRole: "USER",
        entityType: "User",
        entityId: user!.id,
        requestId: expect.any(String),
      }),
    ]);
    await testApp.app.close();
  });

  it("keeps the first revocation of sessions already revoked, and also closes expired ones", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const testApp = await buildTestApp({ clock: () => now });
    await register(testApp.app, "ana@example.com");
    const stale = await login(testApp, "ana@example.com");
    const revoked = await login(testApp, "ana@example.com");
    await testApp.repository.revokeSession(revoked.sessionId, "LOGOUT");
    const firstRevokedAt = testApp.repository.sessions.get(revoked.sessionId)!.revokedAt;
    now = new Date(now.getTime() + 6 * DAY_MS);
    const current = await login(testApp, "ana@example.com");
    now = new Date(now.getTime() + 1 * DAY_MS + 1); // `stale` is past its 7-day idle window

    expect((await logoutAll(testApp.app, current)).statusCode).toBe(204);

    const revokedRecord = testApp.repository.sessions.get(revoked.sessionId)!;
    expect(revokedRecord.revokedReason).toBe("LOGOUT");
    expect(revokedRecord.revokedAt).toBe(firstRevokedAt);
    // An expired session is closed too: nothing of the user's is left unrevoked.
    expect(testApp.repository.sessions.get(stale.sessionId)!.revokedReason).toBe("LOGOUT_ALL");
    expect(testApp.repository.sessions.get(current.sessionId)!.revokedReason).toBe("LOGOUT_ALL");
    await testApp.app.close();
  });

  it("a second call with the same, now revoked, session is 401 and changes nothing", async () => {
    const testApp = await buildTestApp();
    await register(testApp.app, "ana@example.com");
    const current = await login(testApp, "ana@example.com");
    expect((await logoutAll(testApp.app, current)).statusCode).toBe(204);
    const firstRevokedAt = testApp.repository.sessions.get(current.sessionId)!.revokedAt;

    const second = await logoutAll(testApp.app, current);

    expect(second.statusCode).toBe(401);
    expect(second.json().error.code).toBe("UNAUTHENTICATED");
    expect(testApp.repository.sessions.get(current.sessionId)!.revokedAt).toBe(firstRevokedAt);
    expect(events(testApp)).toHaveLength(1);
    await testApp.app.close();
  });

  it("requires a valid session: 401 and nothing revoked", async () => {
    const testApp = await buildTestApp();
    await register(testApp.app, "ana@example.com");
    const ana = await login(testApp, "ana@example.com");

    const response = await logoutAll(testApp.app, undefined, { csrf: ana.csrfRaw });

    expect(response.statusCode).toBe(401);
    expect(testApp.repository.sessions.get(ana.sessionId)!.revokedAt).toBeNull();
    expect(events(testApp)).toEqual([]);
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
      const response = await logoutAll(testApp.app, current, options);
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("CSRF_INVALID");
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
    for (const session of [current, other]) {
      expect(testApp.repository.sessions.get(session.sessionId)!.revokedAt).toBeNull();
    }
    expect(events(testApp)).toEqual([]);
    await testApp.app.close();
  });
});
