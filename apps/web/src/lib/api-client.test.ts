import { describe, expect, it, vi } from "vitest";
import { login, logout, register } from "./api-client";

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "ana@example.com",
  fullName: "Ana Gómez",
  role: "USER",
  emailVerified: false,
  createdAt: "2026-09-25T00:00:00.000Z",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function apiError(status: number, code: string, message: string) {
  return json(status, { error: { code, message, details: [], requestId: "req-1" } });
}

describe("login", () => {
  it("posts the credentials same-origin to /api/auth/login and returns the user", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { user: USER }));

    const result = await login({ email: "ana@example.com", password: "secret" }, fetchImpl);

    expect(result).toEqual({ ok: true, data: USER });
    const [path, init] = fetchImpl.mock.calls[0]!;
    expect(path).toBe("/api/auth/login");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(JSON.parse(init.body)).toEqual({ email: "ana@example.com", password: "secret" });
  });

  it("returns the API's generic message on failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(apiError(401, "INVALID_CREDENTIALS", "Credenciales inválidas."));

    expect(await login({ email: "a@b.co", password: "x" }, fetchImpl)).toEqual({
      ok: false,
      status: 401,
      message: "Credenciales inválidas.",
    });
  });

  it("falls back to a generic message on a network error or a non-JSON body", async () => {
    const offline = vi.fn().mockRejectedValue(new TypeError("network"));
    const html = vi.fn().mockResolvedValue(new Response("<html>", { status: 502 }));

    for (const fetchImpl of [offline, html]) {
      const result = await login({ email: "a@b.co", password: "x" }, fetchImpl);
      expect(result.ok).toBe(false);
      expect(result.ok ? null : result.message).toBe(
        "No se pudo completar la solicitud. Inténtalo de nuevo.",
      );
    }
  });
});

describe("register", () => {
  it("treats 202 as accepted without claiming whether the account is new", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(202, { status: "accepted" }));

    const result = await register(
      { email: "ana@example.com", password: "correct horse battery", fullName: "Ana" },
      fetchImpl,
    );

    expect(result).toEqual({ ok: true, data: undefined });
    expect(fetchImpl.mock.calls[0]![0]).toBe("/api/auth/register");
  });
});

describe("logout", () => {
  it("sends the session's CSRF token in X-CSRF-Token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(200, { csrfToken: "csrf-123" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    expect(await logout(fetchImpl)).toEqual({ ok: true, data: undefined });

    expect(fetchImpl.mock.calls[0]![0]).toBe("/api/auth/csrf");
    const [path, init] = fetchImpl.mock.calls[1]!;
    expect(path).toBe("/api/auth/logout");
    expect(init.method).toBe("POST");
    expect(init.headers["x-csrf-token"]).toBe("csrf-123");
  });

  it("reports a failure when the API rejects the logout, so the UI does not pretend it worked", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(apiError(403, "CSRF_INVALID", "Token CSRF inválido o ausente."));

    expect(await logout(fetchImpl)).toEqual({
      ok: false,
      status: 403,
      message: "Token CSRF inválido o ausente.",
    });
  });

  it("still calls logout, without a token, when there is no valid session", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(apiError(401, "UNAUTHENTICATED", "Se requiere autenticación."))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    expect(await logout(fetchImpl)).toEqual({ ok: true, data: undefined });
    expect(fetchImpl.mock.calls[1]![1].headers["x-csrf-token"]).toBeUndefined();
  });
});
