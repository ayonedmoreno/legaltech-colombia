import type { CsrfResponse, LoginResponse, MeResponse, RegisterResponse } from "@legaltech/contracts";
import { loginRequestSchema, registerRequestSchema } from "@legaltech/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodError } from "zod";
import { HttpError } from "../../common/http-error.js";
import { FixedWindowRateLimiter } from "../../security/rate-limiter.js";
import { generateOpaqueToken } from "../../security/crypto.js";
import {
  CSRF_COOKIE,
  clearSessionCookies,
  readCsrfToken,
  readSessionToken,
  setSessionCookies,
} from "./auth.cookies.js";
import { isSameOrigin } from "./auth.origin.js";
import type { AuthService, RequestContext } from "./auth.service.js";

export interface AuthRouteDeps {
  authService: AuthService;
  appOrigin: string;
}

// Per-IP, in-memory, single-process limits (SECURITY_SPEC.md §7 known limitation).
// Exported so tests can reset them between cases instead of sharing state across the file.
export const registerIpLimiter = new FixedWindowRateLimiter(5, 10 * 60 * 1000);
export const loginIpLimiter = new FixedWindowRateLimiter(10, 10 * 60 * 1000);

function requestContext(request: FastifyRequest): RequestContext {
  return { ip: request.ip, userAgent: request.headers["user-agent"] ?? null, requestId: request.id };
}

function validationError(error: ZodError): HttpError {
  const details = error.issues.map((issue) => ({
    field: issue.path.join(".") || "(root)",
    issue: issue.message,
  }));
  return new HttpError(400, "VALIDATION_ERROR", "Solicitud inválida.", { details });
}

function requireSameOrigin(request: FastifyRequest, appOrigin: string): void {
  if (!isSameOrigin(request.headers, appOrigin)) {
    throw new HttpError(403, "CSRF_INVALID", "Origen no permitido.");
  }
}

function enforceIpLimit(limiter: FixedWindowRateLimiter, request: FastifyRequest): void {
  const result = limiter.consume(request.ip);
  if (!result.allowed) {
    throw new HttpError(429, "RATE_LIMITED", "Demasiadas solicitudes. Inténtalo más tarde.", {
      headers: { "Retry-After": String(result.retryAfterSeconds) },
    });
  }
}

export const authRoutes: FastifyPluginAsync<AuthRouteDeps> = async (app, { authService, appOrigin }) => {
  app.get("/csrf", async (request, reply) => {
    const sessionRaw = readSessionToken(request);
    const current = await authService.currentUser(sessionRaw);
    if (!current) {
      throw new HttpError(401, "UNAUTHENTICATED", "Se requiere autenticación.");
    }

    // Reuse the existing CSRF cookie if it still matches this session; otherwise (missing,
    // or left over from a different session) issue and persist a new one. This keeps the
    // token stable across repeated calls instead of rotating it on every request.
    const existingRaw = readCsrfToken(request);
    if (existingRaw && authService.verifyCsrf(current.session, existingRaw)) {
      const body: CsrfResponse = { csrfToken: existingRaw };
      return reply.send(body);
    }

    const csrfToken = generateOpaqueToken();
    await authService.rotateCsrfToken(current.session.id, csrfToken.hash);
    reply.setCookie(CSRF_COOKIE, csrfToken.raw, { secure: true, sameSite: "lax", path: "/" });
    const body: CsrfResponse = { csrfToken: csrfToken.raw };
    return reply.send(body);
  });

  app.post("/register", async (request, reply) => {
    requireSameOrigin(request, appOrigin);
    enforceIpLimit(registerIpLimiter, request);

    const parsed = registerRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);

    await authService.register(parsed.data, requestContext(request));
    const body: RegisterResponse = { status: "accepted" };
    return reply.code(202).send(body);
  });

  app.post("/login", async (request, reply) => {
    requireSameOrigin(request, appOrigin);
    enforceIpLimit(loginIpLimiter, request);

    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);

    const result = await authService.login(parsed.data, requestContext(request));
    setSessionCookies(reply, { sessionRaw: result.sessionRaw, csrfRaw: result.csrfRaw });
    const body: LoginResponse = { user: result.user };
    return reply.send(body);
  });

  app.get("/me", async (request, reply) => {
    const current = await authService.currentUser(readSessionToken(request));
    if (!current) {
      throw new HttpError(401, "UNAUTHENTICATED", "Se requiere autenticación.");
    }
    const body: MeResponse = { user: current.user };
    return reply.send(body);
  });

  app.post("/logout", async (request, reply) => {
    await requireCsrfIfSessionValid(request, authService, appOrigin);
    await authService.logout(readSessionToken(request), requestContext(request));
    clearSessionCookies(reply);
    return reply.code(204).send();
  });
};

/**
 * Logout must succeed even for an already-invalid session (section 9 of the Sprint
 * brief), so CSRF is only enforced when there is something to protect: a currently valid
 * session. With no valid session, this is a no-op and the route proceeds to clear cookies.
 */
async function requireCsrfIfSessionValid(
  request: FastifyRequest,
  authService: AuthService,
  appOrigin: string,
): Promise<void> {
  const current = await authService.currentUser(readSessionToken(request));
  if (!current) return;

  requireSameOrigin(request, appOrigin);
  if (!authService.verifyCsrf(current.session, readCsrfToken(request))) {
    throw new HttpError(403, "CSRF_INVALID", "Token CSRF inválido o ausente.");
  }
}
