import type { InjectOptions } from "fastify";
import { describe, expect, it } from "vitest";
import { buildTestApp } from "../../test-support/build-test-app.js";

const ORIGIN = "http://localhost:3000";

type App = Awaited<ReturnType<typeof buildTestApp>>["app"];

function post(app: App, url: string, payload: InjectOptions["payload"]) {
  return app.inject({
    method: "POST",
    url,
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload,
  });
}

describe("per-IP rate limiting", () => {
  it("limits login requests from one IP (10 per window), with Retry-After", async () => {
    const { app } = await buildTestApp();

    // Distinct emails, so the per-account throttle is not what stops the requests.
    for (let i = 0; i < 10; i++) {
      const ok = await post(app, "/api/auth/login", {
        email: `user${i}@example.com`,
        password: "whatever12345",
      });
      expect(ok.statusCode).toBe(401);
    }

    const blocked = await post(app, "/api/auth/login", {
      email: "user10@example.com",
      password: "whatever12345",
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("RATE_LIMITED");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    await app.close();
  });

  it("limits registration requests from one IP (5 per window)", async () => {
    const { app, repository } = await buildTestApp();

    for (let i = 0; i < 5; i++) {
      const ok = await post(app, "/api/auth/register", {
        email: `user${i}@example.com`,
        password: "correct horse battery",
        fullName: "Test User",
      });
      expect(ok.statusCode).toBe(202);
    }

    const blocked = await post(app, "/api/auth/register", {
      email: "user5@example.com",
      password: "correct horse battery",
      fullName: "Test User",
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("RATE_LIMITED");
    expect(repository.users.size).toBe(5);
    await app.close();
  });
});

describe("per-account throttling", () => {
  it("expires: failures outside the window no longer count", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const { app } = await buildTestApp({
      clock: () => now,
      accountLoginAttemptLimit: 2,
      accountLoginWindowMs: 60_000,
    });
    const attempt = () =>
      post(app, "/api/auth/login", { email: "ana@example.com", password: "wrong password 1" });

    await attempt();
    await attempt();
    expect((await attempt()).statusCode).toBe(429);

    // Each test's app has its own rate limiters (created inside the `authRoutes` plugin,
    // per buildApp/buildTestApp call), so the per-IP login limiter here is untouched by any
    // other test in this file — only the per-account throttle above was blocking further
    // attempts, and advancing the clock past its window is enough to lift it.
    now = new Date(now.getTime() + 61_000);
    expect((await attempt()).statusCode).toBe(401);
    await app.close();
  });
});
