import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../security/crypto.js";
import { cookieHeader, findSetCookie } from "../../test-support/cookies.js";
import { buildTestApp } from "../../test-support/build-test-app.js";
import { createEmailComposers } from "../notifications/composers.js";
import { dispatchPendingEmails } from "../notifications/dispatch.js";
import { MemoryEmailTransport } from "../notifications/transports.js";
import { FakeAuthRepository } from "./auth.repository.fake.js";
import { EMAIL_VERIFICATION_TOKEN_TTL_MS } from "./auth.email-settings.js";
import { LoginAttemptUnavailableError, type AuditLogEntry } from "./auth.types.js";

/**
 * Email verification (ADR-002 req. 6; Sprint 1B decisions C2, P6, P7, P14): registration records
 * the initial verification email; dispatch generates the token (only its hash is stored) and a
 * link carrying it in the URL fragment; POST /api/auth/email/verify consumes it once; the resend
 * needs a session and CSRF, and is limited per IP and, progressively, per account.
 */
const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct horse battery";
const EMAIL = "ana@example.com";

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;

async function setup(options: Parameters<typeof buildTestApp>[0] = {}) {
  let now = new Date("2026-03-01T12:00:00.000Z");
  const testApp = await buildTestApp({ clock: () => now, ...options });
  const transport = new MemoryEmailTransport();
  const composers = createEmailComposers({
    appOrigin: ORIGIN,
    emailVerificationTokenTtlMs: EMAIL_VERIFICATION_TOKEN_TTL_MS,
    passwordResetTokenTtlMs: 30 * 60 * 1000,
  });
  return {
    ...testApp,
    transport,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    dispatch: () => dispatchPendingEmails(testApp.repository.outbox, transport, composers),
  };
}

function register(testApp: TestApp, email = EMAIL, remoteAddress?: string) {
  return testApp.app.inject({
    method: "POST",
    url: "/api/auth/register",
    remoteAddress,
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password: PASSWORD, fullName: "Ana Gómez" },
  });
}

async function login(testApp: TestApp, email = EMAIL, remoteAddress?: string) {
  const response = await testApp.app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress,
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password: PASSWORD },
  });
  return {
    sessionRaw: findSetCookie(response.headers["set-cookie"], "__Host-session")!.value,
    csrfRaw: findSetCookie(response.headers["set-cookie"], "__Host-csrf")!.value,
  };
}

function verify(testApp: TestApp, token: unknown, origin: string | null = ORIGIN) {
  return testApp.app.inject({
    method: "POST",
    url: "/api/auth/email/verify",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    payload: { token },
  });
}

function resend(
  testApp: TestApp,
  as: { sessionRaw: string; csrfRaw: string } | undefined,
  options: { csrf?: string | null; remoteAddress?: string } = {},
) {
  const csrf = options.csrf === undefined ? as?.csrfRaw : options.csrf;
  return testApp.app.inject({
    method: "POST",
    url: "/api/auth/email/verification/resend",
    remoteAddress: options.remoteAddress,
    headers: {
      origin: ORIGIN,
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...(as ? { cookie: cookieHeader({ "__Host-session": as.sessionRaw }) } : {}),
    },
  });
}

/** The token carried by the latest email's link, read from its URL fragment. */
function tokenFromLatestEmail(transport: MemoryEmailTransport): string {
  const text = transport.sent[transport.sent.length - 1]!.text;
  const match = /http:\/\/localhost:3000\/verificar-correo#token=([A-Za-z0-9_-]+)/.exec(text);
  expect(match).not.toBeNull();
  return match![1]!;
}

const verificationEntries = (repository: FakeAuthRepository) =>
  repository.outbox.entries.filter((e) => e.kind === "EMAIL_VERIFICATION");

