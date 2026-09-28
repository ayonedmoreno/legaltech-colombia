import { randomUUID } from "node:crypto";
import type { AuditLogEntry } from "../auth/auth.types.js";
import type {
  CaseRecord,
  CasesRepository,
  CaseStatusChangeRecord,
  CaseWithHistory,
  CreateCaseInput,
} from "./cases.types.js";

type StoredStatusChange = CaseStatusChangeRecord & { caseId: string };

/**
 * In-memory CasesRepository for tests. Mirrors the Prisma transaction: the audit event is
 * recorded first, and the case and its history are stored only if that succeeded, so a failure
 * leaves nothing behind. Not a substitute for the PostgreSQL integration tests.
 */
export class FakeCasesRepository implements CasesRepository {
  readonly cases = new Map<string, CaseRecord>();
  readonly statusHistory: StoredStatusChange[] = [];
  readonly auditLog: AuditLogEntry[] = [];
  /** Test hook: stands in for PostgreSQL's clock. */
  clock: () => Date = () => new Date();

  async createCase(input: CreateCaseInput): Promise<CaseRecord> {
    const now = this.clock();
    const created: CaseRecord = {
      id: randomUUID(),
      userId: input.userId,
      type: input.type,
      status: "DRAFT",
      createdAt: now,
      updatedAt: now,
    };
    this.recordAudit({ ...input.audit(created), caseId: created.id });
    this.cases.set(created.id, created);
    this.statusHistory.push({
      caseId: created.id,
      fromStatus: null,
      toStatus: "DRAFT",
      changedByUserId: input.userId,
      changedAt: now,
    });
    return { ...created };
  }

  async listOwnCases(userId: string): Promise<CaseRecord[]> {
    return [...this.cases.values()]
      .filter((record) => record.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .map((record) => ({ ...record }));
  }

  async findOwnCase(caseId: string, userId: string): Promise<CaseWithHistory | null> {
    const record = this.cases.get(caseId);
    if (!record || record.userId !== userId) return null;
    return {
      case: { ...record },
      statusHistory: this.statusHistory
        .filter((change) => change.caseId === caseId)
        .map((change) => ({
          fromStatus: change.fromStatus,
          toStatus: change.toStatus,
          changedByUserId: change.changedByUserId,
          changedAt: change.changedAt,
        })),
    };
  }

  /** Where every audit event is recorded; tests override it to make the audit write fail. */
  protected recordAudit(entry: AuditLogEntry): void {
    this.auditLog.push(entry);
  }
}
