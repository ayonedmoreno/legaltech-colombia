import type { MeResponse, User } from "@legaltech/contracts";

/**
 * Server-side session check for protected pages. The web server asks the API — the only
 * authority on sessions — through its internal URL, forwarding only the session cookie.
 * Any answer other than 200 means "not authenticated".
 */
export const SESSION_COOKIE = "__Host-session";

/** Session tokens are base64url (API: 256-bit opaque token); anything else is not forwarded. */
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

export async function getCurrentUser(
  sessionToken: string | undefined,
  apiInternalUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<User | null> {
  if (!sessionToken || !SESSION_TOKEN_PATTERN.test(sessionToken)) return null;

  try {
    const response = await fetchImpl(`${apiInternalUrl}/api/auth/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, accept: "application/json" },
      cache: "no-store",
    });
    if (response.status !== 200) return null;
    const body = (await response.json()) as MeResponse;
    return body.user;
  } catch {
    return null;
  }
}
