import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../security/crypto.js";
import { cookieHeader, findSetCookie } from "../../test-support/cookies.js";
import { buildTestApp } from "../../test-support/build-test-app.js";
import { createEmailComposers } from "../notifications/composers.js";
import { dispatchPendingEmails } from "../notifications/dispatch.js";
import { MemoryEmailTransport } from "../notifications/transports.js";
import { PASSWORD_RESET_TOKEN_TTL_MS } from "./auth.email-settings.js";
import { FakeAuthRepository } from "./auth.repository.fake.js";
import { LoginAttemptUnavailableError } from "./auth.types.js";

/**
 * Password recovery (ADR-002 req. 7; Sprint 1B decisions C2, P7, P14): the request answers the
 * same whether or not the address exists and records the reset email for a registered one; the
 * reset uses the token once, replaces the password, revokes every session with PASSWORD_RESET
 * and notifies by email — all in one transaction.
 */
const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a brand new passphrase";
const EMAIL = "ana@example.com";

type TestApp = Awaited<ReturnType<typeof setup>>;

async function setup(options: Parameters<typeof buildTestApp>[0] = {}) {
  let now = new Date("2026-03-01T12:00:00.000Z");
  const testApp = await buildTestApp({ clock: () => now, ...options });
  const transport = new MemoryEmailTransport();
  const composers = createEmailComposers({
    appOrigin: ORIGIN,
    emailVerificationTokenTtlMs: 24 * 60 * 60 * 1000,
    passwordResetTokenTtlMs: PASSWORD_RESET_TOKEN_TTL_MS,
  });
  let ip = 0;
  return {
    ...testApp,
    transport,
    /** A fresh IP per request, so the per-IP limits never interfere unless a test wants them. */
    nextIp: () => `198.51.100.${(ip++ % 250) + 1}`,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    dispatch: () => dispatchPendingEmails(testApp.repository.outbox, transport, composers),
  };
}

function register(testApp: TestApp, email = EMAIL) {
  return testApp.app.inject({
    method: "POST",
    url: "/api/auth/register",
    remoteAddress: testApp.nextIp(),
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password: PASSWORD, fullName: "Ana Gómez" },
  });
}

function login(testApp: TestApp, password: string, email = EMAIL) {
  return testApp.app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: testApp.nextIp(),
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password },
  });
}

function forgot(testApp: TestApp, email: unknown, remoteAddress = testApp.nextIp()) {
  return testApp.app.inject({
    method: "POST",
    url: "/api/auth/password/forgot",
    remoteAddress,
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email },
  });
}

function reset(
  testApp: TestApp,
  token: string,
  newPassword = NEW_PASSWORD,
  options: { remoteAddress?: string; origin?: string } = {},
) {
  return testApp.app.inject({
    method: "POST",
    url: "/api/auth/password/reset",
    remoteAddress: options.remoteAddress ?? testApp.nextIp(),
    headers: { origin: options.origin ?? ORIGIN, "content-type": "application/json" },
    payload: { token, newPassword },
  });
}

/** Requests a reset for EMAIL, dispatches it and returns the token from the link's fragment. */
async function resetToken(testApp: TestApp): Promise<string> {
  expect((await forgot(testApp, EMAIL)).statusCode).toBe(202);
  await testApp.dispatch();
  // The latest reset email: the registration's verification email may be dispatched in the same
  // run, in either order (the test clock is frozen, so both have the same timestamp).
  const link = /http:\/\/localhost:3000\/restablecer-contrasena#token=([A-Za-z0-9_-]+)/;
  const resets = testApp.transport.sent.filter((m) => link.test(m.text));
  expect(resets.length).toBeGreaterThan(0);
  return link.exec(resets[resets.length - 1]!.text)![1]!;
}

const entries = (repository: FakeAuthRepository, kind: string) =>
  repository.outbox.entries.filter((e) => e.kind === kind);
const events = (repository: FakeAuthRepository, action: string) =>
  repository.auditLog.filter((e) => e.action === action);

