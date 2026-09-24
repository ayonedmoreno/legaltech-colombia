import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

describe("prisma schema scope (Sprint 1 identity slice)", () => {
  it("defines only the approved identity models", () => {
    const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
    expect(models.sort()).toEqual(
      ["AuditLog", "EmailVerificationToken", "PasswordResetToken", "Session", "User"].sort(),
    );
  });

  it("defines the four MVP roles", () => {
    const body = /enum Role \{([^}]*)\}/.exec(schema)?.[1] ?? "";
    const values = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("@@"));
    expect(values).toEqual(["USER", "PROFESSIONAL", "ADMIN", "SUPER_ADMIN"]);
  });

  it("does not reference pgvector", () => {
    expect(schema.toLowerCase()).not.toContain("vector");
  });
});
