import { beforeEach, describe, expect, it } from "vitest";
import { cookieHeader, findSetCookie } from "../../test-support/cookies.js";
import { buildTestApp } from "../../test-support/build-test-app.js";
import { loginIpLimiter, registerIpLimiter } from "./auth.routes.js";

const ORIGIN = "http://localhost:3000";
const CREDENTIALS = { email: "ana@example.com", password: "correct horse battery" };

beforeEach(() => {
  loginIpLimiter.reset();
  registerIpLimiter.reset();
});

async function loggedInApp() {
  const testApp = await buildTestApp();
  const { app } = testApp;
  await app.inject({
    method: "POST",
    url: "/api/auth/register",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { ...CREDENTIALS, fullName: "Ana Gómez" },
  });
  const loginResponse = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: CREDENTIALS,
  });
  const sessionRaw = findSetCookie(loginResponse.headers["set-cookie"], "__Host-session")!.value;
  const csrfRaw = findSetCookie(loginResponse.headers["set-cookie"], "__Host-csrf")!.value;
  return { ...testApp, sessionRaw, csrfRaw };
}

describe("GET /api/auth/csrf", () => {
  it("returns the current csrf token for a valid session", async () => {
    const { app, sessionRaw, csrfRaw } = await loggedInApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/csrf",
      headers: { cookie: cookieHeader({ "__Host-session": sessionRaw, "__Host-csrf": csrfRaw }) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ csrfToken: csrfRaw });
    await app.close();
  });

  it("issues a fresh token when the csrf cookie is missing or does not match the session", async () => {
    const { app, sessionRaw } = await loggedInApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/csrf",
      headers: { cookie: cookieHeader({ "__Host-session": sessionRaw, "__Host-csrf": "stale-value" }) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().csrfToken).not.toBe("stale-value");
    await app.close();
  });

  it("rejects a request with no session", async () => {
    const { app } = await loggedInApp();
    const response = await app.inject({ method: "GET", url: "/api/auth/csrf" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe("CSRF enforcement on mutating requests (logout)", () => {
  it("accepts the correct Origin and X-CSRF-Token header", async () => {
    const { app, sessionRaw, csrfRaw } = await loggedInApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        origin: ORIGIN,
        "x-csrf-token": csrfRaw,
        cookie: cookieHeader({ "__Host-session": sessionRaw, "__Host-csrf": csrfRaw }),
      },
    });
    expect(response.statusCode).toBe(204);
    await app.close();
  });

  it("rejects a missing X-CSRF-Token header", async () => {
    const { app, sessionRaw, csrfRaw } = await loggedInApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { origin: ORIGIN, cookie: cookieHeader({ "__Host-session": sessionRaw, "__Host-csrf": csrfRaw }) },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("CSRF_INVALID");
    await app.close();
  });

  it("rejects an incorrect X-CSRF-Token header", async () => {
    const { app, sessionRaw, csrfRaw } = await loggedInApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        origin: ORIGIN,
        "x-csrf-token": "not-the-right-token",
        cookie: cookieHeader({ "__Host-session": sessionRaw, "__Host-csrf": csrfRaw }),
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("CSRF_INVALID");
    await app.close();
  });

  it("rejects a mismatched Origin even with a correct CSRF token", async () => {
    const { app, sessionRaw, csrfRaw } = await loggedInApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        origin: "http://evil.example",
        "x-csrf-token": csrfRaw,
        cookie: cookieHeader({ "__Host-session": sessionRaw, "__Host-csrf": csrfRaw }),
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("CSRF_INVALID");
    await app.close();
  });
});
