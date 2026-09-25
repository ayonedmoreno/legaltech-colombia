import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Cookie names and attributes (ADR-002).
 *
 * Both cookies use the `__Host-` prefix: it requires `Secure`, `Path=/` and no `Domain`
 * attribute, which is exactly the design ADR-002 approved, and it stops a network attacker
 * or a subdomain from setting a cookie that would be accepted under this name. Modern
 * browsers accept `Secure` cookies on `http://localhost` for local development, so this
 * does not need a development-only branch.
 *
 * The CSRF cookie is intentionally NOT httpOnly: it implements the double-submit pattern
 * (ADR-002 "obtenido mediante GET /api/auth/csrf") — the browser sends it automatically,
 * client-side code reads it to set the `X-CSRF-Token` header, and the server only ever
 * stores and compares its hash (`sessions.csrf_token_hash`), never the raw value.
 */
export const SESSION_COOKIE = "__Host-session";
export const CSRF_COOKIE = "__Host-csrf";

const BASE_ATTRIBUTES = {
  secure: true,
  sameSite: "lax" as const,
  path: "/",
};

export function readSessionToken(request: FastifyRequest): string | undefined {
  return request.cookies[SESSION_COOKIE];
}

export function readCsrfToken(request: FastifyRequest): string | undefined {
  return request.cookies[CSRF_COOKIE];
}

export function setSessionCookies(
  reply: FastifyReply,
  tokens: { sessionRaw: string; csrfRaw: string },
): void {
  reply.setCookie(SESSION_COOKIE, tokens.sessionRaw, { ...BASE_ATTRIBUTES, httpOnly: true });
  reply.setCookie(CSRF_COOKIE, tokens.csrfRaw, { ...BASE_ATTRIBUTES, httpOnly: false });
}

/**
 * Clears with the same attributes the cookies were set with. Browsers reject any
 * `__Host-` Set-Cookie that lacks `Secure`, so clearing with `Path=/` alone would be
 * silently ignored and leave the cookie in place after logout.
 */
export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { ...BASE_ATTRIBUTES, httpOnly: true });
  reply.clearCookie(CSRF_COOKIE, { ...BASE_ATTRIBUTES, httpOnly: false });
}
