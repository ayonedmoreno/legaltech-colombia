import { sessionsResponseSchema } from "@legaltech/contracts";
import { describe, expect, it } from "vitest";
import { cookieHeader, findSetCookie } from "../../test-support/cookies.js";
import { buildTestApp } from "../../test-support/build-test-app.js";

/**
 * GET /api/auth/sessions (API_SPEC.md; ADR-003 `session:list`): the user's own valid sessions,
 * with the one the request was made with marked `current`.
 */
const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct horse battery";
const DAY_MS = 24 * 60 * 60 * 1000;

type App = Awaited<ReturnType<typeof buildTestApp>>["app"];

async function register(app: App, email: string) {
  await app.inject({
    method: "POST",
    url: "/api/auth/register",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password: PASSWORD, fullName: "Ana Gómez" },
  });
}

/** Logs in and returns the raw session cookie value. */
async function login(app: App, email: string, remoteAddress = "203.0.113.7", userAgent = "ua-1") {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress,
    headers: { origin: ORIGIN, "content-type": "application/json", "user-agent": userAgent },
    payload: { email, password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  return findSetCookie(response.headers["set-cookie"], "__Host-session")!.value;
}

/** Logs in, then logs that session out (with its CSRF token, as API_SPEC.md requires). */
async function loginThenLogout(app: App, email: string, remoteAddress: string, userAgent: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress,
    headers: { origin: ORIGIN, "content-type": "application/json", "user-agent": userAgent },
    payload: { email, password: PASSWORD },
  });
  const sessionRaw = findSetCookie(response.headers["set-cookie"], "__Host-session")!.value;
  const csrfRaw = findSetCookie(response.headers["set-cookie"], "__Host-csrf")!.value;
  const logout = await app.inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: {
      origin: ORIGIN,
      "x-csrf-token": csrfRaw,
      cookie: cookieHeader({ "__Host-session": sessionRaw, "__Host-csrf": csrfRaw }),
    },
  });
  expect(logout.statusCode).toBe(204);
  return sessionRaw;
}

function listSessions(app: App, sessionRaw?: string) {
  return app.inject({
    method: "GET",
    url: "/api/auth/sessions",
    headers: sessionRaw ? { cookie: cookieHeader({ "__Host-session": sessionRaw }) } : {},
  });
}

