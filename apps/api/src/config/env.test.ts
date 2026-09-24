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

  it("fails on missing required variables without leaking values", () => {
    expect(() => loadEnv({ DATABASE_URL: valid.DATABASE_URL })).toThrow(/APP_ORIGIN/);
    try {
      loadEnv({ DATABASE_URL: valid.DATABASE_URL, APP_ORIGIN: "not-a-url" });
    } catch (error) {
      expect(String(error)).not.toContain("secret-value");
    }
  });
});
