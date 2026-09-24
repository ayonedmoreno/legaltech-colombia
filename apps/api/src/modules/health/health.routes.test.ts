import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { loadEnv } from "../../config/env.js";

const env = loadEnv({
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  APP_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "postgresql://unused",
});

async function appWith(databaseUp: boolean) {
  return buildApp({ env, health: { checkDatabase: async () => databaseUp } });
}

describe("health routes", () => {
  it("GET /api/health/live returns ok", async () => {
    const app = await appWith(true);
    const response = await app.inject({ method: "GET", url: "/api/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("GET /api/health/ready reflects database availability", async () => {
    const up = await appWith(true);
    expect((await up.inject({ method: "GET", url: "/api/health/ready" })).statusCode).toBe(200);
    await up.close();

    const down = await appWith(false);
    const response = await down.inject({ method: "GET", url: "/api/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unavailable" });
    await down.close();
  });
});

describe("base security configuration", () => {
  it("sends security headers", async () => {
    const app = await appWith(true);
    const response = await app.inject({ method: "GET", url: "/api/health/live" });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-powered-by"]).toBeUndefined();
    await app.close();
  });

  it("returns the error contract with a request id for unknown routes", async () => {
    const app = await appWith(true);
    const response = await app.inject({
      method: "GET",
      url: "/api/does-not-exist",
      headers: { "x-request-id": "req-abc-123" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers["x-request-id"]).toBe("req-abc-123");
    expect(response.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Recurso no encontrado.",
        details: [],
        requestId: "req-abc-123",
      },
    });
    await app.close();
  });

  it("replaces a malformed inbound request id", async () => {
    const app = await appWith(true);
    const response = await app.inject({
      method: "GET",
      url: "/api/health/live",
      headers: { "x-request-id": "bad id with spaces" },
    });
    expect(response.headers["x-request-id"]).not.toBe("bad id with spaces");
    await app.close();
  });
});
