import { rotateSessionResponseSchema } from "@legaltech/contracts";
import { describe, expect, it } from "vitest";
import { cookieHeader, findSetCookie } from "../../test-support/cookies.js";
import { buildTestApp } from "../../test-support/build-test-app.js";
import { SESSION_ROTATION_GRACE_MS, SESSION_ROTATION_INTERVAL_MS } from "./auth.session.js";

/**
 * Session rotation (ADR-002 "Rotación … al iniciar sesión … y periódicamente durante el uso";
 * Sprint 1B decisions P9–P12): POST /api/auth/session/rotate renews a session once it is due for
 * its role (1 h for USER, 15 min for internal roles); the previous cookie keeps working for 60 s;
 * no audit event; logging in revokes the browser's previous session with ROTATED.
 */
const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct horse battery";
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

interface Cookies {
  sessionRaw: string;
  csrfRaw: string;
}

async function setup() {
  let now = new Date("2026-03-01T12:00:00.000Z");
  const testApp = await buildTestApp({ clock: () => now });
  let ip = 0;
  const nextIp = () => `198.51.100.${(ip++ % 250) + 1}`;

  const register = (email: string) =>
    testApp.app.inject({
      method: "POST",
      url: "/api/auth/register",
      remoteAddress: nextIp(),
      headers: { origin: ORIGIN, "content-type": "application/json" },
      payload: { email, password: PASSWORD, fullName: "Ana Gómez" },
    });

  const login = async (email: string, previous?: Cookies, password = PASSWORD) => {
    const response = await testApp.app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: nextIp(),
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        ...(previous ? { cookie: cookieHeader({ "__Host-session": previous.sessionRaw }) } : {}),
      },
      payload: { email, password },
    });
    return {
      response,
      cookies:
        response.statusCode === 200
          ? {
              sessionRaw: findSetCookie(response.headers["set-cookie"], "__Host-session")!.value,
              csrfRaw: findSetCookie(response.headers["set-cookie"], "__Host-csrf")!.value,
            }
          : undefined,
    };
  };

  const rotate = (as: Cookies | undefined, options: { csrf?: string | null } = {}) => {
    const csrf = options.csrf === undefined ? as?.csrfRaw : options.csrf;
    return testApp.app.inject({
      method: "POST",
      url: "/api/auth/session/rotate",
      headers: {
        origin: ORIGIN,
        ...(csrf ? { "x-csrf-token": csrf } : {}),
        ...(as ? { cookie: cookieHeader({ "__Host-session": as.sessionRaw }) } : {}),
      },
    });
  };

  const me = (as: Cookies) =>
    testApp.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookieHeader({ "__Host-session": as.sessionRaw }) },
    });

  /** The cookies a successful rotation set. */
  const rotatedCookies = (response: Awaited<ReturnType<typeof rotate>>): Cookies => ({
    sessionRaw: findSetCookie(response.headers["set-cookie"], "__Host-session")!.value,
    csrfRaw: findSetCookie(response.headers["set-cookie"], "__Host-csrf")!.value,
  });

  return {
    ...testApp,
    register,
    login,
    rotate,
    me,
    rotatedCookies,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe("POST /api/auth/session/rotate", () => {
  it("does nothing before the interval of the user's role", async () => {
    const t = await setup();
    await t.register("ana@example.com");
    const cookies = (await t.login("ana@example.com")).cookies!;
    t.advance(SESSION_ROTATION_INTERVAL_MS.USER - 1);

    const response = await t.rotate(cookies);

    expect(response.statusCode).toBe(200);
    expect(rotateSessionResponseSchema.parse(response.json())).toEqual({ rotated: false });
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(t.repository.sessions.size).toBe(1);
    await t.app.close();
  });

  it("renews a USER session after 1 h: new cookies, same absolute expiry, previous one rotated", async () => {
    const t = await setup();
    await t.register("ana@example.com");
    const cookies = (await t.login("ana@example.com")).cookies!;
    const [previous] = [...t.repository.sessions.values()];
    t.advance(SESSION_ROTATION_INTERVAL_MS.USER);

    const response = await t.rotate(cookies);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ rotated: true });
    for (const [name, httpOnly] of [
      ["__Host-session", true],
      ["__Host-csrf", false],
    ] as const) {
      const cookie = findSetCookie(response.headers["set-cookie"], name)!;
      const attributes = cookie.attributes.map((a) => a.toLowerCase());
      expect(attributes).toEqual(expect.arrayContaining(["secure", "samesite=lax", "path=/"]));
      expect(attributes.includes("httponly")).toBe(httpOnly);
    }
    const fresh = t.rotatedCookies(response);
    expect(fresh.sessionRaw).not.toBe(cookies.sessionRaw);
    expect(fresh.csrfRaw).not.toBe(cookies.csrfRaw);

    const renewed = [...t.repository.sessions.values()].find((s) => s.id !== previous!.id)!;
    expect(renewed.userId).toBe(previous!.userId);
    expect(renewed.absoluteExpiresAt.getTime()).toBe(previous!.absoluteExpiresAt.getTime());
    expect(previous!.rotatedAt).not.toBeNull();
    expect(previous!.revokedAt).toBeNull(); // still in its grace period
    expect((await t.me(fresh)).statusCode).toBe(200);
    // Rotations are not audited (decision P9).
    expect(t.repository.auditLog.map((e) => e.action)).not.toContain("auth.session.rotated");
    await t.app.close();
  });

  it("keeps the previous cookie valid for 60 s, and only for 60 s", async () => {
    const t = await setup();
    await t.register("ana@example.com");
    const cookies = (await t.login("ana@example.com")).cookies!;
    t.advance(SESSION_ROTATION_INTERVAL_MS.USER);
    const fresh = t.rotatedCookies(await t.rotate(cookies));

    t.advance(SESSION_ROTATION_GRACE_MS - 1);
    expect((await t.me(cookies)).statusCode).toBe(200);
    t.advance(1);
    expect((await t.me(cookies)).statusCode).toBe(401);
    expect((await t.me(fresh)).statusCode).toBe(200);
    await t.app.close();
  });

  it("rotates internal roles after 15 min, not USER", async () => {
    const t = await setup();
    await t.register("ana@example.com");
    await t.register("admin@example.com");
    const admin = [...t.repository.users.values()].find((u) => u.email === "admin@example.com")!;
    admin.role = "ADMIN";
    const user = (await t.login("ana@example.com")).cookies!;
    const internal = (await t.login("admin@example.com")).cookies!;
    t.advance(15 * MINUTE_MS);

    expect((await t.rotate(user)).json()).toEqual({ rotated: false });
    expect((await t.rotate(internal)).json()).toEqual({ rotated: true });
    expect(SESSION_ROTATION_INTERVAL_MS).toEqual({
      USER: HOUR_MS,
      PROFESSIONAL: 15 * MINUTE_MS,
      ADMIN: 15 * MINUTE_MS,
      SUPER_ADMIN: 15 * MINUTE_MS,
    });
    await t.app.close();
  });

  it("rotates once when requests race, and never rotates a session twice", async () => {
    const t = await setup();
    await t.register("ana@example.com");
    const cookies = (await t.login("ana@example.com")).cookies!;
    t.advance(SESSION_ROTATION_INTERVAL_MS.USER);

    const answers = await Promise.all([t.rotate(cookies), t.rotate(cookies), t.rotate(cookies)]);

    expect(answers.map((r) => r.json().rotated).filter(Boolean)).toHaveLength(1);
    expect(t.repository.sessions.size).toBe(2);
    // Within the grace period the rotated cookie is valid but cannot rotate again.
    expect((await t.rotate(cookies)).json()).toEqual({ rotated: false });
    expect(t.repository.sessions.size).toBe(2);
    await t.app.close();
  });

  it("revokes sessions whose grace period ended with ROTATED at the next rotation", async () => {
    const t = await setup();
    await t.register("ana@example.com");
    const first = (await t.login("ana@example.com")).cookies!;
    const firstId = [...t.repository.sessions.values()][0]!.id;
    t.advance(SESSION_ROTATION_INTERVAL_MS.USER);
    const second = t.rotatedCookies(await t.rotate(first));
    t.advance(SESSION_ROTATION_INTERVAL_MS.USER);

    expect((await t.rotate(second)).json()).toEqual({ rotated: true });

    const firstSession = t.repository.sessions.get(firstId)!;
    expect(firstSession.revokedReason).toBe("ROTATED");
    expect(firstSession.revokedAt).not.toBeNull();
    await t.app.close();
  });

  it("lists only the renewed session, and logout-all also ends the one in its grace period", async () => {
    const t = await setup();
    await t.register("ana@example.com");
    const cookies = (await t.login("ana@example.com")).cookies!;
    t.advance(SESSION_ROTATION_INTERVAL_MS.USER);
    const fresh = t.rotatedCookies(await t.rotate(cookies));

    const listed = await t.app.inject({
      method: "GET",
      url: "/api/auth/sessions",
      headers: { cookie: cookieHeader({ "__Host-session": fresh.sessionRaw }) },
    });
    expect(listed.json().sessions).toHaveLength(1);
    expect(listed.json().sessions[0].current).toBe(true);

    const all = await t.app.inject({
      method: "POST",
      url: "/api/auth/logout-all",
      headers: {
        origin: ORIGIN,
        "x-csrf-token": fresh.csrfRaw,
        cookie: cookieHeader({ "__Host-session": fresh.sessionRaw }),
      },
    });
    expect(all.statusCode).toBe(204);
    expect((await t.me(cookies)).statusCode).toBe(401); // grace cut short
    expect((await t.me(fresh)).statusCode).toBe(401);
    await t.app.close();
  });

  it("requires a valid session (401) and CSRF (403), and changes nothing without them", async () => {
    const t = await setup();
    await t.register("ana@example.com");
    const cookies = (await t.login("ana@example.com")).cookies!;
    t.advance(SESSION_ROTATION_INTERVAL_MS.USER);

    expect((await t.rotate(undefined)).statusCode).toBe(401);
    for (const csrf of [null, "not-the-csrf-token"]) {
      const response = await t.rotate(cookies, { csrf });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("CSRF_INVALID");
    }
    expect(t.repository.sessions.size).toBe(1);
    expect([...t.repository.sessions.values()][0]!.rotatedAt).toBeNull();
    await t.app.close();
  });

  it("never touches another user's sessions", async () => {
    const t = await setup();
    await t.register("ana@example.com");
    await t.register("luis@example.com");
    const ana = (await t.login("ana@example.com")).cookies!;
    const luis = (await t.login("luis@example.com")).cookies!;
    t.advance(SESSION_ROTATION_INTERVAL_MS.USER);

    expect((await t.rotate(ana)).json()).toEqual({ rotated: true });

    const luisSessions = [...t.repository.sessions.values()].filter(
      (s) => s.userId !== [...t.repository.users.values()][0]!.id,
    );
    expect(luisSessions).toHaveLength(1);
    expect(luisSessions[0]!.rotatedAt).toBeNull();
    expect((await t.me(luis)).statusCode).toBe(200);
    await t.app.close();
  });

  it("is never triggered by GET /api/auth/me (the web server's session check)", async () => {
    const t = await setup();
    await t.register("ana@example.com");
    const cookies = (await t.login("ana@example.com")).cookies!;
    t.advance(SESSION_ROTATION_INTERVAL_MS.USER * 2);

    const response = await t.me(cookies);

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(t.repository.sessions.size).toBe(1);
    await t.app.close();
  });
});

