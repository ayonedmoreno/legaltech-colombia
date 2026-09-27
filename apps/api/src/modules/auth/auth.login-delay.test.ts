import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../security/crypto.js";
import { buildTestApp } from "../../test-support/build-test-app.js";

/**
 * ADR-002 (D3-3): progressive per-account delay. With F failed logins in the last 24 h and
 * F >= 5, the next attempt must wait D = min(30 s · 2^(F − 5), 900 s) from the most recent
 * failure; before that it gets 429 with Retry-After = max(1, ceil(remaining seconds)). The
 * in-memory repository's clock stands in for PostgreSQL's (the real one is covered by the
 * PostgreSQL integration tests).
 */
const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct horse battery";
const SECOND = 1_000;

async function setup(email = "ana@example.com") {
  let now = new Date("2026-03-01T12:00:00.000Z");
  const testApp = await buildTestApp({ clock: () => now });
  let ip = 0;
  // Each request from its own IP, so the per-IP limit never interferes.
  const login = (password: string, as = email) =>
    testApp.app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: `198.51.100.${(ip++ % 250) + 1}`,
      headers: { origin: ORIGIN, "content-type": "application/json" },
      payload: { email: as, password },
    });
  await testApp.app.inject({
    method: "POST",
    url: "/api/auth/register",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password: PASSWORD, fullName: "Ana Gómez" },
  });
  return {
    ...testApp,
    login,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe("per-account progressive delay (ADR-002, D3-3)", () => {
  it("allows five failures, then doubles the wait from 30 s up to 900 s", async () => {
    const { app, login, advance } = await setup();
    for (let i = 0; i < 5; i++) expect((await login("wrong password")).statusCode).toBe(401);

    for (const delaySeconds of [30, 60, 120, 240, 480, 900, 900]) {
      const blocked = await login("wrong password");
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers["retry-after"]).toBe(String(delaySeconds));

      advance(delaySeconds * SECOND);
      expect((await login("wrong password")).statusCode).toBe(401); // F grows by one
    }
    await app.close();
  });

  it("answers the exact remaining wait, rounded up, and lets the attempt through at the boundary", async () => {
    const { app, login, advance } = await setup();
    for (let i = 0; i < 5; i++) await login("wrong password");

    advance(12_300);
    expect((await login("wrong password")).headers["retry-after"]).toBe("18"); // 17.7 s left
    advance(1_000);
    expect((await login("wrong password")).headers["retry-after"]).toBe("17"); // 16.7 s left
    advance(16_699);
    expect((await login("wrong password")).headers["retry-after"]).toBe("1"); // 0.001 s left
    advance(1); // exactly last failure + 30 s
    expect((await login("wrong password")).statusCode).toBe(401);
    await app.close();
  });

  it("caps the wait at 900 s however many failures there are", async () => {
    const { app, login, repository } = await setup();
    const emailHash = sha256Hex("ana@example.com");
    for (let i = 0; i < 1_000; i++) {
      await repository.writeAuditLog({
        actorUserId: null,
        actorRole: null,
        action: "auth.login.failed",
        metadata: { emailHash },
        requestId: `seed-${i}`,
        ip: null,
        userAgent: null,
      });
    }

    const blocked = await login(PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("900");
    await app.close();
  });

  it("counts failures for 24 h, and only for 24 h", async () => {
    const { app, login, advance } = await setup();
    for (let i = 0; i < 5; i++) await login("wrong password");

    advance(23 * 60 * 60 * SECOND); // the five failures still count: one more costs 60 s
    expect((await login("wrong password")).statusCode).toBe(401);
    expect((await login("wrong password")).headers["retry-after"]).toBe("60");

    advance(60 * 60 * SECOND + SECOND); // the first five are now older than 24 h: F = 1
    expect((await login("wrong password")).statusCode).toBe(401);
    expect((await login("wrong password")).statusCode).toBe(401);
    await app.close();
  });

  it("stops counting a failure exactly 24 h after it happened", async () => {
    const early = await setup();
    const exact = await setup();
    for (let i = 0; i < 5; i++) {
      await early.login("wrong password");
      await exact.login("wrong password");
    }

    early.advance(24 * 60 * 60 * SECOND - 1); // 1 ms short of 24 h: the five still count
    expect((await early.login("wrong password")).statusCode).toBe(401);
    expect((await early.login("wrong password")).headers["retry-after"]).toBe("60");

    exact.advance(24 * 60 * 60 * SECOND); // exactly 24 h: they no longer count, F = 1
    expect((await exact.login("wrong password")).statusCode).toBe(401);
    expect((await exact.login("wrong password")).statusCode).toBe(401);
    await early.app.close();
    await exact.app.close();
  });

  it("does not reset the count after a successful login", async () => {
    const { app, login, advance } = await setup();
    for (let i = 0; i < 5; i++) await login("wrong password");

    advance(30 * SECOND);
    expect((await login(PASSWORD)).statusCode).toBe(200);
    expect((await login("wrong password")).statusCode).toBe(401); // F = 6, not 1

    const blocked = await login(PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("60");
    await app.close();
  });

  it("applies the same delay and Retry-After to an unknown email", async () => {
    const known = await setup();
    const unknown = await setup();
    for (let i = 0; i < 5; i++) {
      await known.login("wrong password");
      await unknown.login("wrong password", "nobody@example.com");
    }
    known.advance(10 * SECOND);
    unknown.advance(10 * SECOND);

    const a = await known.login("wrong password");
    const b = await unknown.login("wrong password", "nobody@example.com");
    expect([a.statusCode, a.headers["retry-after"]]).toEqual([429, "20"]);
    expect([b.statusCode, b.headers["retry-after"]]).toEqual([
      a.statusCode,
      a.headers["retry-after"],
    ]);
    await known.app.close();
    await unknown.app.close();
  });
});
