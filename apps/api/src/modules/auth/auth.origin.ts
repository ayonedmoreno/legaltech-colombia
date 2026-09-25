/**
 * Same-origin check for state-changing requests made before a session exists (register,
 * login) and, together with the CSRF token, for requests made with a session (ADR-002 /
 * API_SPEC.md conventions: "verifican Origin"). Prefers the Origin header; falls back to
 * Referer's origin when Origin is absent (some browsers omit Origin on same-site
 * navigations). Missing both is treated as a mismatch: fail closed.
 */
export function isSameOrigin(
  headers: { origin?: string | string[]; referer?: string | string[] },
  appOrigin: string,
): boolean {
  const origin = firstHeader(headers.origin);
  if (origin) return origin === appOrigin;

  const referer = firstHeader(headers.referer);
  if (referer) {
    try {
      return new URL(referer).origin === appOrigin;
    } catch {
      return false;
    }
  }

  return false;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