describe("email verification: registration and dispatch", () => {
  it("records one verification email on registration, with no token yet", async () => {
    const testApp = await setup();
    await register(testApp);
    const [user] = [...testApp.repository.users.values()];

    expect(verificationEntries(testApp.repository)).toEqual([
      expect.objectContaining({ userId: user!.id, sentAt: null }),
    ]);
    expect(testApp.repository.outbox.emailVerificationTokens).toEqual([]);

    // A duplicate registration records nothing (and answers the same 202).
    expect((await register(testApp)).statusCode).toBe(202);
    expect(verificationEntries(testApp.repository)).toHaveLength(1);
    await testApp.app.close();
  });

  it("sends a link with the token in the URL fragment, and stores only its hash", async () => {
    const testApp = await setup();
    await register(testApp);
    expect(await testApp.dispatch()).toEqual({ sent: 1, failed: 0 });

    const [message] = testApp.transport.sent;
    expect(message!.to).toBe(EMAIL);
    const token = tokenFromLatestEmail(testApp.transport);
    expect(message!.text).not.toMatch(/\?token=|\/verificar-correo\/[A-Za-z0-9]/); // never query/path

    const [stored] = testApp.repository.outbox.emailVerificationTokens;
    expect(stored!.tokenHash).toBe(sha256Hex(token));
    expect(stored!.expiresAt.getTime() - stored!.createdAt.getTime()).toBe(
      EMAIL_VERIFICATION_TOKEN_TTL_MS,
    );
    const persisted = JSON.stringify({
      outbox: testApp.repository.outbox.entries,
      tokens: testApp.repository.outbox.emailVerificationTokens,
      audit: testApp.repository.auditLog,
    });
    expect(persisted).not.toContain(token);
    await testApp.app.close();
  });
});

describe("POST /api/auth/email/verify", () => {
  it("verifies the email once, audits it, and shows it as verified", async () => {
    const testApp = await setup();
    await register(testApp);
    await testApp.dispatch();
    const token = tokenFromLatestEmail(testApp.transport);

    const response = await verify(testApp, token);

    expect(response.statusCode).toBe(204);
    const [user] = [...testApp.repository.users.values()];
    expect(user!.emailVerifiedAt).not.toBeNull();
    expect(testApp.repository.auditLog.filter((e) => e.action === "auth.email.verified")).toEqual([
      expect.objectContaining({
        actorUserId: user!.id,
        actorRole: "USER",
        entityType: "User",
        entityId: user!.id,
      }),
    ]);
    expect(JSON.stringify(testApp.repository.auditLog)).not.toContain(token);

    const session = await login(testApp);
    const me = await testApp.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookieHeader({ "__Host-session": session.sessionRaw }) },
    });
    expect(me.json().user.emailVerified).toBe(true);
    await testApp.app.close();
  });

  it("keeps nothing if the audit write fails: the token stays usable and the email unverified", async () => {
    let failAudit = true;
    class FailingAuditRepository extends FakeAuthRepository {
      protected override recordAudit(entry: AuditLogEntry): void {
        if (failAudit && entry.action === "auth.email.verified") throw new Error("audit failed");
        super.recordAudit(entry);
      }
    }
    const testApp = await setup({ repository: new FailingAuditRepository() });
    await register(testApp);
    await testApp.dispatch();
    const token = tokenFromLatestEmail(testApp.transport);

    expect((await verify(testApp, token)).statusCode).toBe(500);
    const [user] = [...testApp.repository.users.values()];
    expect(user!.emailVerifiedAt).toBeNull();
    expect(testApp.repository.auditLog.some((e) => e.action === "auth.email.verified")).toBe(false);

    // Nothing was consumed: the same link works once the audit write succeeds, with one event.
    failAudit = false;
    expect((await verify(testApp, token)).statusCode).toBe(204);
    expect(user!.emailVerifiedAt).not.toBeNull();
    expect(
      testApp.repository.auditLog.filter((e) => e.action === "auth.email.verified"),
    ).toHaveLength(1);
    await testApp.app.close();
  });

  it("answers a reused, an unknown and an expired token with the same 400", async () => {
    const testApp = await setup();
    await register(testApp, "ana@example.com");
    await register(testApp, "luis@example.com");
    await testApp.dispatch();
    // By recipient: both emails have the same timestamp (frozen clock), so either may go first.
    const tokenFor = (to: string) =>
      /#token=([A-Za-z0-9_-]+)/.exec(testApp.transport.sent.find((m) => m.to === to)!.text)![1]!;
    const anaToken = tokenFor("ana@example.com");
    const luisToken = tokenFor("luis@example.com");

    expect((await verify(testApp, anaToken)).statusCode).toBe(204);
    const reused = await verify(testApp, anaToken);
    const unknown = await verify(testApp, "not-a-real-verification-token");
    testApp.advance(EMAIL_VERIFICATION_TOKEN_TTL_MS);
    const expired = await verify(testApp, luisToken);

    const shape = (r: typeof reused) => ({
      status: r.statusCode,
      code: r.json().error.code,
      message: r.json().error.message,
    });
    expect(shape(reused)).toEqual({
      status: 400,
      code: "INVALID_OR_EXPIRED_TOKEN",
      message: "El enlace no es válido o ha caducado.",
    });
    expect(shape(unknown)).toEqual(shape(reused));
    expect(shape(expired)).toEqual(shape(reused));
    const luis = [...testApp.repository.users.values()].find((u) => u.email === "luis@example.com");
    expect(luis!.emailVerifiedAt).toBeNull();
    await testApp.app.close();
  });

  it("validates the body and checks the Origin", async () => {
    const testApp = await setup();
    for (const token of ["", 42, "x".repeat(257)]) {
      const response = await verify(testApp, token);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    }
    const crossSite = await verify(testApp, "whatever", "https://evil.example");
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.json().error.code).toBe("CSRF_INVALID");
    await testApp.app.close();
  });
});

