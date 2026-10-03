import type { Case, CaseStatus } from "@legaltech/contracts";
import { describe, expect, it } from "vitest";
import {
  CASE_STATUS_LABELS,
  CASE_TYPES,
  DOCUMENT_OCR_STATUS_LABELS,
  DOCUMENT_STATUS_LABELS,
  formatFileSize,
  isDownloadable,
  isClosedStatus,
  splitByActivity,
} from "./case-labels";

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

describe("file sizes", () => {
  it.each([
    [512, "512 B"],
    [2048, "2 KB"],
    [1536 * 1024, "1,5 MB"],
    [10 * 1024 * 1024, "10 MB"],
  ])("shows %i bytes as %s", (bytes, text) => {
    expect(formatFileSize(bytes)).toBe(text);
  });
});

describe("document security treatment in the UI", () => {
  it("offers a download only for CLEAN documents", () => {
    const statuses = Object.keys(DOCUMENT_STATUS_LABELS) as Array<
      keyof typeof DOCUMENT_STATUS_LABELS
    >;
    expect(statuses).toHaveLength(6);
    expect(statuses.filter(isDownloadable)).toEqual(["CLEAN"]);
  });

  it("labels every OCR state, telling the definitive exclusion from the reversible one", () => {
    expect(Object.keys(DOCUMENT_OCR_STATUS_LABELS).sort()).toEqual([
      "COMPLETED",
      "EXCLUDED",
      "FAILED",
      "NOT_APPLICABLE",
      "NOT_STARTED",
      "PENDING",
      "PROCESSING",
    ]);
    expect(DOCUMENT_OCR_STATUS_LABELS.EXCLUDED).not.toBe(DOCUMENT_OCR_STATUS_LABELS.NOT_APPLICABLE);
  });
});
