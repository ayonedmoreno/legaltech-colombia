import { describe, expect, it, vi } from "vitest";
import {
  createCase,
  getDocumentDownloadUrl,
  getDocumentOcr,
  uploadDocument,
  forgotPassword,
  login,
  logout,
  register,
  resetPassword,
  rotateSession,
  verifyEmail,
} from "./api-client";

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

describe("verifyEmail", () => {
  it("posts the token in the body to /api/auth/email/verify, never in the URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    const result = await verifyEmail("the-token", fetchImpl);

    expect(result).toEqual({ ok: true, data: undefined });
    const [path, init] = fetchImpl.mock.calls[0]!;
    expect(path).toBe("/api/auth/email/verify");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(init.body)).toEqual({ token: "the-token" });
  });

  it("returns the API's message for an invalid or expired link", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        apiError(400, "INVALID_OR_EXPIRED_TOKEN", "El enlace no es válido o ha caducado."),
      );

    expect(await verifyEmail("used", fetchImpl)).toEqual({
      ok: false,
      status: 400,
      message: "El enlace no es válido o ha caducado.",
    });
  });
});

describe("forgotPassword", () => {
  it("posts the email to /api/auth/password/forgot and accepts the 202", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(202, { status: "accepted" }));

    expect(await forgotPassword("ana@example.com", fetchImpl)).toEqual({
      ok: true,
      data: undefined,
    });
    const [path, init] = fetchImpl.mock.calls[0]!;
    expect(path).toBe("/api/auth/password/forgot");
    expect(JSON.parse(init.body)).toEqual({ email: "ana@example.com" });
  });
});

describe("resetPassword", () => {
  it("posts the token and the new password in the body to /api/auth/password/reset", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    expect(await resetPassword("the-token", "a brand new passphrase", fetchImpl)).toEqual({
      ok: true,
      data: undefined,
    });
    const [path, init] = fetchImpl.mock.calls[0]!;
    expect(path).toBe("/api/auth/password/reset");
    expect(JSON.parse(init.body)).toEqual({
      token: "the-token",
      newPassword: "a brand new passphrase",
    });
  });
});

describe("rotateSession", () => {
  it("fetches the CSRF token, then posts it to /api/auth/session/rotate", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(200, { csrfToken: "csrf-1" }))
      .mockResolvedValueOnce(json(200, { rotated: true }));

    expect(await rotateSession(fetchImpl)).toEqual({ ok: true, data: { rotated: true } });
    const [path, init] = fetchImpl.mock.calls[1]!;
    expect(path).toBe("/api/auth/session/rotate");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(init.headers["x-csrf-token"]).toBe("csrf-1");
  });

  it("does not post without a session (the CSRF request fails)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(apiError(401, "UNAUTHENTICATED", "Se requiere autenticación."));

    const result = await rotateSession(fetchImpl);

    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("createCase", () => {
  const CASE = {
    id: "7b1f5c2e-0d4a-4a4e-9a38-3d5c1f0e2b11",
    type: "TRANSPORT",
    status: "DRAFT",
    createdAt: "2026-09-27T12:00:00.000Z",
    updatedAt: "2026-09-27T12:00:00.000Z",
  };

  it("fetches the CSRF token, then posts only the type with it", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(200, { csrfToken: "csrf-1" }))
      .mockResolvedValueOnce(json(201, { case: CASE }));

    expect(await createCase("TRANSPORT", fetchImpl)).toEqual({ ok: true, data: CASE });

    const [path, init] = fetchImpl.mock.calls[1]!;
    expect(path).toBe("/api/cases");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(init.headers["x-csrf-token"]).toBe("csrf-1");
    expect(JSON.parse(init.body)).toEqual({ type: "TRANSPORT" });
  });

  it("does not post without a CSRF token (no valid session)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(apiError(401, "UNAUTHENTICATED", "Se requiere autenticación."));

    expect(await createCase("OTHER", fetchImpl)).toEqual({
      ok: false,
      status: 401,
      message: "Se requiere autenticación.",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns the API's generic message when the creation is refused", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(200, { csrfToken: "csrf-1" }))
      .mockResolvedValueOnce(apiError(404, "NOT_FOUND", "Recurso no encontrado."));

    expect(await createCase("OTHER", fetchImpl)).toEqual({
      ok: false,
      status: 404,
      message: "Recurso no encontrado.",
    });
  });
});

