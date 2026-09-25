import { beforeEach, describe, expect, it } from "vitest";
import { findSetCookie } from "../../test-support/cookies.js";
import { buildTestApp } from "../../test-support/build-test-app.js";
import { loginIpLimiter, registerIpLimiter } from "./auth.routes.js";

const ORIGIN = "http://localhost:3000";
const CREDENTIALS = { email: "ana@example.com", password: "correct horse battery" };

beforeEach(() => {
  loginIpLimiter.reset();
  registerIpLimiter.reset();
});

async function login(app: Awaited<ReturnType<typeof buildTestApp>>["app"], body: unknown) {
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

    expect(noSuchUser.statusCode).toBe(wrongPassword.statusCode);
    expect(noSuchUser.json()).toEqual(wrongPassword.json());
    await app.close();
  });

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
