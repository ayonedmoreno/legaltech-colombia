import { describe, expect, it } from "vitest";
import { AI_PACKAGE } from "./index.js";

describe("ai skeleton", () => {
  it("exposes its package name", () => {
    expect(AI_PACKAGE).toBe("@legaltech/ai");
  });
});
