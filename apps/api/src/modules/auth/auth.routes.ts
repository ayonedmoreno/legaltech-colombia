import type {
  AcceptedResponse,
  CsrfResponse,
  LoginResponse,
  MeResponse,
  RegisterResponse,
  RotateSessionResponse,
  SessionsResponse,
} from "@legaltech/contracts";
import {
  loginRequestSchema,
  registerRequestSchema,
  forgotPasswordRequestSchema,
  resetPasswordRequestSchema,
  revokeSessionParamsSchema,
  verifyEmailRequestSchema,
} from "@legaltech/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { HttpError } from "../../common/http-error.js";
import { FixedWindowRateLimiter } from "../../security/rate-limiter.js";
import { generateOpaqueToken } from "../../security/crypto.js";
import {
  clearSessionCookies,
  readCsrfToken,
  readSessionToken,
  setCsrfCookie,
  setSessionCookies,
} from "./auth.cookies.js";
import { FORGOT_IP_LIMIT, RESEND_IP_LIMIT, RESET_IP_LIMIT } from "./auth.email-settings.js";
import {
  clientIp,
  requestContext,
  requireCsrf,
  requireSameOrigin,
  validationError,
} from "./auth.request.js";
import type { AuthService } from "./auth.service.js";

export interface AuthRouteDeps {
  authService: AuthService;
  appOrigin: string;
}

function enforceIpLimit(limiter: FixedWindowRateLimiter, request: FastifyRequest): void {
  const result = limiter.consume(clientIp(request));
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
  const resendIpLimiter = new FixedWindowRateLimiter(RESEND_IP_LIMIT.max, RESEND_IP_LIMIT.windowMs);
  const forgotIpLimiter = new FixedWindowRateLimiter(FORGOT_IP_LIMIT.max, FORGOT_IP_LIMIT.windowMs);
  const resetIpLimiter = new FixedWindowRateLimiter(RESET_IP_LIMIT.max, RESET_IP_LIMIT.windowMs);

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
    setCsrfCookie(reply, csrfToken.raw);
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

    // The session this browser already holds, if any, is revoked once the new one exists (P12).
    const result = await authService.login(
      parsed.data,
      requestContext(request),
      readSessionToken(request),
    );
    setSessionCookies(reply, { sessionRaw: result.sessionRaw, csrfRaw: result.csrfRaw });
    const body: LoginResponse = { user: result.user };
    return reply.send(body);
  });

  app.get("/me", async (request, reply) => {
    const body: MeResponse = { user: await authService.readOwnProfile(readSessionToken(request)) };
    return reply.send(body);
  });

  app.get("/sessions", async (request, reply) => {
    const body: SessionsResponse = {
      sessions: await authService.listOwnSessions(readSessionToken(request)),
    };
    return reply.send(body);
  });

  app.post("/logout", async (request, reply) => {
    await requireCsrfIfSessionValid(request, authService, appOrigin);
    await authService.logout(readSessionToken(request), requestContext(request));
    clearSessionCookies(reply);
    return reply.code(204).send();
  });

  app.post("/email/verify", async (request, reply) => {
    // A request made before having a session, like register and login: Origin, no CSRF token.
    requireSameOrigin(request, appOrigin);
    const parsed = verifyEmailRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);

    await authService.verifyEmail(parsed.data.token, requestContext(request));
    return reply.code(204).send();
  });

  app.post("/email/verification/resend", async (request, reply) => {
    const current = await authService.currentUser(readSessionToken(request));
    if (!current) {
      throw new HttpError(401, "UNAUTHENTICATED", "Se requiere autenticación.");
    }
    requireCsrf(request, authService, current.session, appOrigin);
    // As for login (ADR-002 D3): the per-IP limit first, then the per-account one.
    enforceIpLimit(resendIpLimiter, request);

    await authService.resendEmailVerification(current);
    const body: AcceptedResponse = { status: "accepted" };
    return reply.code(202).send(body);
  });

  app.post("/password/forgot", async (request, reply) => {
    // Before having a session, like register and login: Origin, then the per-IP limit.
    requireSameOrigin(request, appOrigin);
    enforceIpLimit(forgotIpLimiter, request);
    const parsed = forgotPasswordRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);

    await authService.forgotPassword(parsed.data, requestContext(request));
    // The same answer whether or not the address is registered (ADR-002).
    const body: AcceptedResponse = { status: "accepted" };
    return reply.code(202).send(body);
  });

  app.post("/password/reset", async (request, reply) => {
    requireSameOrigin(request, appOrigin);
    enforceIpLimit(resetIpLimiter, request);
    const parsed = resetPasswordRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);

    await authService.resetPassword(parsed.data, requestContext(request));
    return reply.code(204).send();
  });

  app.post("/session/rotate", async (request, reply) => {
    const current = await authService.currentUser(readSessionToken(request));
    if (!current) {
      throw new HttpError(401, "UNAUTHENTICATED", "Se requiere autenticación.");
    }
    requireCsrf(request, authService, current.session, appOrigin);

    const result = await authService.rotateSession(current, requestContext(request));
    if (result.rotated) {
      setSessionCookies(reply, { sessionRaw: result.sessionRaw, csrfRaw: result.csrfRaw });
    }
    const body: RotateSessionResponse = { rotated: result.rotated };
    return reply.send(body);
  });

  app.post("/logout-all", async (request, reply) => {
    // Unlike /logout, this needs a valid session: there is nothing to act on without one.
    const current = await authService.currentUser(readSessionToken(request));
    if (!current) {
      throw new HttpError(401, "UNAUTHENTICATED", "Se requiere autenticación.");
    }
    requireCsrf(request, authService, current.session, appOrigin);

    await authService.logoutAll(current, requestContext(request));
    // The current session is among those revoked.
    clearSessionCookies(reply);
    return reply.code(204).send();
  });

  app.delete("/sessions/:sessionId", async (request, reply) => {
    // Authentication and CSRF come first, so nothing about the target session is revealed to a
    // request that is not allowed to act at all.
    const current = await authService.currentUser(readSessionToken(request));
    if (!current) {
      throw new HttpError(401, "UNAUTHENTICATED", "Se requiere autenticación.");
    }
    requireCsrf(request, authService, current.session, appOrigin);

    // A malformed id cannot name any session: the same 404 as an unknown or foreign one.
    const params = revokeSessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new HttpError(404, "NOT_FOUND", "Recurso no encontrado.");
    }

    const { revokedCurrent } = await authService.revokeOwnSession(
      current,
      params.data.sessionId,
      requestContext(request),
    );
    if (revokedCurrent) clearSessionCookies(reply);
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
  requireCsrf(request, authService, current.session, appOrigin);
}
