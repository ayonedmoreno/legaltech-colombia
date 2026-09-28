import type { Case, CaseDetailResponse, CreateCaseRequest } from "@legaltech/contracts";
import { HttpError } from "../../common/http-error.js";
import type { CurrentUserResult, RequestContext } from "../auth/auth.service.js";
import { toPublicCase, toPublicStatusChange } from "./cases.mapper.js";
import { can } from "./cases.policy.js";
import type { CasesRepository } from "./cases.types.js";

export interface CasesServiceOptions {
  repository: CasesRepository;
}

/** A case that is not the caller's, does not exist, or the caller may not see: one answer. */
function notFound(): HttpError {
  return new HttpError(404, "NOT_FOUND", "Recurso no encontrado.");
}

/**
 * First Case slice (Phase 2; API_SPEC.md): a user creates, lists and reads their own cases. A
 * case is created in `DRAFT` and has no transitions yet. Every method receives the already
 * authenticated caller; authorization goes through the cases policy (ADR-003), and a denial
 * answers 404 like a missing case, so nothing about other users' cases is revealed.
 */
export class CasesService {
  private readonly repository: CasesRepository;

  constructor(options: CasesServiceOptions) {
    this.repository = options.repository;
  }

  async createCase(
    current: CurrentUserResult,
    input: CreateCaseRequest,
    context: RequestContext,
  ): Promise<Case> {
    if (!can(current.actor, "case:create", { userId: current.user.id }).allowed) {
      throw notFound();
    }
    const created = await this.repository.createCase({
      userId: current.user.id,
      type: input.type,
      audit: (record) => ({
        actorUserId: current.user.id,
        actorRole: current.user.role,
        action: "case.created",
        entityType: "Case",
        entityId: record.id,
        // `case_id` is set by the repository, which knows the case it just created.
        newValue: { type: record.type, status: record.status },
        requestId: context.requestId,
        ip: context.ip,
        userAgent: context.userAgent,
      }),
    });
    return toPublicCase(created);
  }

  async listOwnCases(current: CurrentUserResult): Promise<Case[]> {
    if (!can(current.actor, "case:list", { userId: current.user.id }).allowed) {
      throw notFound();
    }
    const cases = await this.repository.listOwnCases(current.user.id);
    return cases.map(toPublicCase);
  }

  async readOwnCase(current: CurrentUserResult, caseId: string): Promise<CaseDetailResponse> {
    // Checked before loading anything, so a denied caller learns nothing about the case.
    if (!can(current.actor, "case:read", { userId: current.user.id }).allowed) {
      throw notFound();
    }
    const found = await this.repository.findOwnCase(caseId, current.user.id);
    // The repository is scoped to the caller; the policy is checked again on the loaded owner.
    if (!found || !can(current.actor, "case:read", { userId: found.case.userId }).allowed) {
      throw notFound();
    }
    return {
      case: toPublicCase(found.case),
      statusHistory: found.statusHistory.map(toPublicStatusChange),
    };
  }
}