describe("POST /api/auth/password/forgot", () => {
  it("answers the same for a registered and an unknown address, and emails only the first", async () => {
    const testApp = await setup();
    await register(testApp);
    const [user] = [...testApp.repository.users.values()];

    const known = await forgot(testApp, EMAIL);
    const unknown = await forgot(testApp, "nobody@example.com");

    expect([known.statusCode, known.json()]).toEqual([202, { status: "accepted" }]);
    expect([unknown.statusCode, unknown.json()]).toEqual([known.statusCode, known.json()]);
    expect(entries(testApp.repository, "PASSWORD_RESET")).toEqual([
      expect.objectContaining({ userId: user!.id, sentAt: null }),
    ]);
    expect(events(testApp.repository, "auth.password.reset_requested")).toEqual([
      expect.objectContaining({ actorUserId: user!.id, metadata: { emailHash: sha256Hex(EMAIL) } }),
      expect.objectContaining({
        actorUserId: null,
        metadata: { emailHash: sha256Hex("nobody@example.com") },
      }),
    ]);
    expect(JSON.stringify(testApp.repository.auditLog)).not.toContain("nobody@example.com");
    await testApp.app.close();
  });

  it("sends a link with the token in the fragment and stores only its hash", async () => {
    const testApp = await setup();
    await register(testApp);
    const token = await resetToken(testApp);

    const [stored] = testApp.repository.outbox.passwordResetTokens;
    expect(stored!.tokenHash).toBe(sha256Hex(token));
    expect(stored!.expiresAt.getTime() - stored!.createdAt.getTime()).toBe(
      PASSWORD_RESET_TOKEN_TTL_MS,
    );
    const persisted = JSON.stringify({
      outbox: testApp.repository.outbox.entries,
      tokens: testApp.repository.outbox.passwordResetTokens,
      audit: testApp.repository.auditLog,
    });
    expect(persisted).not.toContain(token);
    await testApp.app.close();
  });

  it("applies the progressive per-email delay, identically for an unknown address", async () => {
    const testApp = await setup();
    await register(testApp);
    const answers = async (email: string) => {
      const out: Array<[number, string | undefined]> = [];
      for (let i = 0; i < 4; i++) {
        const r = await forgot(testApp, email);
        out.push([r.statusCode, r.headers["retry-after"] as string | undefined]);
      }
      return out;
    };

    const known = await answers(EMAIL);
    const unknown = await answers("nobody@example.com");

    expect(known).toEqual([
      [202, undefined],
      [202, undefined],
      [202, undefined],
      [429, "30"],
    ]);
    expect(unknown).toEqual(known);
    // A refused request records nothing: still three requests, three reset emails.
    expect(entries(testApp.repository, "PASSWORD_RESET")).toHaveLength(3);
    await testApp.app.close();
  });

  it("limits requests per IP", async () => {
    const testApp = await setup();
    for (let i = 0; i < 5; i++) {
      expect((await forgot(testApp, `user${i}@example.com`, "192.0.2.3")).statusCode).toBe(202);
    }
    const blocked = await forgot(testApp, "user5@example.com", "192.0.2.3");
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(60);
    await testApp.app.close();
  });

  it("validates the body and checks the Origin", async () => {
    const testApp = await setup();
    expect((await forgot(testApp, "not an email")).json().error.code).toBe("VALIDATION_ERROR");
    const crossSite = await testApp.app.inject({
      method: "POST",
      url: "/api/auth/password/forgot",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      payload: { email: EMAIL },
    });
    expect(crossSite.statusCode).toBe(403);
    await testApp.app.close();
  });

  it("answers 503 when the request cannot be evaluated, and records nothing", async () => {
    class UnavailableRepository extends FakeAuthRepository {
      override async runPasswordResetRequest<T>(): Promise<T> {
        throw new LoginAttemptUnavailableError();
      }
    }
    const repository = new UnavailableRepository();
    const testApp = await setup({ repository });
    await register(testApp);

    const response = await forgot(testApp, EMAIL);

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
    expect(entries(repository, "PASSWORD_RESET")).toEqual([]);
    await testApp.app.close();
  });
});

