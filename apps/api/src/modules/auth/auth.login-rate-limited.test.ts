import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../security/crypto.js";
import { buildTestApp } from "../../test-support/build-test-app.js";
import { FakeAuthRepository } from "./auth.repository.fake.js";
import { LoginAttemptUnavailableError, type LoginAttemptScope } from "./auth.types.js";

/**
 * ADR-002 (D3-4): a login refused by the per-account limit is audited as
 * `auth.login.rate_limited`, in the attempt's transaction, with no actor and no entity, and
 * answered with the same 429 message as the per-IP limit. It never counts as a failure.
 */
const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct horse battery";
const WRONG = "wrong password entirely";
const SECOND = 1_000;

async function setup(options: Parameters<typeof buildTestApp>[0] = {}) {
  let now = new Date("2026-03-01T12:00:00.000Z");
  const testApp = await buildTestApp({ clock: () => now, ...options });
  let ip = 0;
  // By default each request comes from its own IP, so the per-IP limit never interferes.
  const login = (email: string, password: string, remoteAddress?: string) =>
    testApp.app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: remoteAddress ?? `198.51.100.${(ip++ % 250) + 1}`,
      headers: { origin: ORIGIN, "content-type": "application/json", "user-agent": "d3-4-test" },
      payload: { email, password },
    });
  const register = (email: string) =>
    testApp.app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      payload: { email, password: PASSWORD, fullName: "Ana Gómez" },
    });
  return {
    ...testApp,
    login,
    register,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

const events = (repository: FakeAuthRepository, action: string) =>
  repository.auditLog.filter((e) => e.action === action);
const rateLimited = (repository: FakeAuthRepository) =>
  events(repository, "auth.login.rate_limited");
const failures = (repository: FakeAuthRepository) => events(repository, "auth.login.failed");

/** Five failed logins (or MFA refusals) in a row. */
async function failFiveTimes(attempt: () => Promise<unknown>) {
  for (let i = 0; i < 5; i++) await attempt();
}

describe("auth.login.rate_limited event (ADR-002, D3-4)", () => {
  it("records exactly one event per refused attempt, matching the Retry-After sent", async () => {
    const { app, repository, register, login, advance } = await setup();
    await register("ana@example.com");
    const [user] = [...repository.users.values()];
    await failFiveTimes(() => login("ana@example.com", WRONG));

    const answers: string[] = [];
    for (const wait of [0, 5 * SECOND, 12_300]) {
      advance(wait);
      const blocked = await login("ana@example.com", PASSWORD, "203.0.113.9");
      expect(blocked.statusCode).toBe(429);
      answers.push(blocked.headers["retry-after"] as string);
    }
    expect(answers).toEqual(["30", "25", "13"]);

    const recorded = rateLimited(repository);
    expect(recorded).toHaveLength(3);
    recorded.forEach((event, i) => {
      expect(event).toEqual({
        actorUserId: null,
        actorRole: null,
        action: "auth.login.rate_limited",
        entityType: null,
        entityId: null,
        metadata: {
          emailHash: sha256Hex("ana@example.com"),
          retryAfterSeconds: Number(answers[i]),
        },
        requestId: expect.any(String),
        ip: "203.0.113.9",
        userAgent: "d3-4-test",
      });
      expect(event.requestId).not.toBe("");
    });
    // Each event carries its own request's id.
    expect(new Set(recorded.map((e) => e.requestId)).size).toBe(3);

    const serialized = JSON.stringify(recorded);
    for (const secret of ["ana@example.com", PASSWORD, WRONG, user!.id, user!.passwordHash]) {
      expect(serialized).not.toContain(secret);
    }
    await app.close();
  });

  it("records the same event for an unknown email as for an existing account", async () => {
    const known = await setup();
    const unknown = await setup();
    await known.register("ana@example.com");
    await failFiveTimes(() => known.login("ana@example.com", WRONG));
    await failFiveTimes(() => unknown.login("ana@example.com", WRONG));
    known.advance(10 * SECOND);
    unknown.advance(10 * SECOND);

    const a = await known.login("ana@example.com", WRONG, "203.0.113.9");
    const b = await unknown.login("ana@example.com", WRONG, "203.0.113.9");

    expect([b.statusCode, b.headers["retry-after"], b.json().error.message]).toEqual([
      a.statusCode,
      a.headers["retry-after"],
      a.json().error.message,
    ]);
    const strip = ({ requestId: _, ...rest }: { requestId: string | null }) => rest;
    expect(rateLimited(unknown.repository).map(strip)).toEqual(
      rateLimited(known.repository).map(strip),
    );
    await known.app.close();
    await unknown.app.close();
  });

  it("never counts a refused attempt as a failure", async () => {
    const { app, repository, register, login, advance } = await setup();
    await register("ana@example.com");
    await failFiveTimes(() => login("ana@example.com", WRONG));
    for (let i = 0; i < 20; i++) {
      expect((await login("ana@example.com", WRONG)).statusCode).toBe(429);
    }
    expect(rateLimited(repository)).toHaveLength(20);
    expect(failures(repository)).toHaveLength(5);

    // Still F = 5: the wait is 30 s, and the next failure only raises it to 60 s.
    advance(30 * SECOND);
    expect((await login("ana@example.com", WRONG)).statusCode).toBe(401);
    expect((await login("ana@example.com", WRONG)).headers["retry-after"]).toBe("60");
    await app.close();
  });

  it("answers the per-account 429 exactly like the per-IP 429", async () => {
    const { app, register, login } = await setup();
    await register("ana@example.com");
    await failFiveTimes(() => login("ana@example.com", WRONG));
    const byAccount = await login("ana@example.com", WRONG);

    for (let i = 0; i < 10; i++) await login(`user${i}@example.com`, WRONG, "192.0.2.1");
    const byIp = await login("user10@example.com", WRONG, "192.0.2.1");

    expect(byAccount.statusCode).toBe(429);
    expect(byIp.statusCode).toBe(429);
    const withoutId = (body: { error: Record<string, unknown> }) => ({
      ...body.error,
      requestId: undefined,
    });
    expect(withoutId(byAccount.json())).toEqual(withoutId(byIp.json()));
    expect(byAccount.json().error).toMatchObject({
      code: "RATE_LIMITED",
      message: "Demasiadas solicitudes. Inténtalo más tarde.",
      details: [],
    });
    await app.close();
  });

  it("records nothing for a request refused by the per-IP limit", async () => {
    const { app, repository, login } = await setup();
    for (let i = 0; i < 10; i++) await login(`user${i}@example.com`, WRONG, "192.0.2.1");

    const byIp = await login("user10@example.com", WRONG, "192.0.2.1");

    expect(byIp.statusCode).toBe(429);
    expect(rateLimited(repository)).toHaveLength(0);
    expect(failures(repository)).toHaveLength(10);
    await app.close();
  });

  it("records nothing when the refusal is rolled back (503)", async () => {
    /** Runs the attempt, then fails as a transaction that expires before its commit (P2028). */
    class ExpiringRepository extends FakeAuthRepository {
      expire = false;
      override async runLoginAttempt<T>(
        emailHash: string,
        windowMs: number,
        attempt: (scope: LoginAttemptScope) => Promise<T>,
      ): Promise<T> {
        if (!this.expire) return super.runLoginAttempt(emailHash, windowMs, attempt);
        return super.runLoginAttempt(emailHash, windowMs, async (scope) => {
          await attempt(scope);
          throw new LoginAttemptUnavailableError();
        });
      }
    }
    const repository = new ExpiringRepository();
    const { app, register, login } = await setup({ repository });
    await register("ana@example.com");
    await failFiveTimes(() => login("ana@example.com", WRONG));

    repository.expire = true;
    const response = await login("ana@example.com", WRONG);

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
    expect(rateLimited(repository)).toHaveLength(0);
    expect(failures(repository)).toHaveLength(5);
    await app.close();
  });
});

describe("per-account limit for suspended and MFA-barred accounts (ADR-002, D3-4)", () => {
  it("limits a suspended account after five failures, like any other account", async () => {
    const suspended = await setup();
    const unknown = await setup();
    await suspended.register("ana@example.com");
    const [user] = [...suspended.repository.users.values()];
    user!.status = "SUSPENDED";

    for (let i = 0; i < 5; i++) {
      expect((await suspended.login("ana@example.com", PASSWORD)).statusCode).toBe(401);
      await unknown.login("ana@example.com", PASSWORD);
    }
    suspended.advance(10 * SECOND);
    unknown.advance(10 * SECOND);

    const a = await suspended.login("ana@example.com", PASSWORD);
    const b = await unknown.login("ana@example.com", PASSWORD);
    expect([a.statusCode, a.headers["retry-after"]]).toEqual([429, "20"]);
    expect([b.statusCode, b.headers["retry-after"]]).toEqual([429, "20"]);
    expect(failures(suspended.repository)).toHaveLength(5);
    expect(rateLimited(suspended.repository)).toEqual([
      expect.objectContaining({ actorUserId: null, entityId: null }),
    ]);
    await suspended.app.close();
    await unknown.app.close();
  });

  it("counts production MFA-barrier refusals, then limits the account", async () => {
    const { app, repository, register, login } = await setup({ isProduction: true });
    await register("admin@example.com");
    const [user] = [...repository.users.values()];
    user!.role = "ADMIN";

    for (let i = 0; i < 5; i++) {
      expect((await login("admin@example.com", PASSWORD)).statusCode).toBe(403);
    }
    const blocked = await login("admin@example.com", PASSWORD);

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("30");
    expect(failures(repository).map((e) => e.metadata?.reason)).toEqual(
      Array(5).fill("mfa_required_production"),
    );
    expect(rateLimited(repository)).toEqual([
      expect.objectContaining({
        actorUserId: null,
        actorRole: null,
        metadata: { emailHash: sha256Hex("admin@example.com"), retryAfterSeconds: 30 },
      }),
    ]);
    expect(repository.sessions.size).toBe(0);
    await app.close();
  });
});

describe("per-IP and per-account limits together (ADR-002, D3-4)", () => {
  it("checks the IP first: an account refusal uses up IP quota, and the IP refusal wins", async () => {
    const { app, repository, register, login } = await setup();
    await register("ana@example.com");
    const fromOneIp = () => login("ana@example.com", WRONG, "192.0.2.7");

    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await fromOneIp()).statusCode);
    expect(statuses).toEqual([...Array(5).fill(401), ...Array(5).fill(429)]);
    expect(rateLimited(repository)).toHaveLength(5);

    // The five account refusals consumed the IP's 10 requests: the 11th is the IP's 429,
    // with the IP window's Retry-After, and it records nothing.
    const byIp = await fromOneIp();
    expect(byIp.statusCode).toBe(429);
    expect(Number(byIp.headers["retry-after"])).toBeGreaterThan(30);
    expect(rateLimited(repository)).toHaveLength(5);
    expect(failures(repository)).toHaveLength(5);

    // The account limit still applies from any other IP.
    const elsewhere = await login("ana@example.com", WRONG, "192.0.2.8");
    expect(elsewhere.statusCode).toBe(429);
    expect(rateLimited(repository)).toHaveLength(6);
    await app.close();
  });
});
