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

// D2-G: behind a listed proxy, anything that is not an IP address in X-Forwarded-For falls back to
// the TCP peer, for the per-IP limit and for the recorded IP alike, and never causes a 400.
describe("client IP fallback to the TCP peer (D2-G)", () => {
  const PEER = "127.0.0.1";

  function registerWith(app: App, email: string, headers: Record<string, string>) {
    return app.inject({
      method: "POST",
      url: "/api/auth/register",
      remoteAddress: PEER,
      headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
      payload: { email, password: "correct horse battery", fullName: "Ana Gómez" },
    });
  }

  it.each([
    ["an invalid X-Forwarded-For (not-an-ip)", { "x-forwarded-for": "not-an-ip" }],
    ["an invalid X-Forwarded-For (<script>)", { "x-forwarded-for": "<script>" }],
    ["an invalid X-Forwarded-For (999.1.1.1)", { "x-forwarded-for": "999.1.1.1" }],
    ["an empty X-Forwarded-For", { "x-forwarded-for": "" }],
    ["no X-Forwarded-For", {}],
    ["only X-Real-IP", { "x-real-ip": "8.8.8.8" }],
    ["only Forwarded", { forwarded: "for=9.9.9.9" }],
  ])("uses the TCP peer for %s, without a 400", async (_label, headers) => {
    const { app, repository } = await buildTestApp({ trustProxy: [PEER] });
    const response = await registerWith(app, "ana@example.com", headers);
    expect(response.statusCode).toBe(202);
    expect(recordedIp(repository)).toBe(PEER);
    await app.close();
  });

  it("keys the per-IP limit on the TCP peer for every invalid X-Forwarded-For", async () => {
    const { app } = await buildTestApp({ trustProxy: [PEER] });
    const invalid = ["not-an-ip", "<script>", "999.1.1.1", "", "a.b.c.d", "::zz"];
    const statuses: number[] = [];
    for (const [i, value] of invalid.entries()) {
      const response = await registerWith(app, `user${i}@example.com`, {
        "x-forwarded-for": value,
      });
      statuses.push(response.statusCode);
    }
    // One shared bucket (5 per window): the invalid values cannot open new buckets.
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
    await app.close();
  });
});
