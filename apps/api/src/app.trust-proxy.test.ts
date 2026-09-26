import { describe, expect, it } from "vitest";
import { buildTestApp } from "./test-support/build-test-app.js";

const ORIGIN = "http://localhost:3000";

type App = Awaited<ReturnType<typeof buildTestApp>>["app"];

function register(app: App, email: string, remoteAddress: string, forwardedFor?: string) {
  return app.inject({
    method: "POST",
    url: "/api/auth/register",
    remoteAddress,
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
    },
    payload: { email, password: "correct horse battery", fullName: "Ana Gómez" },
  });
}

/** The IP the API attributed to the request, as recorded in the registration audit event. */
function recordedIp(repository: Awaited<ReturnType<typeof buildTestApp>>["repository"]) {
  return repository.auditLog.find((entry) => entry.action === "auth.register")?.ip;
}

describe("client IP and X-Forwarded-For (API_TRUST_PROXY)", () => {
  it("ignores X-Forwarded-For by default: the IP is always the TCP peer", async () => {
    const { app, repository } = await buildTestApp();
    await register(app, "ana@example.com", "127.0.0.1", "6.6.6.6");
    expect(recordedIp(repository)).toBe("127.0.0.1");
    await app.close();
  });

  it("does not let a client escape the per-IP limit with forged X-Forwarded-For by default", async () => {
    const { app } = await buildTestApp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const response = await register(app, `user${i}@example.com`, "127.0.0.1", `6.6.6.${i}`);
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
    await app.close();
  });

  it("uses the forwarded client IP when the request comes from a listed proxy", async () => {
    const { app, repository } = await buildTestApp({ trustProxy: ["127.0.0.1"] });
    await register(app, "ana@example.com", "127.0.0.1", "203.0.113.7");
    expect(recordedIp(repository)).toBe("203.0.113.7");
    await app.close();
  });

  it("ignores X-Forwarded-For from an address that is not listed", async () => {
    const { app, repository } = await buildTestApp({ trustProxy: ["127.0.0.1"] });
    await register(app, "ana@example.com", "10.0.0.9", "203.0.113.7");
    expect(recordedIp(repository)).toBe("10.0.0.9");
    await app.close();
  });

  it("only trusts the listed hops: a client-forged entry before them is not used", async () => {
    const { app, repository } = await buildTestApp({ trustProxy: ["127.0.0.1"] });
    // The client sent "6.6.6.6"; the trusted proxy appended the real peer, 203.0.113.7.
    await register(app, "ana@example.com", "127.0.0.1", "6.6.6.6, 203.0.113.7");
    expect(recordedIp(repository)).toBe("203.0.113.7");
    await app.close();
  });

  it("keys the per-IP limit on the forwarded client IP behind a listed proxy", async () => {
    const { app } = await buildTestApp({ trustProxy: ["127.0.0.1"] });
    for (let i = 0; i < 5; i++) {
      await register(app, `a${i}@example.com`, "127.0.0.1", "203.0.113.7");
    }
    const blocked = await register(app, "a5@example.com", "127.0.0.1", "203.0.113.7");
    const otherClient = await register(app, "b0@example.com", "127.0.0.1", "198.51.100.4");
    expect(blocked.statusCode).toBe(429);
    expect(otherClient.statusCode).toBe(202);
    await app.close();
  });
});
