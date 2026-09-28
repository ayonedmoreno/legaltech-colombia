import type { Case, CaseDetailResponse, CasesResponse } from "@legaltech/contracts";
import { SESSION_COOKIE } from "./session";

/**
 * Server-side reads of the user's own cases for the protected pages. Like the session check
 * (session.ts), the web server asks the API through its internal URL, forwarding only the
 * session cookie; the API decides what the user may see (ADR-003). The page tells a missing
 * session (`unauthenticated`) from a case the user cannot see (`not_found`, which is also the
 * answer for other users' cases and for roles outside this slice).
 */
export type CasesRead<T> =
  { kind: "ok"; data: T } | { kind: "unauthenticated" } | { kind: "not_found" } | { kind: "error" };

/** Session tokens are base64url (API: 256-bit opaque token); anything else is not forwarded. */
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
/** A case id is a UUID; anything else never reaches the API (it would answer 404 anyway). */
const CASE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readFromApi<T>(
  path: string,
  sessionToken: string | undefined,
  apiInternalUrl: string,
  fetchImpl: typeof fetch,
): Promise<CasesRead<T>> {
  if (!sessionToken || !SESSION_TOKEN_PATTERN.test(sessionToken)) {
    return { kind: "unauthenticated" };
  }
  try {
    const response = await fetchImpl(`${apiInternalUrl}${path}`, {
      headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, accept: "application/json" },
      cache: "no-store",
    });
    if (response.status === 200) return { kind: "ok", data: (await response.json()) as T };
    if (response.status === 401) return { kind: "unauthenticated" };
    if (response.status === 404) return { kind: "not_found" };
    return { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

export async function getOwnCases(
  sessionToken: string | undefined,
  apiInternalUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CasesRead<Case[]>> {
  const result = await readFromApi<CasesResponse>(
    "/api/cases",
    sessionToken,
    apiInternalUrl,
    fetchImpl,
  );
  return result.kind === "ok" ? { kind: "ok", data: result.data.cases } : result;
}

export async function getOwnCase(
  caseId: string,
  sessionToken: string | undefined,
  apiInternalUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CasesRead<CaseDetailResponse>> {
  if (!CASE_ID_PATTERN.test(caseId)) {
    // Still check the session first, so an anonymous visitor goes to the login page.
    if (!sessionToken || !SESSION_TOKEN_PATTERN.test(sessionToken)) {
      return { kind: "unauthenticated" };
    }
    return { kind: "not_found" };
  }
  return readFromApi<CaseDetailResponse>(
    `/api/cases/${caseId}`,
    sessionToken,
    apiInternalUrl,
    fetchImpl,
  );
}
