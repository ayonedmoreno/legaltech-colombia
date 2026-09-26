import { describe, expect, it } from "vitest";
import type { Actor } from "../../common/policy.js";
import { can, type AuthAction } from "./auth.policy.js";

const ROLES = ["USER", "PROFESSIONAL", "ADMIN", "SUPER_ADMIN"] as const;
const SELF = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function actor(role: Actor["role"], status: Actor["status"] = "ACTIVE"): Actor {
  return { id: SELF, role, status };
}

describe("auth policy — Sprint 1 matrix (ADR-003)", () => {
  describe.each(ROLES)("%s", (role) => {
    it("may read its own user", () => {
      expect(can(actor(role), "user:read", { id: SELF })).toEqual({ allowed: true });
    });

    it("may not read another user (cross-access)", () => {
      expect(can(actor(role), "user:read", { id: OTHER })).toEqual({
        allowed: false,
        reason: "not_owner",
      });
    });

    it.each(["session:list", "session:revoke"] as const)("may %s its own sessions", (action) => {
      expect(can(actor(role), action, { userId: SELF })).toEqual({ allowed: true });
    });

    it.each(["session:list", "session:revoke"] as const)(
      "may not %s another user's sessions (cross-access)",
      (action) => {
        expect(can(actor(role), action, { userId: OTHER })).toEqual({
          allowed: false,
          reason: "not_owner",
        });
      },
    );
  });

  it("denies every action to a suspended actor, even on its own resources", () => {
    const suspended = actor("SUPER_ADMIN", "SUSPENDED");
    expect(can(suspended, "user:read", { id: SELF })).toEqual({
      allowed: false,
      reason: "inactive_actor",
    });
    expect(can(suspended, "session:revoke", { userId: SELF })).toEqual({
      allowed: false,
      reason: "inactive_actor",
    });
  });

  it("denies an action that is not in the matrix (deny by default)", () => {
    const unknown = "user:delete" as AuthAction;
    expect(can(actor("SUPER_ADMIN"), unknown, { id: SELF })).toEqual({
      allowed: false,
      reason: "unknown_action",
    });
  });
});
