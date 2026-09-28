import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeCasesRepository } from "./cases.repository.fake.js";
import type { CaseRecord } from "./cases.types.js";

/**
 * The fake repository keeps the Prisma one's scope (ADR-003): the service checks ownership again,
 * so a fake that leaked another user's case would go unnoticed by the route tests alone.
 */
describe("FakeCasesRepository scope", () => {
  const audit = (userId: string) => (created: CaseRecord) => ({
    actorUserId: userId,
    actorRole: "USER" as const,
    action: "case.created",
    entityId: created.id,
    requestId: null,
    ip: null,
    userAgent: null,
  });

  it("finds and lists a case only for its owner, and sets case_id on the event itself", async () => {
    const repository = new FakeCasesRepository();
    const owner = randomUUID();
    const other = randomUUID();
    const created = await repository.createCase({
      userId: owner,
      type: "OTHER",
      audit: audit(owner),
    });

    expect((await repository.findOwnCase(created.id, owner))?.case.id).toBe(created.id);
    expect(await repository.findOwnCase(created.id, other)).toBeNull();
    expect(await repository.listOwnCases(other)).toEqual([]);
    expect(repository.auditLog[0]?.caseId).toBe(created.id);
  });
});
