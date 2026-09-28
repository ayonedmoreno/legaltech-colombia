import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

describe("prisma schema scope (identity slice and first Case slice)", () => {
  it("defines only the approved models", () => {
    const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
    expect(models.sort()).toEqual(
      [
        "AuditLog",
        "Case",
        "CaseStatusHistory",
        "EmailOutbox",
        "EmailVerificationToken",
        "PasswordResetToken",
        "Session",
        "User",
      ].sort(),
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

  it("keeps no token column in the email outbox: it stores the intent only (ADR-002)", () => {
    const body = /model EmailOutbox {([^}]*)}/.exec(schema)?.[1] ?? "";
    expect(body).not.toMatch(/token/i);
  });

  const enumValues = (name: string) =>
    (new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(schema)?.[1] ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("@@") && !l.startsWith("//"));

  it("defines exactly the 7 case types of PROJECT_SPEC s.9", () => {
    expect(enumValues("CaseType")).toEqual([
      "TRAFFIC_CITATION",
      "INFRACTION",
      "PHOTO_ENFORCEMENT",
      "TRANSPORT",
      "NOTIFICATION",
      "ADMINISTRATIVE_PROCEEDING",
      "OTHER",
    ]);
  });

  it("defines exactly the 15 case states of PROJECT_SPEC s.8, in order", () => {
    expect(enumValues("CaseStatus")).toEqual([
      "DRAFT",
      "DOCUMENTS_PENDING",
      "PRELIMINARY_ANALYSIS",
      "PAYMENT_PENDING",
      "PAID",
      "LEGAL_REVIEW",
      "DOCUMENT_PREPARATION",
      "READY_TO_FILE",
      "FILED",
      "WAITING_RESPONSE",
      "RESPONSE_RECEIVED",
      "FOLLOW_UP",
      "RESOLVED",
      "CLOSED",
      "CANCELLED",
    ]);
  });

  it("keeps the first Case slice free of later-phase data (no Infraction, Authority, documents)", () => {
    const body = /model Case {([^}]*)}/.exec(schema)?.[1] ?? "";
    expect(body).not.toMatch(/infraction|authority|document|payment|assign/i);
  });

  it("does not reference pgvector", () => {
    expect(schema.toLowerCase()).not.toContain("vector");
  });
});
