import { describe, expect, it } from "vitest";
import type { Actor } from "../../common/policy.js";
import { can, type CaseAction } from "./cases.policy.js";

const SELF = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ACTIONS = ["case:create", "case:list", "case:read"] as const;

function actor(role: Actor["role"], status: Actor["status"] = "ACTIVE"): Actor {
  return { id: SELF, role, status };
}

describe("cases policy — first Case slice (ADR-003)", () => {
  it.each(ACTIONS)("lets a USER %s their own cases", (action) => {
    expect(can(actor("USER"), action, { userId: SELF })).toEqual({ allowed: true });
  });

  it.each(ACTIONS)("never lets a USER %s another user's cases (cross-access)", (action) => {
    expect(can(actor("USER"), action, { userId: OTHER })).toEqual({
      allowed: false,
      reason: "not_owner",
    });
  });

  describe.each(["PROFESSIONAL", "ADMIN", "SUPER_ADMIN"] as const)(
    "%s (out of this slice)",
    (role) => {
      it.each(ACTIONS)("may not %s any case, not even with its own id", (action) => {
        for (const userId of [SELF, OTHER]) {
          expect(can(actor(role), action, { userId })).toEqual({
            allowed: false,
            reason: "role_not_allowed",
          });
        }
      });
    },
  );

  it.each(ACTIONS)("denies a suspended user %s", (action) => {
    expect(can(actor("USER", "SUSPENDED"), action, { userId: SELF })).toEqual({
      allowed: false,
      reason: "inactive_actor",
    });
  });

  it("denies an unknown action (deny by default)", () => {
    expect(can(actor("USER"), "case:cancel" as CaseAction, { userId: SELF })).toEqual({
      allowed: false,
      reason: "unknown_action",
    });
  });
});
