import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeCasesRepository } from "../cases/cases.repository.fake.js";
import { FakeDocumentsRepository } from "./documents.repository.fake.js";
import type { DocumentRecord } from "./documents.types.js";

/**
 * The fake keeps the Prisma repository's scope (ADR-003): a document is only found through its own
 * case and that case's owner. The service checks ownership first too, so a fake that leaked would
 * go unnoticed by the route tests alone.
 */
describe("FakeDocumentsRepository scope", () => {
  async function setUp() {
    const cases = new FakeCasesRepository();
    const repository = new FakeDocumentsRepository(cases);
    const owner = randomUUID();
    const audit = (created: { id: string }) => ({
      actorUserId: owner,
      actorRole: "USER" as const,
      action: "case.created",
      entityId: created.id,
      requestId: null,
      ip: null,
      userAgent: null,
    });
    const own = await cases.createCase({ userId: owner, type: "OTHER", audit });
    const other = await cases.createCase({ userId: owner, type: "OTHER", audit });
    const id = randomUUID();
    const document = (await repository.createDocument({
      id,
      caseId: own.id,
      userId: owner,
      fileName: "a.pdf",
      fileType: "PDF",
      storageKey: `cases/${own.id}/documents/${id}`,
      fileSize: 10,
      audit: (record: DocumentRecord) => ({ ...audit(record), action: "document.uploaded" }),
    }))!;
    return { repository, owner, own, other, document };
  }

  it("finds a document only through its own case and that case's owner", async () => {
    const { repository, owner, own, other, document } = await setUp();

    expect((await repository.findOwnDocument(document.id, own.id, owner))?.id).toBe(document.id);
    expect(await repository.findOwnDocument(document.id, own.id, randomUUID())).toBeNull();
    expect(await repository.findOwnDocument(document.id, other.id, owner)).toBeNull();
  });

  it("lists a case's documents only for its owner", async () => {
    const { repository, owner, own } = await setUp();

    expect(await repository.listOwnCaseDocuments(own.id, owner)).toHaveLength(1);
    expect(await repository.listOwnCaseDocuments(own.id, randomUUID())).toEqual([]);
  });
});
