import { describe, expect, it } from "vitest";
import { buildTestApp } from "../../test-support/build-test-app.js";
import { FakeAuthRepository } from "./auth.repository.fake.js";
import { LoginAttemptUnavailableError } from "./auth.types.js";

/**
 * ADR-002 (D3): the per-account login limit is evaluated atomically per account. These tests
 * drive concurrent HTTP logins through the in-memory repository, which serializes attempts per
 * email hash like the PostgreSQL advisory lock does (the real lock is covered by the
 * PostgreSQL integration tests).
 */
const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct horse battery";

type App = Awaited<ReturnType<typeof buildTestApp>>["app"];

function login(app: App, email: string, password: string, remoteAddress = "127.0.0.1") {
  return app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress,
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password },
  });
}

async function register(app: App, email: string) {
  await app.inject({
    method: "POST",
    url: "/api/auth/register",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password: PASSWORD, fullName: "Ana Gómez" },
  });
}

/** N logins at once, each from its own IP so the per-IP limit never interferes. */
async function concurrentLogins(app: App, emails: string[], password = "wrong password entirely") {
  const responses = await Promise.all(
    emails.map((email, i) => login(app, email, password, `203.0.113.${i + 1}`)),
  );
  return responses.map((r) => r.statusCode);
}

const count = (statuses: number[], status: number) => statuses.filter((s) => s === status).length;
const failures = (repository: FakeAuthRepository) =>
  repository.auditLog.filter((e) => e.action === "auth.login.failed").length;

describe("per-account login limit: atomicity (ADR-002, D3)", () => {
  it("never lets concurrent attempts on one account exceed the limit", async () => {
    const { app, repository } = await buildTestApp();
    await register(app, "ana@example.com");

    const statuses = await concurrentLogins(app, Array(10).fill("ana@example.com"));

    expect(count(statuses, 401)).toBe(5);
    expect(count(statuses, 429)).toBe(5);
    expect(failures(repository)).toBe(5);
    await app.close();
  });

  it("limits each account on its own, even when their attempts interleave", async () => {
    const { app, repository } = await buildTestApp();
    await register(app, "ana@example.com");
    await register(app, "bea@example.com");

    const emails = Array.from({ length: 16 }, (_, i) =>
      i % 2 ? "bea@example.com" : "ana@example.com",
    );
    const statuses = await concurrentLogins(app, emails);

    for (const email of ["ana@example.com", "bea@example.com"]) {
      const own = statuses.filter((_, i) => emails[i] === email);
      expect(count(own, 401)).toBe(5);
      expect(count(own, 429)).toBe(3);
    }
    expect(failures(repository)).toBe(10);
    await app.close();
  });

  it("treats every spelling of one normalized email as the same account", async () => {
    const { app, repository } = await buildTestApp();
    await register(app, "ana@example.com");

    const spellings = [
      "ana@example.com",
      "ANA@example.com",
      " ana@example.com ",
      "Ana@Example.com",
    ];
    const statuses = await concurrentLogins(app, [...spellings, ...spellings]);

    expect(count(statuses, 401)).toBe(5);
    expect(count(statuses, 429)).toBe(3);
    expect(failures(repository)).toBe(5);
    await app.close();
  });

  it("limits an unknown email exactly like an existing account", async () => {
    const { app: known } = await buildTestApp();
    await register(known, "ana@example.com");
    const { app: unknown } = await buildTestApp();

    const existing = await concurrentLogins(known, Array(8).fill("ana@example.com"));
    const missing = await concurrentLogins(unknown, Array(8).fill("nobody@example.com"));

    expect([count(missing, 401), count(missing, 429)]).toEqual([
      count(existing, 401),
      count(existing, 429),
    ]);
    expect([count(missing, 401), count(missing, 429)]).toEqual([5, 3]);
    await known.close();
    await unknown.close();
  });

  it("never records a throttled attempt as a failed login", async () => {
    const { app, repository } = await buildTestApp();
    await register(app, "ana@example.com");

    await concurrentLogins(app, Array(5).fill("ana@example.com"));
    const throttled = await concurrentLogins(app, Array(6).fill("ana@example.com"));

    expect(throttled).toEqual(Array(6).fill(429));
    expect(failures(repository)).toBe(5);
    await app.close();
  });

  it("does not reset the counter after a successful login", async () => {
    const { app } = await buildTestApp();
    await register(app, "ana@example.com");

    for (let i = 0; i < 4; i++) await login(app, "ana@example.com", "wrong password entirely");
    expect((await login(app, "ana@example.com", PASSWORD)).statusCode).toBe(200);
    expect((await login(app, "ana@example.com", "wrong password again")).statusCode).toBe(401);

    // Five failures in the window despite the success in between: the account is limited.
    expect((await login(app, "ana@example.com", PASSWORD)).statusCode).toBe(429);
    await app.close();
  });
});

describe("per-account login limit: attempt that cannot be evaluated (ADR-002, D3)", () => {
  class UnavailableRepository extends FakeAuthRepository {
    override async runLoginAttempt<T>(): Promise<T> {
      throw new LoginAttemptUnavailableError();
    }
  }

  class BrokenRepository extends FakeAuthRepository {
    override async runLoginAttempt<T>(): Promise<T> {
      throw new Error('relation "audit_logs" does not exist');
    }
  }

  it("answers 503 SERVICE_UNAVAILABLE with Retry-After: 1 and grants nothing", async () => {
    const repository = new UnavailableRepository();
    const { app } = await buildTestApp({ repository });
    await register(app, "ana@example.com");

    const response = await login(app, "ana@example.com", PASSWORD);

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
    expect(response.json()).toEqual({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Servicio no disponible temporalmente. Inténtalo más tarde.",
        details: [],
        requestId: expect.any(String),
      },
    });
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(repository.sessions.size).toBe(0);
    expect(
      repository.auditLog.filter((e) => e.action.startsWith("auth.login")).map((e) => e.action),
    ).toEqual([]);
    await app.close();
  });

  it("keeps any other failure a 500, not a 503", async () => {
    const repository = new BrokenRepository();
    const { app } = await buildTestApp({ repository });
    await register(app, "ana@example.com");

    const response = await login(app, "ana@example.com", PASSWORD);

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("INTERNAL_ERROR");
    expect(response.headers["retry-after"]).toBeUndefined();
    expect(repository.sessions.size).toBe(0);
    await app.close();
  });
});
