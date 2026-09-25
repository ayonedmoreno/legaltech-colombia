import { describe, expect, it } from "vitest";
import { verifyPassword } from "../../security/password.js";
import { buildTestApp } from "../../test-support/build-test-app.js";

const ORIGIN = "http://localhost:3000";

async function register(app: Awaited<ReturnType<typeof buildTestApp>>["app"], body: unknown) {
  return app.inject({
    method: "POST",
    url: "/api/auth/register",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: body,
  });
}

describe("POST /api/auth/register", () => {
  it("registers a valid user and returns 202", async () => {
    const { app, repository } = await buildTestApp();
    const response = await register(app, {
      email: "Ana@Example.com",
      password: "correct horse battery",
      fullName: "Ana Gómez",
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "accepted" });
    expect(repository.users.size).toBe(1);
    await app.close();
  });

  it("normalizes the email (lowercase, trimmed)", async () => {
    const { app, repository } = await buildTestApp();
    await register(app, {
      email: "  Ana@Example.COM  ",
      password: "correct horse battery",
      fullName: "Ana Gómez",
    });

    const [user] = [...repository.users.values()];
    expect(user?.email).toBe("ana@example.com");
    await app.close();
  });

  it("stores the password as an Argon2id hash, never in plain text", async () => {
    const { app, repository } = await buildTestApp();
    const password = "correct horse battery";
    await register(app, { email: "ana@example.com", password, fullName: "Ana Gómez" });

    const [user] = [...repository.users.values()];
    expect(user?.passwordHash).not.toBe(password);
    expect(user?.passwordHash.startsWith("$argon2id$")).toBe(true);
    await expect(verifyPassword(user!.passwordHash, password)).resolves.toBe(true);
    await expect(verifyPassword(user!.passwordHash, "wrong password")).resolves.toBe(false);
    await app.close();
  });

  it("always assigns the USER role, regardless of what the client sends", async () => {
    const { app, repository } = await buildTestApp();
    await register(app, { email: "ana@example.com", password: "correct horse battery", fullName: "Ana" });

    const [user] = [...repository.users.values()];
    expect(user?.role).toBe("USER");
    await app.close();
  });

  it("rejects a client-supplied role field instead of silently ignoring it", async () => {
    const { app, repository } = await buildTestApp();
    const response = await register(app, {
      email: "ana@example.com",
      password: "correct horse battery",
      fullName: "Ana",
      role: "ADMIN",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    expect(repository.users.size).toBe(0);
    await app.close();
  });

  it("does not create a second account for a duplicate email, but responds identically", async () => {
    const { app, repository } = await buildTestApp();
    const payload = { email: "ana@example.com", password: "correct horse battery", fullName: "Ana" };

    const first = await register(app, payload);
    const second = await register(app, { ...payload, fullName: "Ana Otra" });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(first.json()).toEqual(second.json());
    expect(repository.users.size).toBe(1);
    expect(repository.auditLog.filter((e) => e.action === "auth.register")).toHaveLength(2);
    await app.close();
  });

  it("rejects invalid input (short password)", async () => {
    const { app } = await buildTestApp();
    const response = await register(app, { email: "ana@example.com", password: "short", fullName: "Ana" });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details.length).toBeGreaterThan(0);
    await app.close();
  });

  it("rejects a request from a different Origin", async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { origin: "http://evil.example", "content-type": "application/json" },
      payload: { email: "ana@example.com", password: "correct horse battery", fullName: "Ana" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("CSRF_INVALID");
    await app.close();
  });
});
