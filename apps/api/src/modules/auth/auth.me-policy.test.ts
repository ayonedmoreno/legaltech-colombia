import { afterEach, describe, expect, it, vi } from "vitest";
import { cookieHeader, findSetCookie } from "../../test-support/cookies.js";
import { buildTestApp } from "../../test-support/build-test-app.js";
import { can } from "./auth.policy.js";
import type * as AuthPolicy from "./auth.policy.js";

// Wrap (not replace) the real policy, so a test can check it is consulted and force a denial.
vi.mock("./auth.policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof AuthPolicy>();
  return { ...actual, can: vi.fn(actual.can) };
});

const ORIGIN = "http://localhost:3000";
const CREDENTIALS = { email: "ana@example.com", password: "correct horse battery" };

async function loggedInApp() {
  const testApp = await buildTestApp();
  const json = { origin: ORIGIN, "content-type": "application/json" };
  await testApp.app.inject({
    method: "POST",
    url: "/api/auth/register",
    headers: json,
    payload: { ...CREDENTIALS, fullName: "Ana Gómez" },
  });
  const login = await testApp.app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: json,
    payload: CREDENTIALS,
  });
  const sessionRaw = findSetCookie(login.headers["set-cookie"], "__Host-session")!.value;
  return { ...testApp, cookie: cookieHeader({ "__Host-session": sessionRaw }) };
}

afterEach(() => {
  vi.mocked(can).mockClear();
});

describe("GET /api/auth/me is authorized by the auth policy (ADR-003)", () => {
  it("asks the policy for user:read on the actor's own user", async () => {
    const { app, cookie, repository } = await loggedInApp();
    const [user] = [...repository.users.values()];

    const response = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(vi.mocked(can)).toHaveBeenCalledWith(
      { id: user!.id, role: "USER", status: "ACTIVE" },
      "user:read",
      { id: user!.id },
    );
    await app.close();
  });

  it("answers 404 NOT_FOUND, not 403, when the policy denies the read", async () => {
    const { app, cookie } = await loggedInApp();
    vi.mocked(can).mockReturnValueOnce({ allowed: false, reason: "not_owner" });

    const response = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(response.body).not.toContain("ana@example.com");
    await app.close();
  });
});
