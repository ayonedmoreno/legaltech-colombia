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

  const OCR = {
    OCR_ENABLED: "true",
    OCR_IMAGE_REPRESENTATION: "SANITIZED",
    OCR_MAX_ATTEMPTS: "3",
    OCR_LEASE_SECONDS: "900",
    OCR_RETRY_DELAY_SECONDS: "30",
    OCR_MAX_PAGES: "50",
  };

  it("keeps the OCR off, and PDF OCR off, by default", () => {
    expect(loadWorkerEnv(BASE)).toMatchObject({
      OCR_ENABLED: false,
      OCR_PDF_ENABLED: false,
      OCR_PDF_P7_RESOLVED: false,
    });
  });

  it("requires every value from the provider evaluation once the OCR is on, with no defaults", () => {
    expect(loadWorkerEnv({ ...BASE, ...OCR })).toMatchObject({
      OCR_ENABLED: true,
      OCR_IMAGE_REPRESENTATION: "SANITIZED",
      OCR_MAX_ATTEMPTS: 3,
      OCR_LEASE_SECONDS: 900,
      OCR_RETRY_DELAY_SECONDS: 30,
      OCR_MAX_PAGES: 50,
    });
    for (const name of [
      "OCR_IMAGE_REPRESENTATION",
      "OCR_MAX_ATTEMPTS",
      "OCR_LEASE_SECONDS",
      "OCR_RETRY_DELAY_SECONDS",
      "OCR_MAX_PAGES",
    ] as const) {
      const env: Record<string, string> = { ...BASE, ...OCR };
      delete env[name];
      expect(() => loadWorkerEnv(env)).toThrow(new RegExp(`${name}: required when OCR_ENABLED`));
    }
  });

  it("rejects invalid OCR values without echoing them", () => {
    for (const [name, value] of [
      ["OCR_ENABLED", "yes-secret"],
      ["OCR_PDF_ENABLED", "1-secret"],
      ["OCR_IMAGE_REPRESENTATION", "RASTER-secret"],
    ]) {
      expect(() => loadWorkerEnv({ ...BASE, ...OCR, [name!]: value })).toThrow(
        new RegExp(`^(?!.*secret).*${name}`),
      );
    }
  });
});
