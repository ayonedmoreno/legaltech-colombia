import type { Case, CaseStatusChange } from "@legaltech/contracts";
import type { CaseRecord, CaseStatusChangeRecord } from "./cases.types.js";

/** Public shape of a case (API_SPEC.md `Case`). The owner is never sent: it is always the caller. */
export function toPublicCase(record: CaseRecord): Case {
  return {
    id: record.id,
    type: record.type,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** Public shape of a status history entry (API_SPEC.md `CaseStatusChange`). */
export function toPublicStatusChange(change: CaseStatusChangeRecord): CaseStatusChange {
  return {
    fromStatus: change.fromStatus,
    toStatus: change.toStatus,
    changedAt: change.changedAt.toISOString(),
  };
}
