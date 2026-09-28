import type {
  DocumentDownloadResponse,
  DocumentResponse,
  DocumentsResponse,
} from "@legaltech/contracts";
import {
  caseParamsSchema,
  documentFileNameSchema,
  documentParamsSchema,
} from "@legaltech/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { HttpError } from "../../common/http-error.js";
import { requestContext, requireCsrf, requireCurrentUser } from "../auth/auth.request.js";
import type { AuthService, CurrentUserResult } from "../auth/auth.service.js";
import type { DocumentsService } from "./documents.service.js";

export interface DocumentsRouteDeps {
  authService: AuthService;
  documentsService: DocumentsService;
  appOrigin: string;
}

const UPLOAD_CONTENT_TYPE = "application/octet-stream";

function notFound(): HttpError {
  return new HttpError(404, "NOT_FOUND", "Recurso no encontrado.");
}

/** The decoded, validated `X-File-Name` header of an upload, or 400. */
function fileNameOf(request: FastifyRequest): string {
  const header = request.headers["x-file-name"];
  const raw = Array.isArray(header) ? header[0] : header;
  let decoded: string | undefined;
  try {
    decoded = raw === undefined ? undefined : decodeURIComponent(raw);
  } catch {
    decoded = undefined;
  }
  const parsed = documentFileNameSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new HttpError(400, "VALIDATION_ERROR", "Nombre de archivo inválido.", {
      details: [{ field: "X-File-Name", issue: "invalid" }],
    });
  }
  return parsed.data;
}

/**
 * `/api/cases/:caseId/documents` (API_SPEC.md, first Documents slice). The upload body is the
 * raw file: its size is bounded before it is read, and the session and CSRF token are checked
 * in `onRequest`, before a single byte of it is parsed.
 */
export const documentsRoutes: FastifyPluginAsync<DocumentsRouteDeps> = async (
  app,
  { authService, documentsService, appOrigin },
) => {
  const maxBytes = documentsService.maxBytes;
  // Scoped to this plugin: only these routes read raw bodies, up to the document limit.
  app.addContentTypeParser(
    UPLOAD_CONTENT_TYPE,
    { parseAs: "buffer", bodyLimit: maxBytes },
    (_request, body, done) => done(null, body),
  );

  const authenticated = new WeakMap<FastifyRequest, CurrentUserResult>();

  app.post(
    "/:caseId/documents",
    {
      bodyLimit: maxBytes,
      onRequest: async (request) => {
        const current = await requireCurrentUser(request, authService);
        requireCsrf(request, authService, current.session, appOrigin);
        authenticated.set(request, current);
      },
    },
    async (request, reply) => {
      const current = authenticated.get(request)!;
      const params = caseParamsSchema.safeParse(request.params);
      if (!params.success) throw notFound();
      if (!Buffer.isBuffer(request.body)) {
        throw new HttpError(415, "VALIDATION_ERROR", "Tipo de contenido no admitido.");
      }
      const fileName = fileNameOf(request);

      const body: DocumentResponse = {
        document: await documentsService.uploadDocument(
          current,
          params.data.caseId,
          { fileName, content: request.body },
          requestContext(request),
          request.log,
        ),
      };
      return reply.code(201).send(body);
    },
  );

  app.get("/:caseId/documents", async (request, reply) => {
    const current = await requireCurrentUser(request, authService);
    const params = caseParamsSchema.safeParse(request.params);
    if (!params.success) throw notFound();
    const body: DocumentsResponse = {
      documents: await documentsService.listDocuments(current, params.data.caseId),
    };
    return reply.send(body);
  });

  app.get("/:caseId/documents/:documentId/download", async (request, reply) => {
    const current = await requireCurrentUser(request, authService);
    const params = documentParamsSchema.safeParse(request.params);
    if (!params.success) throw notFound();
    const body: DocumentDownloadResponse = await documentsService.createDownloadUrl(
      current,
      params.data.caseId,
      params.data.documentId,
    );
    // A capability URL: never cached.
    return reply.header("cache-control", "no-store").send(body);
  });
};
