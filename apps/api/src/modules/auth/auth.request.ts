import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";
import type { ZodError } from "zod";
import { HttpError } from "../../common/http-error.js";
import { readSessionToken } from "./auth.cookies.js";
import { isSameOrigin } from "./auth.origin.js";
import type { AuthService, CurrentUserResult, RequestContext } from "./auth.service.js";
import type { SessionRecord } from "./auth.types.js";

/**
 * Request guards shared by every route that acts for an authenticated user (the auth routes and
 * the routes of other modules, such as cases): client address and request context, Origin and
 * CSRF checks, the current user, and the uniform validation error.
 */

/**
 * The client address used for the per-IP limits and recorded in audit logs and sessions
 * (ADR-002, D2-G). Behind a proxy listed in API_TRUST_PROXY, `request.ip` comes from
 * X-Forwarded-For and can be any text a client sent; anything that is not an IP address falls
 * back to the TCP peer instead of being rejected.
 */
export function clientIp(request: FastifyRequest): string {
  return isIP(request.ip) !== 0 ? request.ip : (request.socket.remoteAddress ?? "");
}

export function requestContext(request: FastifyRequest): RequestContext {
  return {
    ip: clientIp(request),
    userAgent: request.headers["user-agent"] ?? null,
    requestId: request.id,
  };
}

/**
 * The `X-CSRF-Token` header — never the CSRF cookie itself. In the double-submit pattern
 * (ADR-002 / API_SPEC.md) the cookie is not the credential being checked: it travels
 * automatically with every request, cross-site ones included, exactly like the session
 * cookie, so comparing it against the session would always "match" and provide no
 * protection at all. The header is the credential, because only same-origin JavaScript can
 * read the CSRF cookie's value and place it there; a cross-site request cannot forge it.
 */
export function readCsrfHeader(request: FastifyRequest): string | undefined {
  const header = request.headers["x-csrf-token"];
  return Array.isArray(header) ? header[0] : header;
}

export function validationError(error: ZodError): HttpError {
  const details = error.issues.map((issue) => ({
    field: issue.path.join(".") || "(root)",
    issue: issue.message,
  }));
  return new HttpError(400, "VALIDATION_ERROR", "Solicitud inválida.", { details });
}

export function requireSameOrigin(request: FastifyRequest, appOrigin: string): void {
  if (!isSameOrigin(request.headers, appOrigin)) {
    throw new HttpError(403, "CSRF_INVALID", "Origen no permitido.");
  }
}

/**
 * CSRF for a mutating request made with a valid session (API_SPEC.md): same Origin (or Referer)
 * and the session's CSRF token in the `X-CSRF-Token` header, or 403 `CSRF_INVALID`.
 */
export function requireCsrf(
  request: FastifyRequest,
  authService: AuthService,
  session: SessionRecord,
  appOrigin: string,
): void {
  requireSameOrigin(request, appOrigin);
  if (!authService.verifyCsrf(session, readCsrfHeader(request))) {
    throw new HttpError(403, "CSRF_INVALID", "Token CSRF inválido o ausente.");
  }
}

/** The authenticated user of the request, or 401 `UNAUTHENTICATED` (API_SPEC.md). */
export async function requireCurrentUser(
  request: FastifyRequest,
  authService: AuthService,
): Promise<CurrentUserResult> {
  const current = await authService.currentUser(readSessionToken(request));
  if (!current) {
    throw new HttpError(401, "UNAUTHENTICATED", "Se requiere autenticación.");
  }
  return current;
}
