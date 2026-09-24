import { describe, expect, it } from "vitest";
import { PRICING_ENGINE_PACKAGE } from "./index.js";

describe("pricing-engine skeleton", () => {
  it("exposes its package name", () => {
    expect(PRICING_ENGINE_PACKAGE).toBe("@legaltech/pricing-engine");
  });
});
