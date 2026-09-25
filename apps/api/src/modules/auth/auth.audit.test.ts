import { describe, expect, it } from "vitest";
import { cookieHeader, findSetCookie } from "../../test-support/cookies.js";
import { buildTestApp } from "../../test-support/build-test-app.js";

const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct horse battery";


describe("auth audit trail", () => {
  it("uses exactly the approved event names and never records secrets", async () => {
    const { app, repository } = await buildTestApp();
    const json = { origin: ORIGIN, "content-type": "application/json" };

    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: json,
      payload: { email: "ana@example.com", password: PASSWORD, fullName: "Ana" },
    });
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: json,
      payload: { email: "ana@example.com", password: "wrong password 1" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: json,
      payload: { email: "ana@example.com", password: PASSWORD },
    });
    const sessionRaw = findSetCookie(login.headers["set-cookie"], "__Host-session")!.value;
    const csrfRaw = findSetCookie(login.headers["set-cookie"], "__Host-csrf")!.value;
    await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        origin: ORIGIN,
        "x-csrf-token": csrfRaw,
        cookie: cookieHeader({ "__Host-session": sessionRaw, "__Host-csrf": csrfRaw }),
      },
    });

    const actions = new Set(repository.auditLog.map((e) => e.action));
    expect(actions).toEqual(
      new Set(["auth.register", "auth.login.failed", "auth.login.success", "auth.logout"]),
    );

    const serialized = JSON.stringify(repository.auditLog);
    const [user] = [...repository.users.values()];
    const [session] = [...repository.sessions.values()];
    for (const secret of [
      PASSWORD,
      "wrong password 1",
      sessionRaw,
      csrfRaw,
      user!.passwordHash,
      session!.tokenHash,
      session!.csrfTokenHash,
      "ana@example.com",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    await app.close();
  });
});
