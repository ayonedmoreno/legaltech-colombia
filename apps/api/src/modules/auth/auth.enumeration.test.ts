import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword, verifyPassword } from "../../security/password.js";
import { buildTestApp } from "../../test-support/build-test-app.js";

// Wrap (not replace) the real Argon2id functions so each test can count how much hashing
// work a request did: equal work on both paths is what keeps response times from revealing
// whether an email is registered.
vi.mock("../../security/password.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../security/password.js")>();
  return {
    ...actual,
    hashPassword: vi.fn(actual.hashPassword),
    verifyPassword: vi.fn(actual.verifyPassword),
  };
});

const ORIGIN = "http://localhost:3000";
const CREDENTIALS = { email: "ana@example.com", password: "correct horse battery" };

type App = Awaited<ReturnType<typeof buildTestApp>>["app"];

function post(app: App, url: string, payload: Record<string, string>) {
  return app.inject({
    method: "POST",
    url,
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload,
  });
}

afterEach(() => {
  vi.mocked(hashPassword).mockClear();
  vi.mocked(verifyPassword).mockClear();
});

describe("no user enumeration through Argon2id timing", () => {
  it("login runs one password verification for an unknown email, as for a wrong password", async () => {
    const { app } = await buildTestApp();
    await post(app, "/api/auth/register", { ...CREDENTIALS, fullName: "Ana Gómez" });

    vi.mocked(verifyPassword).mockClear();
    const wrongPassword = await post(app, "/api/auth/login", {
      email: CREDENTIALS.email,
      password: "wrong password here",
    });
    const wrongPasswordVerifications = vi.mocked(verifyPassword).mock.calls.length;

    vi.mocked(verifyPassword).mockClear();
    const unknownEmail = await post(app, "/api/auth/login", {
      email: "nobody@example.com",
      password: "wrong password here",
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPasswordVerifications).toBe(1);
    expect(vi.mocked(verifyPassword)).toHaveBeenCalledTimes(1);
    // The dummy hash is a real Argon2id hash with the production cost parameters.
    expect(vi.mocked(verifyPassword).mock.calls[0]![0]).toMatch(/^\$argon2id\$/);
    await app.close();
  });

  it("login for an unknown email never succeeds against the dummy hash", async () => {
    const { app } = await buildTestApp();
    const response = await post(app, "/api/auth/login", {
      email: "nobody@example.com",
      password: CREDENTIALS.password,
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
    await app.close();
  });

  it("register hashes the password for a duplicate email, as for a new account", async () => {
    const { app, repository } = await buildTestApp();

    const created = await post(app, "/api/auth/register", { ...CREDENTIALS, fullName: "Ana Gómez" });
    const newAccountHashes = vi.mocked(hashPassword).mock.calls.length;

    vi.mocked(hashPassword).mockClear();
    const duplicate = await post(app, "/api/auth/register", { ...CREDENTIALS, fullName: "Otra Persona" });

    expect(created.statusCode).toBe(202);
    expect(duplicate.statusCode).toBe(202);
    expect(newAccountHashes).toBe(1);
    expect(vi.mocked(hashPassword)).toHaveBeenCalledTimes(1);
    expect(repository.users.size).toBe(1);
    await app.close();
  });
});