describe("POST /api/auth/password/reset", () => {
  it("replaces the password, revokes every session, notifies and audits", async () => {
    const testApp = await setup();
    await register(testApp);
    const sessions = [];
    for (let i = 0; i < 2; i++) {
      const r = await login(testApp, PASSWORD);
      sessions.push(findSetCookie(r.headers["set-cookie"], "__Host-session")!.value);
    }
    const token = await resetToken(testApp);

    const response = await reset(testApp, token);

    expect(response.statusCode).toBe(204);
    for (const session of testApp.repository.sessions.values()) {
      expect(session.revokedReason).toBe("PASSWORD_RESET");
    }
    for (const sessionRaw of sessions) {
      const me = await testApp.app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: cookieHeader({ "__Host-session": sessionRaw }) },
      });
      expect(me.statusCode).toBe(401);
    }
    expect((await login(testApp, PASSWORD)).statusCode).toBe(401);
    expect((await login(testApp, NEW_PASSWORD)).statusCode).toBe(200);

    const [user] = [...testApp.repository.users.values()];
    expect(events(testApp.repository, "auth.password.reset_completed")).toEqual([
      expect.objectContaining({ actorUserId: user!.id, entityType: "User", entityId: user!.id }),
    ]);
    expect(entries(testApp.repository, "PASSWORD_RESET_COMPLETED")).toHaveLength(1);
    await testApp.dispatch();
    const notice = testApp.transport.sent[testApp.transport.sent.length - 1]!;
    expect(notice.subject).toBe("Tu contraseña se ha cambiado");
    expect(notice.text).not.toMatch(/token=/);
    const persisted = JSON.stringify(testApp.repository.auditLog);
    expect(persisted).not.toContain(token);
    expect(persisted).not.toContain(NEW_PASSWORD);
    await testApp.app.close();
  });

  it("never touches another user's sessions or password", async () => {
    const testApp = await setup();
    await register(testApp);
    await register(testApp, "luis@example.com");
    const luis = await login(testApp, PASSWORD, "luis@example.com");
    const token = await resetToken(testApp);

    expect((await reset(testApp, token)).statusCode).toBe(204);

    const luisSession = findSetCookie(luis.headers["set-cookie"], "__Host-session")!.value;
    const me = await testApp.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookieHeader({ "__Host-session": luisSession }) },
    });
    expect(me.statusCode).toBe(200);
    expect((await login(testApp, PASSWORD, "luis@example.com")).statusCode).toBe(200);
    await testApp.app.close();
  });

  it("answers a reused, an unknown, an expired and a superseded token with the same 400", async () => {
    const testApp = await setup();
    await register(testApp);
    const superseded = await resetToken(testApp);
    const current = await resetToken(testApp); // P7: invalidates `superseded`
    const expiring = current;

    const shape = (r: Awaited<ReturnType<typeof reset>>) => ({
      status: r.statusCode,
      code: r.json().error.code,
      message: r.json().error.message,
    });
    const supersededAnswer = await reset(testApp, superseded);
    const unknown = await reset(testApp, "not-a-real-reset-token");
    testApp.advance(PASSWORD_RESET_TOKEN_TTL_MS);
    const expired = await reset(testApp, expiring);

    expect(shape(supersededAnswer)).toEqual({
      status: 400,
      code: "INVALID_OR_EXPIRED_TOKEN",
      message: "El enlace no es válido o ha caducado.",
    });
    expect(shape(unknown)).toEqual(shape(supersededAnswer));
    expect(shape(expired)).toEqual(shape(supersededAnswer));
    expect((await login(testApp, PASSWORD)).statusCode).toBe(200); // password unchanged

    // A used token cannot be used again.
    const fresh = await resetToken(testApp);
    expect((await reset(testApp, fresh)).statusCode).toBe(204);
    expect(shape(await reset(testApp, fresh, "yet another passphrase"))).toEqual(
      shape(supersededAnswer),
    );
    expect((await login(testApp, NEW_PASSWORD)).statusCode).toBe(200);
    await testApp.app.close();
  });

  it("validates the new password (12–128) and checks the Origin", async () => {
    const testApp = await setup();
    await register(testApp);
    const token = await resetToken(testApp);

    for (const newPassword of ["short", "x".repeat(129)]) {
      const response = await reset(testApp, token, newPassword);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    }
    expect(
      (await reset(testApp, token, NEW_PASSWORD, { origin: "https://evil.example" })).statusCode,
    ).toBe(403);
    // Neither attempt used the token.
    expect((await reset(testApp, token)).statusCode).toBe(204);
    await testApp.app.close();
  });

  it("limits reset requests per IP", async () => {
    const testApp = await setup();
    for (let i = 0; i < 5; i++) {
      expect(
        (await reset(testApp, `unknown-${i}`, NEW_PASSWORD, { remoteAddress: "192.0.2.4" }))
          .statusCode,
      ).toBe(400);
    }
    const blocked = await reset(testApp, "unknown-5", NEW_PASSWORD, { remoteAddress: "192.0.2.4" });
    expect(blocked.statusCode).toBe(429);
    await testApp.app.close();
  });
});
