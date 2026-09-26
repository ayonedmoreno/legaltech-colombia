import type { InjectOptions } from "fastify";
import { describe, expect, it } from "vitest";
import { findSetCookie } from "../../test-support/cookies.js";
import { buildTestApp } from "../../test-support/build-test-app.js";

const ORIGIN = "http://localhost:3000";
const CREDENTIALS = { email: "ana@example.com", password: "correct horse battery" };

async function login(
  app: Awaited<ReturnType<typeof buildTestApp>>["app"],
  body: InjectOptions["payload"],
) {
  return app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: body,
  });
}

async function registerAndLogin(overrides: Parameters<typeof buildTestApp>[0] = {}) {
  const testApp = await buildTestApp(overrides);
  await testApp.app.inject({
    method: "POST",
    url: "/api/auth/register",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { ...CREDENTIALS, fullName: "Ana Gómez" },
  });
  return testApp;
}

describe("POST /api/auth/login", () => {
  it("logs in with valid credentials and sets session + csrf cookies", async () => {
    const { app } = await registerAndLogin();
    const response = await login(app, CREDENTIALS);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: expect.objectContaining({ email: CREDENTIALS.email, role: "USER" }),
    });

    const setCookie = response.headers["set-cookie"];
    const session = findSetCookie(setCookie, "__Host-session");
    const csrf = findSetCookie(setCookie, "__Host-csrf");
    expect(session).toBeDefined();
    expect(csrf).toBeDefined();
    expect(session!.attributes.map((a) => a.toLowerCase())).toEqual(
      expect.arrayContaining(["httponly", "secure", "samesite=lax", "path=/"]),
    );
    // The CSRF cookie must be readable by client-side code (double-submit pattern).
    expect(csrf!.attributes.map((a) => a.toLowerCase())).not.toContain("httponly");
    expect(csrf!.attributes.map((a) => a.toLowerCase())).toEqual(
      expect.arrayContaining(["secure", "samesite=lax", "path=/"]),
    );
    await app.close();
  });

  it("never stores the raw session token, only its hash", async () => {
    const { app, repository } = await registerAndLogin();
    const response = await login(app, CREDENTIALS);
    const sessionRaw = findSetCookie(response.headers["set-cookie"], "__Host-session")!.value;

    const [session] = [...repository.sessions.values()];
    expect(session?.tokenHash).not.toBe(sessionRaw);
    expect(session?.tokenHash).toHaveLength(64); // sha256 hex
    await app.close();
  });

  it("rejects an incorrect password with a generic message", async () => {
    const { app } = await registerAndLogin();
    const response = await login(app, { ...CREDENTIALS, password: "wrong password entirely" });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("INVALID_CREDENTIALS");
    await app.close();
  });

  it("rejects a nonexistent user with the same status and message as a wrong password", async () => {
    const { app } = await registerAndLogin();
    const wrongPassword = await login(app, { ...CREDENTIALS, password: "wrong password entirely" });
    const noSuchUser = await login(app, { email: "nobody@example.com", password: "whatever12345" });

    // Two distinct HTTP requests legitimately get two distinct request ids (app.ts assigns a
    // fresh one per request); comparing the full JSON bodies would fail on that field alone
    // without saying anything about authentication security. What must be indistinguishable
    // is the authentication contract itself: status, error code, message and details.
    const wrongBody = wrongPassword.json();
    const noSuchBody = noSuchUser.json();
    expect(noSuchUser.statusCode).toBe(wrongPassword.statusCode);
    expect(noSuchBody.error.code).toBe(wrongBody.error.code);
    expect(noSuchBody.error.message).toBe(wrongBody.error.message);
    expect(noSuchBody.error.details).toEqual(wrongBody.error.details);
    await app.close();
  });

  it("rejects a SUSPENDED user with correct credentials exactly like a wrong password", async () => {
    const { app, repository } = await registerAndLogin();
    const wrongPassword = await login(app, { ...CREDENTIALS, password: "wrong password entirely" });
    const [user] = [...repository.users.values()];
    user!.status = "SUSPENDED";

    const suspended = await login(app, CREDENTIALS);

    // Same contract as a wrong password (request ids legitimately differ, see above): the
    // response must not reveal that the password was right or that the account is suspended.
    const wrongBody = wrongPassword.json();
    const suspendedBody = suspended.json();
    expect(suspended.statusCode).toBe(401);
    expect(suspendedBody.error.code).toBe("INVALID_CREDENTIALS");
    expect(suspended.statusCode).toBe(wrongPassword.statusCode);
    expect(suspendedBody.error.code).toBe(wrongBody.error.code);
    expect(suspendedBody.error.message).toBe(wrongBody.error.message);
    expect(suspendedBody.error.details).toEqual(wrongBody.error.details);
    expect(Object.keys(suspendedBody).sort()).toEqual(Object.keys(wrongBody).sort());
    expect(Object.keys(suspendedBody.error).sort()).toEqual(Object.keys(wrongBody.error).sort());

    // No session is created and no cookie is issued.
    expect(repository.sessions.size).toBe(0);
    expect(suspended.headers["set-cookie"]).toBeUndefined();
    await app.close();
  });

  it("audits a SUSPENDED user's login attempt as a failure attributed to that user", async () => {
    const { app, repository } = await registerAndLogin();
    const [user] = [...repository.users.values()];
    user!.status = "SUSPENDED";

    await login(app, CREDENTIALS);

    const failures = repository.auditLog.filter((e) => e.action === "auth.login.failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.actorUserId).toBe(user!.id);
    expect(failures[0]?.metadata?.emailHash).toBeTypeOf("string");
    expect(repository.auditLog.some((e) => e.action === "auth.login.success")).toBe(false);
    await app.close();
  });

  it("answers a SUSPENDED user identically whether the password is right or wrong", async () => {
    const { app, repository } = await registerAndLogin();
    const [user] = [...repository.users.values()];
    user!.status = "SUSPENDED";

    const rightPassword = await login(app, CREDENTIALS);
    const wrongPassword = await login(app, { ...CREDENTIALS, password: "wrong password entirely" });

    // Otherwise a suspended account would still work as an oracle for its password.
    const rightBody = rightPassword.json();
    const wrongBody = wrongPassword.json();
    expect(rightPassword.statusCode).toBe(401);
    expect(wrongPassword.statusCode).toBe(401);
    expect(rightBody.error.code).toBe("INVALID_CREDENTIALS");
    expect(wrongBody.error.code).toBe("INVALID_CREDENTIALS");
    expect(rightBody.error.message).toBe(wrongBody.error.message);
    expect(rightBody.error.details).toEqual(wrongBody.error.details);
    expect(Object.keys(rightBody.error).sort()).toEqual(Object.keys(wrongBody.error).sort());
    expect(rightPassword.headers["set-cookie"]).toBeUndefined();
    expect(wrongPassword.headers["set-cookie"]).toBeUndefined();
    expect(repository.sessions.size).toBe(0);
    await app.close();
  });

  it.each([
    {
      scenario: "a wrong password",
      options: {},
      status: 401,
      prepare: async () => {},
      credentials: { ...CREDENTIALS, password: "wrong password entirely" },
    },
    {
      scenario: "an unknown email",
      options: {},
      status: 401,
      prepare: async () => {},
      credentials: { email: "nobody@example.com", password: "whatever12345" },
    },
    {
      scenario: "a throttled account, even with the right password",
      options: { accountLoginAttemptLimit: 1 },
      status: 429,
      prepare: async (app: Awaited<ReturnType<typeof buildTestApp>>["app"]) => {
        await login(app, { ...CREDENTIALS, password: "wrong password entirely" });
      },
      credentials: CREDENTIALS,
    },
    {
      scenario: "an ADMIN blocked by the production MFA barrier",
      options: { isProduction: true },
      status: 403,
      prepare: async (
        _app: Awaited<ReturnType<typeof buildTestApp>>["app"],
        repository?: Awaited<ReturnType<typeof buildTestApp>>["repository"],
      ) => {
        const [user] = [...repository!.users.values()];
        user!.role = "ADMIN";
      },
      credentials: CREDENTIALS,
    },
  ])(
    "issues no cookie and creates no session for $scenario",
    async ({ options, status, prepare, credentials }) => {
      const { app, repository } = await registerAndLogin(options);
      await prepare(app, repository);

      const response = await login(app, credentials);

      expect(response.statusCode).toBe(status);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(repository.sessions.size).toBe(0);
      await app.close();
    },
  );

  it("audits a successful login with the acting user", async () => {
    const { app, repository } = await registerAndLogin();
    await login(app, CREDENTIALS);

    const [user] = [...repository.users.values()];
    const entry = repository.auditLog.find((e) => e.action === "auth.login.success");
    expect(entry?.actorUserId).toBe(user?.id);
    await app.close();
  });

  it("audits a failed login for an unknown email without an actor, using only its hash", async () => {
    const { app, repository } = await registerAndLogin();
    await login(app, { email: "nobody@example.com", password: "whatever12345" });

    const entry = repository.auditLog.find(
      (e) => e.action === "auth.login.failed" && e.actorUserId === null,
    );
    expect(entry).toBeDefined();
    expect(entry?.metadata?.emailHash).toBeTypeOf("string");
    expect(JSON.stringify(entry)).not.toContain("nobody@example.com");
    await app.close();
  });

  it("throttles an account after repeated failed attempts (ADR-002)", async () => {
    const { app } = await registerAndLogin({ accountLoginAttemptLimit: 2 });

    await login(app, { ...CREDENTIALS, password: "wrong 1" });
    await login(app, { ...CREDENTIALS, password: "wrong 2" });
    const throttled = await login(app, { ...CREDENTIALS, password: "wrong 3" });

    expect(throttled.statusCode).toBe(429);
    expect(throttled.json().error.code).toBe("RATE_LIMITED");
    expect(throttled.headers["retry-after"]).toBeDefined();
    await app.close();
  });

  it("blocks ADMIN and SUPER_ADMIN logins in production until MFA exists (ADR-002)", async () => {
    const { app, repository } = await registerAndLogin({ isProduction: true });
    const [user] = [...repository.users.values()];
    user!.role = "ADMIN";

    const response = await login(app, CREDENTIALS);

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
    expect(repository.sessions.size).toBe(0);
    await app.close();
  });

  it("does not block ADMIN logins outside production", async () => {
    const { app, repository } = await registerAndLogin({ isProduction: false });
    const [user] = [...repository.users.values()];
    user!.role = "ADMIN";

    const response = await login(app, CREDENTIALS);

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("rejects invalid input", async () => {
    const { app } = await registerAndLogin();
    const response = await login(app, { email: "not-an-email", password: "" });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
