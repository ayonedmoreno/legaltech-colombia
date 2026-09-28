import type { Case, CaseStatus } from "@legaltech/contracts";
import { describe, expect, it } from "vitest";
import { CASE_STATUS_LABELS, CASE_TYPES, isClosedStatus, splitByActivity } from "./case-labels";

function aCase(id: string, status: CaseStatus): Case {
  const at = "2026-09-27T12:00:00.000Z";
  return { id, type: "OTHER", status, createdAt: at, updatedAt: at };
}

describe("case labels and activity (Phase 2 decision D)", () => {
  it("offers exactly the 7 types of PROJECT_SPEC s.9, in order", () => {
    expect(CASE_TYPES).toEqual([
      "TRAFFIC_CITATION",
      "INFRACTION",
      "PHOTO_ENFORCEMENT",
      "TRANSPORT",
      "NOTIFICATION",
      "ADMINISTRATIVE_PROCEEDING",
      "OTHER",
    ]);
  });

  it("treats RESOLVED, CLOSED and CANCELLED as closed, and the other 12 states as active", () => {
    const statuses = Object.keys(CASE_STATUS_LABELS) as CaseStatus[];
    expect(statuses).toHaveLength(15);
    expect(statuses.filter(isClosedStatus)).toEqual(["RESOLVED", "CLOSED", "CANCELLED"]);
    expect(statuses.filter((s) => !isClosedStatus(s))).toHaveLength(12);
  });

  it("splits cases into active and closed, keeping their order", () => {
    const cases = [
      aCase("a", "DRAFT"),
      aCase("b", "CANCELLED"),
      aCase("c", "PAID"),
      aCase("d", "RESOLVED"),
    ];
    const { active, closed } = splitByActivity(cases);
    expect(active.map((c) => c.id)).toEqual(["a", "c"]);
    expect(closed.map((c) => c.id)).toEqual(["b", "d"]);
  });
});
