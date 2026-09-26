import type {
  CsrfResponse,
  LoginResponse,
  MeResponse,
  RegisterResponse,
} from "@legaltech/contracts";
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

function requestContext(request: FastifyRequest): RequestContext {
  return {
    ip: request.ip,
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
function readCsrfHeader(request: FastifyRequest): string | undefined {
  const header = request.headers["x-csrf-token"];
  return Array.isArray(header) ? header[0] : header;
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

export const authRoutes: FastifyPluginAsync<AuthRouteDeps> = async (
  app,
  { authService, appOrigin },
) => {
  // Per-IP, in-memory limits (SECURITY_SPEC.md §7 known limitation: not shared across
  // process instances). Created here, inside the plugin, rather than at module scope: each
  // Fastify instance — including a fresh one per test via buildTestApp — gets its own
  // isolated counters. A module-level singleton would leak request counts between
  // independent app instances (and, in tests, between unrelated test cases), which is
  // exactly the class of bug a shared global would invite here.
  const registerIpLimiter = new FixedWindowRateLimiter(5, 10 * 60 * 1000);
  const loginIpLimiter = new FixedWindowRateLimiter(10, 10 * 60 * 1000);

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
    const body: MeResponse = { user: await authService.readOwnProfile(readSessionToken(request)) };
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
 * Logout must succeed even for an already-invalid session (API_SPEC.md, `POST /api/auth/logout`),
 * so CSRF is only enforced when there is something to protect: a currently valid session. With no
 * valid session, this is a no-op and the route proceeds to clear cookies.
 */
async function requireCsrfIfSessionValid(
  request: FastifyRequest,
  authService: AuthService,
  appOrigin: string,
): Promise<void> {
  const current = await authService.currentUser(readSessionToken(request));
  if (!current) return;

  requireSameOrigin(request, appOrigin);
  if (!authService.verifyCsrf(current.session, readCsrfHeader(request))) {
    throw new HttpError(403, "CSRF_INVALID", "Token CSRF inválido o ausente.");
  }
}
