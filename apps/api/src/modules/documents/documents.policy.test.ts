import { describe, expect, it } from "vitest";
import type { Actor } from "../../common/policy.js";
import { can, type DocumentAction } from "./documents.policy.js";

const SELF = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ACTIONS = ["document:upload", "document:list", "document:download"] as const;

const actor = (role: Actor["role"], status: Actor["status"] = "ACTIVE"): Actor => ({
  id: SELF,
  role,
  status,
});

describe("documents policy — first Documents slice (ADR-003)", () => {
  it.each(ACTIONS)("lets a USER %s documents of their own cases", (action) => {
    expect(can(actor("USER"), action, { caseOwnerId: SELF })).toEqual({ allowed: true });
  });

  it.each(ACTIONS)("never lets a USER %s documents of another user's case", (action) => {
    expect(can(actor("USER"), action, { caseOwnerId: OTHER })).toEqual({
      allowed: false,
      reason: "not_owner",
    });
  });

  it.each(["PROFESSIONAL", "ADMIN", "SUPER_ADMIN"] as const)("denies %s every action", (role) => {
    for (const action of ACTIONS) {
      expect(can(actor(role), action, { caseOwnerId: SELF })).toEqual({
        allowed: false,
        reason: "role_not_allowed",
      });
    }
  });

  it("denies a suspended user and an unknown action", () => {
    expect(can(actor("USER", "SUSPENDED"), "document:list", { caseOwnerId: SELF }).allowed).toBe(
      false,
    );
    expect(can(actor("USER"), "document:delete" as DocumentAction, { caseOwnerId: SELF })).toEqual({
      allowed: false,
      reason: "unknown_action",
    });
  });

  it("lets only an ADMIN reprocess a document, whoever owns it", () => {
    expect(can(actor("ADMIN"), "document:reprocess", { caseOwnerId: OTHER })).toEqual({
      allowed: true,
    });
    for (const role of ["USER", "PROFESSIONAL", "SUPER_ADMIN"] as const) {
      expect(can(actor(role), "document:reprocess", { caseOwnerId: SELF })).toEqual({
        allowed: false,
        reason: "role_not_allowed",
      });
    }
    expect(
      can(actor("ADMIN", "SUSPENDED"), "document:reprocess", { caseOwnerId: OTHER }).allowed,
    ).toBe(false);
  });

  it("lets only an ADMIN reprocess a document's OCR, whoever owns it (decision OCR-A12)", () => {
    expect(can(actor("ADMIN"), "document:reprocess_ocr", { caseOwnerId: OTHER })).toEqual({
      allowed: true,
    });
    // Not even the owner, nor a SUPER_ADMIN: an operational action, not a right over the text.
    for (const role of ["USER", "PROFESSIONAL", "SUPER_ADMIN"] as const) {
      expect(can(actor(role), "document:reprocess_ocr", { caseOwnerId: SELF })).toEqual({
        allowed: false,
        reason: "role_not_allowed",
      });
    }
    expect(
      can(actor("ADMIN", "SUSPENDED"), "document:reprocess_ocr", { caseOwnerId: OTHER }).allowed,
    ).toBe(false);
  });

  it("gives an ADMIN no access to documents themselves (OCR reprocessing included)", () => {
    for (const action of ACTIONS) {
      expect(can(actor("ADMIN"), action, { caseOwnerId: OTHER }).allowed).toBe(false);
    }
  });
});
