import type { CaseDetailResponse, CaseResponse, CasesResponse } from "@legaltech/contracts";
import { caseParamsSchema, createCaseRequestSchema } from "@legaltech/contracts";
import type { FastifyPluginAsync } from "fastify";
import { HttpError } from "../../common/http-error.js";
import {
  requestContext,
  requireCsrf,
  requireCurrentUser,
  validationError,
} from "../auth/auth.request.js";
import type { AuthService } from "../auth/auth.service.js";
import type { CasesService } from "./cases.service.js";

export interface CasesRouteDeps {
  authService: AuthService;
  casesService: CasesService;
  appOrigin: string;
}

/** `/api/cases` (API_SPEC.md, first Case slice): create, list and read one's own cases. */
export const casesRoutes: FastifyPluginAsync<CasesRouteDeps> = async (
  app,
  { authService, casesService, appOrigin },
) => {
  app.post("/", async (request, reply) => {
    // Authentication and CSRF first, as for every mutating request with a session.
    const current = await requireCurrentUser(request, authService);
    requireCsrf(request, authService, current.session, appOrigin);

    const parsed = createCaseRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);

    const body: CaseResponse = {
      case: await casesService.createCase(current, parsed.data, requestContext(request)),
    };
    return reply.code(201).send(body);
  });

  app.get("/", async (request, reply) => {
    const current = await requireCurrentUser(request, authService);
    const body: CasesResponse = { cases: await casesService.listOwnCases(current) };
    return reply.send(body);
  });

  app.get("/:caseId", async (request, reply) => {
    const current = await requireCurrentUser(request, authService);
    // A malformed id cannot name any case: the same 404 as an unknown or foreign one (ADR-003).
    const params = caseParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new HttpError(404, "NOT_FOUND", "Recurso no encontrado.");
    }
    const body: CaseDetailResponse = await casesService.readOwnCase(current, params.data.caseId);
    return reply.send(body);
  });
};
