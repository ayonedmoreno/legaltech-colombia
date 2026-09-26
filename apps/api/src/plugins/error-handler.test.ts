import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { HttpError } from "../common/http-error.js";
import { buildTestApp } from "../test-support/build-test-app.js";

/**
 * Uniform error responses (API_SPEC.md "Formato de error"; SECURITY_SPEC.md §5: errors must
 * not leak stack traces, SQL or internal details). Test-only routes are registered on the
 * test app before its first request; nothing here is part of the production route table.
 */
const INTERNAL_DETAIL = 'relation "users" failed: SELECT password_hash FROM users WHERE id = $1';

async function appWithTestRoutes(): Promise<FastifyInstance> {
  const { app } = await buildTestApp();
  app.get("/api/test/unhandled", async () => {
    const error = new Error(INTERNAL_DETAIL);
    error.stack = `Error: ${INTERNAL_DETAIL}\n    at query (/srv/app/node_modules/pg/lib/client.js:1:1)`;
    throw error;
  });
  app.get("/api/test/http-error", async () => {
    throw new HttpError(429, "RATE_LIMITED", "Demasiados intentos. Inténtalo más tarde.", {
      headers: { "Retry-After": "900" },
    });
  });
  return app;
}

describe("error handler: unhandled errors", () => {
  it("answers 500 INTERNAL_ERROR with the fixed message and leaks nothing internal", async () => {
    const app = await appWithTestRoutes();
    const response = await app.inject({ method: "GET", url: "/api/test/unhandled" });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Error interno.",
        details: [],
        requestId: expect.any(String),
      },
    });
    expect(body.error.requestId).not.toBe("");
    expect(response.headers["x-request-id"]).toBe(body.error.requestId);

    // Nothing from the original error reaches the client, in any field.
    for (const fragment of ["SELECT", "password_hash", "relation", "node_modules", "stack"]) {
      expect(response.body).not.toContain(fragment);
    }
    await app.close();
  });
});

describe("error handler: framework errors", () => {
  it("answers malformed JSON with 400 VALIDATION_ERROR without the parser's details", async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      payload: '{"email": "ana@example.com", "password": ',
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Solicitud inválida.",
        details: [],
        requestId: expect.any(String),
      },
    });
    expect(body.error.requestId).not.toBe("");
    expect(response.headers["x-request-id"]).toBe(body.error.requestId);
    for (const fragment of ["JSON", "Unexpected", "position", "FST_", "SyntaxError"]) {
      expect(response.body).not.toContain(fragment);
    }
    await app.close();
  });

  it("answers an unknown route with 404 NOT_FOUND and a server-generated request id", async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({ method: "POST", url: "/api/no-such-route" });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Recurso no encontrado.",
        details: [],
        requestId: expect.any(String),
      },
    });
    expect(body.error.requestId).not.toBe("");
    expect(response.headers["x-request-id"]).toBe(body.error.requestId);
    await app.close();
  });
});

describe("error handler: HttpError", () => {
  it("keeps the status, code, message and headers of an HttpError", async () => {
    const app = await appWithTestRoutes();
    const response = await app.inject({ method: "GET", url: "/api/test/http-error" });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("900");
    const body = response.json();
    expect(body).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Demasiados intentos. Inténtalo más tarde.",
        details: [],
        requestId: expect.any(String),
      },
    });
    expect(body.error.requestId).not.toBe("");
    expect(response.headers["x-request-id"]).toBe(body.error.requestId);
    await app.close();
  });
});