describe("POST /api/auth/email/verification/resend", () => {
  it("records one more email, whose token replaces the previous one (P7)", async () => {
    const testApp = await setup();
    await register(testApp);
    await testApp.dispatch();
    const first = tokenFromLatestEmail(testApp.transport);
    const session = await login(testApp);

    const response = await resend(testApp, session);
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "accepted" });
    expect(verificationEntries(testApp.repository)).toHaveLength(2);

    await testApp.dispatch();
    const second = tokenFromLatestEmail(testApp.transport);
    expect(second).not.toBe(first);
    expect((await verify(testApp, first)).statusCode).toBe(400);
    expect((await verify(testApp, second)).statusCode).toBe(204);
    await testApp.app.close();
  });

  it("records nothing for an address that is already verified", async () => {
    const testApp = await setup();
    await register(testApp);
    await testApp.dispatch();
    await verify(testApp, tokenFromLatestEmail(testApp.transport));
    const session = await login(testApp);

    expect((await resend(testApp, session)).statusCode).toBe(202);
    expect(verificationEntries(testApp.repository)).toHaveLength(1);
    await testApp.app.close();
  });

  it("needs a session (401) and CSRF (403), and records nothing without them", async () => {
    const testApp = await setup();
    await register(testApp);
    const session = await login(testApp);

    expect((await resend(testApp, undefined)).statusCode).toBe(401);
    for (const csrf of [null, "not-the-csrf-token"]) {
      const response = await resend(testApp, session, { csrf });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("CSRF_INVALID");
    }
    expect(verificationEntries(testApp.repository)).toHaveLength(1);
    await testApp.app.close();
  });

  it("applies the progressive per-account delay, counting the registration email", async () => {
    const testApp = await setup();
    await register(testApp);
    const session = await login(testApp);

    // Registration + 2 resends = 3 emails: the free allowance.
    expect((await resend(testApp, session)).statusCode).toBe(202);
    expect((await resend(testApp, session)).statusCode).toBe(202);
    const throttled = await resend(testApp, session);
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers["retry-after"]).toBe("30");
    expect(throttled.json().error.message).toBe("Demasiadas solicitudes. Inténtalo más tarde.");
    expect(verificationEntries(testApp.repository)).toHaveLength(3);

    testApp.advance(30_000);
    expect((await resend(testApp, session)).statusCode).toBe(202);
    expect((await resend(testApp, session)).headers["retry-after"]).toBe("60");
    await testApp.app.close();
  });

  it("limits resends per IP, before the per-account limit", async () => {
    const testApp = await setup();
    const sessions = [];
    for (let i = 0; i < 6; i++) {
      // Each account registers and logs in from its own IP (the registration limit is per IP).
      await register(testApp, `user${i}@example.com`, `198.51.100.${i + 1}`);
      sessions.push(await login(testApp, `user${i}@example.com`, `198.51.100.${i + 1}`));
    }
    for (let i = 0; i < 5; i++) {
      const response = await resend(testApp, sessions[i], { remoteAddress: "192.0.2.9" });
      expect(response.statusCode).toBe(202);
    }
    const blocked = await resend(testApp, sessions[5], { remoteAddress: "192.0.2.9" });

    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(60);
    // 6 registration emails + 5 resends; the blocked one recorded nothing.
    expect(verificationEntries(testApp.repository)).toHaveLength(11);
    await testApp.app.close();
  });

  it("answers 503 when the resend cannot be evaluated, and records nothing", async () => {
    class UnavailableRepository extends FakeAuthRepository {
      override async runEmailVerificationResend<T>(): Promise<T> {
        throw new LoginAttemptUnavailableError();
      }
    }
    const repository = new UnavailableRepository();
    const testApp = await setup({ repository });
    await register(testApp);
    const session = await login(testApp);

    const response = await resend(testApp, session);

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
    expect(verificationEntries(repository)).toHaveLength(1);
    await testApp.app.close();
  });
});
