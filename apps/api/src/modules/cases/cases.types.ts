import type { CaseStatus, CaseType } from "@legaltech/database";
import type { AuditLogEntry } from "../auth/auth.types.js";

/** A case as stored (DATABASE_SPEC.md `cases`). */
export interface CaseRecord {
  id: string;
  userId: string;
  type: CaseType;
  status: CaseStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** One entry of a case's status history (DATABASE_SPEC.md `case_status_history`). */
export interface CaseStatusChangeRecord {
  fromStatus: CaseStatus | null;
  toStatus: CaseStatus;
  changedByUserId: string;
  changedAt: Date;
}

export interface CaseWithHistory {
  case: CaseRecord;
  statusHistory: CaseStatusChangeRecord[];
}

export interface CreateCaseInput {
  userId: string;
  type: CaseType;
  /** Builds the `case.created` event once the case exists (it names the case). */
  audit: (created: CaseRecord) => AuditLogEntry;
}

/**
 * Persistence boundary of the cases module: Prisma at runtime (cases.repository.ts), in memory
 * in tests (cases.repository.fake.ts). Every read is scoped to the owner (ADR-003): there is no
 * way to load a case without saying whose it is.
 */
export interface CasesRepository {
  /**
   * Creates a case in `DRAFT` for its owner, in one transaction with its first status history
   * entry (`NULL → DRAFT`, by the owner) and its audit event (written with the case's id as
   * `case_id`): all of it is kept, or none.
   */
  createCase(input: CreateCaseInput): Promise<CaseRecord>;
  /** The user's own cases, most recent first. */
  listOwnCases(userId: string): Promise<CaseRecord[]>;
  /**
   * One of the user's own cases with its status history in chronological order, or null when
   * it does not exist or belongs to someone else (the caller answers both alike).
   */
  findOwnCase(caseId: string, userId: string): Promise<CaseWithHistory | null>;
}
