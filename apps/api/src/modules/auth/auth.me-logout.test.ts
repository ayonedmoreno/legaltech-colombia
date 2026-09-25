import { describe, expect, it } from "vitest";
import { cookieHeader, findSetCookie } from "../../test-support/cookies.js";
import { buildTestApp } from "../../test-support/build-test-app.js";

const ORIGIN = "http://localhost:3000";
const CREDENTIALS = { email: "ana@example.com", password: "correct horse battery" };


async function loggedInApp(overrides: Parameters<typeof buildTestApp>[0] = {}) {
  const testApp = await buildTestApp(overrides);
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

describe("GET /api/auth/me", () => {
  it("returns the authenticated user without any secret field", async () => {
    const { app, sessionRaw, csrfRaw } = await loggedInApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookieHeader({ "__Host-session": sessionRaw, "__Host-csrf": csrfRaw }) },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user).toEqual(
      expect.objectContaining({ email: CREDENTIALS.email, role: "USER", emailVerified: false }),
    );
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("passwordHash");
    expect(raw).not.toContain("tokenHash");
    expect(raw).not.toContain("csrfTokenHash");
    await app.close();
  });

  it("rejects a request with no session", async () => {
    const { app } = await loggedInApp();
    const response = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHENTICATED");
    await app.close();
  });

  it("rejects an expired session", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const { app, sessionRaw, csrfRaw } = await loggedInApp({ clock: () => now });

    now = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000); // past the 30-day absolute lifetime
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookieHeader({ "__Host-session": sessionRaw, "__Host-csrf": csrfRaw }) },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a suspended user even with an otherwise valid session", async () => {
    const { app, repository, sessionRaw, csrfRaw } = await loggedInApp();
    const [user] = [...repository.users.values()];
    user!.status = "SUSPENDED";

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookieHeader({ "__Host-session": sessionRaw, "__Host-csrf": csrfRaw }) },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe("POST /api/auth/logout", () => {
  it("revokes the session, clears both cookies and audits the event", async () => {
    const { app, repository, sessionRaw, csrfRaw } = await loggedInApp();

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
    const [session] = [...repository.sessions.values()];
    expect(session?.revokedAt).not.toBeNull();
    expect(session?.revokedReason).toBe("LOGOUT");

    const cleared = findSetCookie(response.headers["set-cookie"], "__Host-session");
    expect(cleared?.attributes.some((a) => /^Max-Age=0$/i.test(a) || /^Expires=/i.test(a))).toBe(true);
    expect(repository.auditLog.some((e) => e.action === "auth.logout")).toBe(true);

    // The now-revoked session must no longer authenticate.
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookieHeader({ "__Host-session": sessionRaw, "__Host-csrf": csrfRaw }) },
    });
    expect(me.statusCode).toBe(401);
    await app.close();
  });

  it("is safe to call again on an already-invalid session (no CSRF required)", async () => {
    const { app, sessionRaw, csrfRaw } = await loggedInApp();

    const first = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        origin: ORIGIN,
        "x-csrf-token": csrfRaw,
        cookie: cookieHeader({ "__Host-session": sessionRaw, "__Host-csrf": csrfRaw }),
      },
    });
    expect(first.statusCode).toBe(204);

    // Second call: same (now-revoked) cookie, no CSRF header at all — must still be safe.
    const second = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { origin: ORIGIN, cookie: cookieHeader({ "__Host-session": sessionRaw }) },
    });
    expect(second.statusCode).toBe(204);
    await app.close();
  });

  it("is safe to call with no session at all", async () => {
    const { app } = await loggedInApp();
    const response = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { origin: ORIGIN } });
    expect(response.statusCode).toBe(204);
    await app.close();
  });
});
