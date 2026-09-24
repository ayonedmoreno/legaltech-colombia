import { describe, expect, it } from "vitest";
import { LEGAL_ENGINE_PACKAGE } from "./index.js";

describe("legal-engine skeleton", () => {
  it("exposes its package name", () => {
    expect(LEGAL_ENGINE_PACKAGE).toBe("@legaltech/legal-engine");
  });
});
