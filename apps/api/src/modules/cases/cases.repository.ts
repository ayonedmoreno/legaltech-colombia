import type { PrismaClient } from "@legaltech/database";
import { auditLogData } from "../auth/auth.repository.js";
import type {
  CaseRecord,
  CasesRepository,
  CaseWithHistory,
  CreateCaseInput,
} from "./cases.types.js";

/** Prisma-backed implementation of CasesRepository. */
export class PrismaCasesRepository implements CasesRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createCase(input: CreateCaseInput): Promise<CaseRecord> {
    return this.prisma.$transaction(async (tx) => {
      // PostgreSQL is the source of time (as in the auth flows): one instant, read once, dates
      // the case, its first history entry and its event. Prisma's @default(now()) would be
      // filled in by the client, separately for each row.
      const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      const now = row!.now;
      // One transaction: the case, its first history entry and its event are all kept, or none.
      const created = await tx.case.create({
        data: {
          userId: input.userId,
          type: input.type,
          status: "DRAFT",
          createdAt: now,
          updatedAt: now,
        },
      });
      await tx.caseStatusHistory.create({
        data: {
          caseId: created.id,
          fromStatus: null,
          toStatus: "DRAFT",
          changedByUserId: input.userId,
          changedAt: now,
        },
      });
      await tx.auditLog.create({
        data: { ...auditLogData(input.audit(created)), caseId: created.id, occurredAt: now },
      });
      return created;
    });
  }

  async listOwnCases(userId: string): Promise<CaseRecord[]> {
    return this.prisma.case.findMany({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  }

  async findOwnCase(caseId: string, userId: string): Promise<CaseWithHistory | null> {
    // Scoped to the owner in the query itself (ADR-003): another user's case is never loaded.
    const found = await this.prisma.case.findFirst({
      where: { id: caseId, userId },
      include: { statusHistory: { orderBy: [{ changedAt: "asc" }, { id: "asc" }] } },
    });
    if (!found) return null;
    const { statusHistory, ...record } = found;
    return {
      case: record,
      statusHistory: statusHistory.map((change) => ({
        fromStatus: change.fromStatus,
        toStatus: change.toStatus,
        changedByUserId: change.changedByUserId,
        changedAt: change.changedAt,
      })),
    };
  }
}
