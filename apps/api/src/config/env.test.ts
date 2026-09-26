import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const valid = {
  APP_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "postgresql://user:secret-value@localhost:5432/db",
};

describe("loadEnv", () => {
  it("applies defaults", () => {
    const env = loadEnv(valid);
    expect(env.API_PORT).toBe(4000);
    expect(env.API_HOST).toBe("127.0.0.1");
    expect(env.NODE_ENV).toBe("development");
  });

  it("coerces the port to a number", () => {
    expect(loadEnv({ ...valid, API_PORT: "5000" }).API_PORT).toBe(5000);
  });

  it.each(["http://localhost:3000", "https://example.com"])(
    "accepts the bare origin %s for APP_ORIGIN, unchanged",
    (origin) => {
      expect(loadEnv({ ...valid, APP_ORIGIN: origin }).APP_ORIGIN).toBe(origin);
    },
  );

  it.each([
    "http://localhost:3000/",
    "https://example.com/",
    "https://example.com/app",
    "https://example.com?x=1",
    "https://example.com#top",
  ])("rejects %s for APP_ORIGIN at startup instead of normalizing it", (origin) => {
    expect(() => loadEnv({ ...valid, APP_ORIGIN: origin })).toThrow(
      /APP_ORIGIN: must be a bare origin \(scheme:\/\/host\[:port\]\)/,
    );
  });

  it("trusts no proxy unless API_TRUST_PROXY is set", () => {
    expect(loadEnv(valid).API_TRUST_PROXY).toEqual([]);
    expect(loadEnv({ ...valid, API_TRUST_PROXY: "" }).API_TRUST_PROXY).toEqual([]);
  });

  it("parses API_TRUST_PROXY as a list of IPs and CIDR ranges", () => {
    expect(
      loadEnv({ ...valid, API_TRUST_PROXY: " 10.0.0.5 , 10.1.0.0/16,fd00::/8 " }).API_TRUST_PROXY,
    ).toEqual(["10.0.0.5", "10.1.0.0/16", "fd00::/8"]);
  });

  it.each(["true", "*", "loopback", "10.0.0.0/33", "10.0.0.0/abc", "10.0.0.0/8/1", "proxy.local"])(
    "rejects %s in API_TRUST_PROXY (only explicit addresses are trusted)",
    (value) => {
      expect(() => loadEnv({ ...valid, API_TRUST_PROXY: value })).toThrow(
        /API_TRUST_PROXY: must be a comma-separated list of IP addresses or CIDR ranges/,
      );
    },
  );

  it("fails on missing required variables without leaking values", () => {
    expect(() => loadEnv({ DATABASE_URL: valid.DATABASE_URL })).toThrow(/APP_ORIGIN/);
    try {
      loadEnv({ DATABASE_URL: valid.DATABASE_URL, APP_ORIGIN: "not-a-url" });
    } catch (error) {
      expect(String(error)).not.toContain("secret-value");
    }
  });
});