describe("uploadDocument", () => {
  const DOC = {
    id: "8c2e0f1a-1b2c-4d3e-8f4a-5b6c7d8e9f00",
    fileName: "Resolución 1.pdf",
    fileType: "PDF",
    fileSize: 4,
    status: "UPLOADED",
    ocrStatus: "NOT_STARTED",
    createdAt: "2026-09-27T12:00:00.000Z",
  };
  const CASE_ID = "7b1f5c2e-0d4a-4a4e-9a38-3d5c1f0e2b11";

  it("posts the raw file with its encoded name in a header and the CSRF token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(200, { csrfToken: "csrf-1" }))
      .mockResolvedValueOnce(json(201, { document: DOC }));
    const content = new Blob(["%PDF"]);

    expect(await uploadDocument(CASE_ID, { content, name: "Resolución 1.pdf" }, fetchImpl)).toEqual(
      { ok: true, data: DOC },
    );

    const [path, init] = fetchImpl.mock.calls[1]!;
    expect(path).toBe(`/api/cases/${CASE_ID}/documents`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(content);
    expect(init.headers["content-type"]).toBe("application/octet-stream");
    expect(init.headers["x-file-name"]).toBe("Resoluci%C3%B3n%201.pdf");
    expect(init.headers["x-csrf-token"]).toBe("csrf-1");
  });

  it("does not upload without a CSRF token, and reports the API's message", async () => {
    const noSession = vi
      .fn()
      .mockResolvedValue(apiError(401, "UNAUTHENTICATED", "Se requiere autenticación."));
    expect(
      (await uploadDocument(CASE_ID, { content: new Blob(["x"]), name: "a.pdf" }, noSession)).ok,
    ).toBe(false);
    expect(noSession).toHaveBeenCalledTimes(1);

    const tooLarge = vi
      .fn()
      .mockResolvedValueOnce(json(200, { csrfToken: "csrf-1" }))
      .mockResolvedValueOnce(
        apiError(413, "PAYLOAD_TOO_LARGE", "La solicitud supera el tamaño máximo permitido."),
      );
    expect(
      await uploadDocument(CASE_ID, { content: new Blob(["x"]), name: "a.pdf" }, tooLarge),
    ).toEqual({
      ok: false,
      status: 413,
      message: "La solicitud supera el tamaño máximo permitido.",
    });
  });
});

describe("getDocumentDownloadUrl", () => {
  it("asks the API for a download URL", async () => {
    const answer = { url: "https://storage.test/x", expiresAt: "2026-09-27T12:01:00.000Z" };
    const fetchImpl = vi.fn().mockResolvedValue(json(200, answer));

    expect(await getDocumentDownloadUrl("c1", "d1", fetchImpl)).toEqual({ ok: true, data: answer });
    expect(fetchImpl.mock.calls[0]![0]).toBe("/api/cases/c1/documents/d1/download");
  });
});

describe("getDocumentOcr", () => {
  it("reads the OCR of one document through the API, with its ids encoded in the path", async () => {
    const answer = { ocrStatus: "COMPLETED", pages: [{ number: 1, text: "<b>texto</b>" }] };
    const fetchImpl = vi.fn().mockResolvedValue(json(200, answer));

    expect(await getDocumentOcr("c1", "d/1?x", fetchImpl)).toEqual({ ok: true, data: answer });
    expect(fetchImpl.mock.calls[0]![0]).toBe("/api/cases/c1/documents/d%2F1%3Fx/ocr");
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: "GET" });
  });

  it("returns the API's error for a document the user cannot see", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(apiError(404, "NOT_FOUND", "Recurso no encontrado."));
    expect(await getDocumentOcr("c1", "d1", fetchImpl)).toMatchObject({ ok: false, status: 404 });
  });
});
