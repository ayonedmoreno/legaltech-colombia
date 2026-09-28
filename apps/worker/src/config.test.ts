import { describe, expect, it } from "vitest";
import { loadWorkerEnv } from "./config.js";

const BASE = { NODE_ENV: "test", WORKER_DATABASE_URL: "postgresql://worker@localhost/legaltech" };

describe("loadWorkerEnv", () => {
  it("uses the approved treatment parameters by default", () => {
    expect(loadWorkerEnv(BASE)).toMatchObject({
      CLAMAV_TIMEOUT_MS: 60_000,
      SCAN_MAX_ATTEMPTS: 5,
      SCAN_LEASE_SECONDS: 600,
      SCAN_SWEEP_INTERVAL_SECONDS: 60,
    });
  });

  it("accepts a configured sweep interval within its bounds, and nothing else", () => {
    expect(
      loadWorkerEnv({ ...BASE, SCAN_SWEEP_INTERVAL_SECONDS: "120" }).SCAN_SWEEP_INTERVAL_SECONDS,
    ).toBe(120);
    for (const value of ["5", "7200", "1.5", "x"]) {
      expect(() => loadWorkerEnv({ ...BASE, SCAN_SWEEP_INTERVAL_SECONDS: value })).toThrow(
        /SCAN_SWEEP_INTERVAL_SECONDS/,
      );
    }
  });

  it("never echoes configuration values in its errors", () => {
    expect(() => loadWorkerEnv({ NODE_ENV: "test", SCAN_LEASE_SECONDS: "secret-9" })).toThrow(
      /^(?!.*secret-9).*WORKER_DATABASE_URL/,
    );
  });
});
