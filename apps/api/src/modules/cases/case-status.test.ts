import { readFileSync } from "node:fs";
import { caseStatusSchema, type CaseStatus } from "@legaltech/contracts";
import { describe, expect, it } from "vitest";
import {
  CASE_TRANSITIONS,
  INITIAL_CASE_STATUS,
  InvalidCaseTransitionError,
  assertTransition,
  canTransition,
  documentedTransitions,
  type CaseTransition,
  type TransitionActor,
} from "./case-status.js";

/**
 * Case state machine (DATABASE_SPEC.md, "Estados y transiciones del caso"): the documented
 * transitions T1-T10, none enabled in this slice, and nothing decided for V1-V8.
 */
const STATUSES = caseStatusSchema.options;
/** s.8 order: T1-T10 walk it one step at a time, from DRAFT to RESPONSE_RECEIVED. */
const CHAIN: CaseStatus[] = STATUSES.slice(0, STATUSES.indexOf("RESPONSE_RECEIVED") + 1);
/** Statuses whose meaning or entry the documents leave open (V1, V2, V7). */
const UNDECIDED: CaseStatus[] = ["FOLLOW_UP", "RESOLVED", "CLOSED", "CANCELLED"];

const pairs = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as const));

describe("case state machine: the documented matrix", () => {
  it("covers the 15 statuses of PROJECT_SPEC s.8, and every case starts in DRAFT", () => {
    expect(STATUSES).toHaveLength(15);
    expect(INITIAL_CASE_STATUS).toBe("DRAFT");
  });

  it("documents exactly T1-T10: the s.8/s.9 chain from DRAFT to RESPONSE_RECEIVED", () => {
    expect(CASE_TRANSITIONS.map((t) => t.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `T${i + 1}`),
    );
    expect(CASE_TRANSITIONS.map((t) => [t.from, t.to])).toEqual(
      CHAIN.slice(0, -1).map((from, i) => [from, CHAIN[i + 1]]),
    );
  });

  it("moves one step forward only: no skips, no going back, nothing into DRAFT", () => {
    for (const t of CASE_TRANSITIONS) {
      expect(STATUSES.indexOf(t.to) - STATUSES.indexOf(t.from)).toBe(1);
      expect(t.to).not.toBe(INITIAL_CASE_STATUS);
    }
  });

  it("decides nothing about FOLLOW_UP, RESOLVED, CLOSED or CANCELLED (V1, V2, V7)", () => {
    for (const t of CASE_TRANSITIONS) {
      expect(UNDECIDED).not.toContain(t.from);
      expect(UNDECIDED).not.toContain(t.to);
    }
  });

  it("marks T4 (PAYMENT_PENDING → PAID) as the only explicit one, by the system (webhook)", () => {
    const explicit = CASE_TRANSITIONS.filter((t) => t.basis === "explicit");
    expect(explicit).toEqual([
      expect.objectContaining({
        id: "T4",
        from: "PAYMENT_PENDING",
        to: "PAID",
        actor: "system",
        phase: "payments",
      }),
    ]);
    expect(explicit[0]!.trigger).toMatch(/webhook/i);
  });

  it("never gives a transition to the case's user (s.6: the user consults statuses)", () => {
    const actors = new Set<TransitionActor>(CASE_TRANSITIONS.map((t) => t.actor));
    expect([...actors].sort()).toEqual(["pending", "professional", "system"]);
  });

  it("has one documented way out at most per status, and none out of the undecided ones", () => {
    for (const status of STATUSES) {
      const out = documentedTransitions(status);
      const expected = CHAIN.indexOf(status) >= 0 && status !== "RESPONSE_RECEIVED" ? 1 : 0;
      expect(out, status).toHaveLength(expected);
    }
  });

  it("cannot be changed at runtime", () => {
    expect(Object.isFrozen(CASE_TRANSITIONS)).toBe(true);
    expect(CASE_TRANSITIONS.every((t) => Object.isFrozen(t))).toBe(true);
    expect(() => {
      (CASE_TRANSITIONS[0] as { enabled: boolean }).enabled = true;
    }).toThrow(TypeError);
  });
});

describe("case state machine: nothing is enabled in this slice", () => {
  it("has every documented transition disabled, T4 included", () => {
    expect(CASE_TRANSITIONS.filter((t) => t.enabled)).toEqual([]);
  });

  it.each(pairs)("does not allow %s → %s now", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(InvalidCaseTransitionError);
  });

  it("reports the rejected transition", () => {
    try {
      assertTransition("PAYMENT_PENDING", "PAID");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCaseTransitionError);
      expect(error).toMatchObject({ from: "PAYMENT_PENDING", to: "PAID" });
    }
  });
});

describe("case state machine: an enabled transition (how a later phase will use it)", () => {
  // Simulates a phase enabling one transition, without touching the real matrix.
  const enabled = (id: CaseTransition["id"]) =>
    CASE_TRANSITIONS.map((t) => (t.id === id ? { ...t, enabled: true } : t));

  it("allows exactly that pair and nothing else", () => {
    const matrix = enabled("T4");
    const allowed = pairs.filter(([from, to]) =>
      matrix.some((t) => t.from === from && t.to === to && t.enabled),
    );
    expect(allowed).toEqual([["PAYMENT_PENDING", "PAID"]]);
  });
});

describe("case state machine: matches DATABASE_SPEC.md", () => {
  const spec = readFileSync(
    new URL("../../../../../docs/DATABASE_SPEC.md", import.meta.url),
    "utf8",
  );
  const ACTORS: Record<string, TransitionActor> = {
    Sistema: "system",
    Pendiente: "pending",
    "PROFESSIONAL asignado": "professional",
  };
  const rows = [
    ...spec.matchAll(
      /^\|\s*(T\d+)\s*\|\s*`(\w+)` → `(\w+)`\s*\|\s*\*{0,2}([EI])\*{0,2}\s*\|[^|\n]*\|\s*([^|\n]*?)\s*\|/gm,
    ),
  ].map(([, id, from, to, basis, actor]) => ({
    id,
    from,
    to,
    basis: basis === "E" ? "explicit" : "inferred",
    actor: Object.entries(ACTORS).find(([label]) => actor!.startsWith(label))?.[1],
  }));

  it("has the same transitions, bases and actors as the documented table", () => {
    expect(rows).toEqual(
      CASE_TRANSITIONS.map((t) => ({
        id: t.id,
        from: t.from,
        to: t.to,
        basis: t.basis,
        actor: t.actor,
      })),
    );
  });
});
