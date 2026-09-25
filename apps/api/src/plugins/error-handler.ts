import type { ApiError, ApiErrorCode } from "@legaltech/contracts";
import type { FastifyInstance } from "fastify";
import { HttpError } from "../common/http-error.js";

const KNOWN: Record<number, { code: ApiErrorCode; message: string }> = {
  400: { code: "VALIDATION_ERROR", message: "Solicitud inválida." },
  401: { code: "UNAUTHENTICATED", message: "Se requiere autenticación." },
  403: { code: "FORBIDDEN", message: "No tienes permiso para esta acción." },
  404: { code: "NOT_FOUND", message: "Recurso no encontrado." },
  429: { code: "RATE_LIMITED", message: "Demasiadas solicitudes. Inténtalo más tarde." },
};

const INTERNAL = { code: "INTERNAL_ERROR", message: "Error interno." } as const;

/** Fastify types the handler error as `unknown`; read `statusCode` only after narrowing. */
function statusCodeOf(error: unknown): number {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const { statusCode } = error;
    if (typeof statusCode === "number") {
      return statusCode;
    }
  }
  return 500;
}

/**
 * Uniform error responses (API_SPEC.md). Messages are fixed strings: internal error messages,
 * stack traces and SQL are never sent to the client.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const body: ApiError = {
      error: { ...KNOWN[404]!, details: [], requestId: request.id },
    };
    return reply.code(404).send(body);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      if (error.headers) {
        reply.headers(error.headers);
      }
      const body: ApiError = {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          requestId: request.id,
        },
      };
      return reply.code(error.statusCode).send(body);
    }

    const status = statusCodeOf(error);
    const known = KNOWN[status];
    if (!known) {
      request.log.error({ err: error }, "unhandled error");
    }
    const body: ApiError = {
      error: { ...(known ?? INTERNAL), details: [], requestId: request.id },
    };
    return reply.code(known ? status : 500).send(body);
  });
}