describe("GET /api/auth/sessions", () => {
  it("lists the user's own sessions in the documented shape, marking the current one", async () => {
    const { app } = await buildTestApp();
    await register(app, "ana@example.com");
    const first = await login(app, "ana@example.com", "203.0.113.7", "browser-a");
    const second = await login(app, "ana@example.com", "2001:db8::7", "browser-b");

    const fromFirst = await listSessions(app, first);
    expect(fromFirst.statusCode).toBe(200);
    const body = sessionsResponseSchema.parse(fromFirst.json());
    expect(body.sessions).toHaveLength(2);
    for (const session of body.sessions) {
      expect(Object.keys(session).sort()).toEqual(
        ["createdAt", "current", "id", "ip", "lastSeenAt", "userAgent"].sort(),
      );
    }
    expect(body.sessions.filter((s) => s.current)).toHaveLength(1);
    expect(body.sessions.find((s) => s.current)).toMatchObject({
      ip: "203.0.113.7",
      userAgent: "browser-a",
    });
    expect(body.sessions.find((s) => !s.current)).toMatchObject({
      ip: "2001:db8::7",
      userAgent: "browser-b",
    });

    // The same list seen from the other session marks the other one as current.
    const fromSecond = sessionsResponseSchema.parse((await listSessions(app, second)).json());
    expect(fromSecond.sessions.find((s) => s.current)?.userAgent).toBe("browser-b");
    expect(fromSecond.sessions.map((s) => s.id).sort()).toEqual(
      body.sessions.map((s) => s.id).sort(),
    );
    await app.close();
  });

  it("never exposes a token, a hash or the CSRF value", async () => {
    const { app, repository } = await buildTestApp();
    await register(app, "ana@example.com");
    const sessionRaw = await login(app, "ana@example.com");

    const raw = (await listSessions(app, sessionRaw)).body;
    const [session] = [...repository.sessions.values()];
    for (const secret of [sessionRaw, session!.tokenHash, session!.csrfTokenHash]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).not.toContain("tokenHash");
    expect(raw).not.toContain("csrfTokenHash");
    await app.close();
  });

  it("never lists another user's sessions", async () => {
    const { app } = await buildTestApp();
    await register(app, "ana@example.com");
    await register(app, "luis@example.com");
    const ana = await login(app, "ana@example.com");
    const luis = await login(app, "luis@example.com");
    await login(app, "luis@example.com");

    const anaSessions = sessionsResponseSchema.parse((await listSessions(app, ana)).json());
    const luisSessions = sessionsResponseSchema.parse((await listSessions(app, luis)).json());
    expect(anaSessions.sessions).toHaveLength(1);
    expect(luisSessions.sessions).toHaveLength(2);
    const luisIds = new Set(luisSessions.sessions.map((s) => s.id));
    expect(anaSessions.sessions.some((s) => luisIds.has(s.id))).toBe(false);
    await app.close();
  });

  it("leaves out revoked and expired sessions", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const { app } = await buildTestApp({ clock: () => now });
    await register(app, "ana@example.com");
    const stale = await login(app, "ana@example.com", "203.0.113.1", "stale");
    await loginThenLogout(app, "ana@example.com", "203.0.113.2", "logged-out");
    // Revoked, and nothing has expired yet: only the revocation keeps it out.
    const beforeExpiry = sessionsResponseSchema.parse((await listSessions(app, stale)).json());
    expect(beforeExpiry.sessions.map((s) => s.userAgent)).toEqual(["stale"]);

    now = new Date(now.getTime() + 6 * DAY_MS);
    const fresh = await login(app, "ana@example.com", "203.0.113.3", "fresh");
    // `stale` was never used again: past its 7-day idle window.
    now = new Date(now.getTime() + 1 * DAY_MS + 1);

    const body = sessionsResponseSchema.parse((await listSessions(app, fresh)).json());
    expect(body.sessions.map((s) => s.userAgent)).toEqual(["fresh"]);
    expect((await listSessions(app, stale)).statusCode).toBe(401);
    await app.close();
  });

  it("orders sessions by most recent use", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const { app } = await buildTestApp({ clock: () => now });
    await register(app, "ana@example.com");
    const older = await login(app, "ana@example.com", "203.0.113.1", "older");
    now = new Date(now.getTime() + 60_000);
    await login(app, "ana@example.com", "203.0.113.2", "newer");
    now = new Date(now.getTime() + 60_000);

    // Listing from `older` uses it now, so it becomes the most recent.
    const body = sessionsResponseSchema.parse((await listSessions(app, older)).json());
    expect(body.sessions.map((s) => s.userAgent)).toEqual(["older", "newer"]);
    await app.close();
  });

  it("rejects a request with no session, an unknown token, or a revoked session", async () => {
    const { app } = await buildTestApp();
    await register(app, "ana@example.com");
    const sessionRaw = await loginThenLogout(app, "ana@example.com", "203.0.113.7", "ua-1");

    for (const token of [undefined, "not-a-real-session-token", sessionRaw]) {
      const response = await listSessions(app, token);
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("UNAUTHENTICATED");
    }
    await app.close();
  });

  it("rejects a suspended user, even with an otherwise valid session", async () => {
    const { app, repository } = await buildTestApp();
    await register(app, "ana@example.com");
    const sessionRaw = await login(app, "ana@example.com");
    const [user] = [...repository.users.values()];
    user!.status = "SUSPENDED";

    const response = await listSessions(app, sessionRaw);
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("needs no CSRF token or Origin: it is a safe (GET) request", async () => {
    const { app } = await buildTestApp();
    await register(app, "ana@example.com");
    const sessionRaw = await login(app, "ana@example.com");

    const response = await listSessions(app, sessionRaw);
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