describe("FakeAuthRepository.rotateSession (mirrors the PostgreSQL claim)", () => {
  it("claims a session once: a second rotation of it changes nothing", async () => {
    const t = await setup();
    await t.register("ana@example.com");
    await t.login("ana@example.com");
    const [previous] = [...t.repository.sessions.values()];
    const now = new Date("2026-03-01T13:00:00.000Z");
    const newSession = () => ({
      userId: previous!.userId,
      tokenHash: `hash-${Math.random()}`,
      csrfTokenHash: "csrf",
      lastSeenAt: now,
      idleExpiresAt: previous!.idleExpiresAt,
      absoluteExpiresAt: previous!.absoluteExpiresAt,
      ip: null,
      userAgent: null,
    });
    const input = {
      previousSessionId: previous!.id,
      userId: previous!.userId,
      now,
      graceMs: 60_000,
    };

    expect(await t.repository.rotateSession({ ...input, newSession: newSession() })).not.toBeNull();
    expect(await t.repository.rotateSession({ ...input, newSession: newSession() })).toBeNull();
    expect(
      await t.repository.rotateSession({
        ...input,
        userId: "someone-else",
        newSession: newSession(),
      }),
    ).toBeNull();
    expect(t.repository.sessions.size).toBe(2);
    await t.app.close();
  });
});

describe("rotation on login (ADR-002; decision P12)", () => {
  it("revokes the session the browser already held with ROTATED", async () => {
    const t = await setup();
    await t.register("ana@example.com");
    const before = (await t.login("ana@example.com")).cookies!;
    const beforeId = [...t.repository.sessions.values()][0]!.id;

    const after = (await t.login("ana@example.com", before)).cookies!;

    expect(t.repository.sessions.get(beforeId)!.revokedReason).toBe("ROTATED");
    expect((await t.me(before)).statusCode).toBe(401);
    expect((await t.me(after)).statusCode).toBe(200);
    await t.app.close();
  });

  it("leaves the previous session untouched when the login fails", async () => {
    const t = await setup();
    await t.register("ana@example.com");
    const before = (await t.login("ana@example.com")).cookies!;

    const { response } = await t.login("ana@example.com", before, "wrong password entirely");

    expect(response.statusCode).toBe(401);
    expect([...t.repository.sessions.values()][0]!.revokedAt).toBeNull();
    expect((await t.me(before)).statusCode).toBe(200);
    await t.app.close();
  });
});
