import type {
  ApiError,
  Case,
  CaseResponse,
  CaseType,
  CsrfResponse,
  Document,
  DocumentDownloadResponse,
  DocumentResponse,
  LoginRequest,
  LoginResponse,
  RegisterRequest,
  RotateSessionResponse,
  User,
} from "@legaltech/contracts";

/**
 * Browser-side client for the auth API. Every call goes to `/api/*` on the web origin (ADR-002
 * proxy), so the session and CSRF cookies are first-party and sent automatically. The server
 * remains the only authority: this module only shapes requests and reads the documented
 * responses (API_SPEC.md).
 */

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

const FALLBACK_MESSAGE = "No se pudo completar la solicitud. Inténtalo de nuevo.";

type Fetch = typeof fetch;

async function request<T>(
  fetchImpl: Fetch,
  path: string,
  init: {
    method: "GET" | "POST";
    body?: unknown;
    csrfToken?: string;
    /** A raw body (a file upload), sent as application/octet-stream instead of JSON. */
    file?: { content: Blob; name: string };
  },
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.file) {
    headers["content-type"] = "application/octet-stream";
    // The name travels in a header, never in the URL (API_SPEC.md).
    headers["x-file-name"] = encodeURIComponent(init.file.name);
  }
  if (init.csrfToken) headers["x-csrf-token"] = init.csrfToken;

  let response: Response;
  try {
    response = await fetchImpl(path, {
      method: init.method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      body: init.file
        ? init.file.content
        : init.body === undefined
          ? undefined
          : JSON.stringify(init.body),
    });
  } catch {
    return { ok: false, status: 0, message: FALLBACK_MESSAGE };
  }

  if (response.ok) {
    const data = response.status === 204 ? undefined : await response.json();
    return { ok: true, data: data as T };
  }

  // Show the API's user-facing (Spanish, generic) message; never internal details.
  const error = (await response.json().catch(() => null)) as ApiError | null;
  return {
    ok: false,
    status: response.status,
    message: error?.error?.message ?? FALLBACK_MESSAGE,
  };
}

export function login(input: LoginRequest, fetchImpl: Fetch = fetch): Promise<ApiResult<User>> {
  return request<LoginResponse>(fetchImpl, "/api/auth/login", { method: "POST", body: input }).then(
    (result) => (result.ok ? { ok: true, data: result.data.user } : result),
  );
}

/** 202 means "accepted" whether or not the email was new (API_SPEC.md: no enumeration). */
export function register(
  input: RegisterRequest,
  fetchImpl: Fetch = fetch,
): Promise<ApiResult<void>> {
  return request<void>(fetchImpl, "/api/auth/register", { method: "POST", body: input }).then(
    (result) => (result.ok ? { ok: true, data: undefined } : result),
  );
}

/**
 * Confirms an email address with the token from its verification link (API_SPEC.md,
 * POST /api/auth/email/verify). The token goes in the body, never in a URL (decision P14).
 */
export function verifyEmail(token: string, fetchImpl: Fetch = fetch): Promise<ApiResult<void>> {
  return request<void>(fetchImpl, "/api/auth/email/verify", {
    method: "POST",
    body: { token },
  }).then((result) => (result.ok ? { ok: true, data: undefined } : result));
}

/**
 * Asks for a password reset email (API_SPEC.md, POST /api/auth/password/forgot). 202 means
 * "accepted" whether or not the address is registered (no enumeration).
 */
export function forgotPassword(email: string, fetchImpl: Fetch = fetch): Promise<ApiResult<void>> {
  return request<void>(fetchImpl, "/api/auth/password/forgot", {
    method: "POST",
    body: { email },
  }).then((result) => (result.ok ? { ok: true, data: undefined } : result));
}

/** Sets a new password with the token from a reset link; the token goes in the body (P14). */
export function resetPassword(
  token: string,
  newPassword: string,
  fetchImpl: Fetch = fetch,
): Promise<ApiResult<void>> {
  return request<void>(fetchImpl, "/api/auth/password/reset", {
    method: "POST",
    body: { token, newPassword },
  }).then((result) => (result.ok ? { ok: true, data: undefined } : result));
}

/**
 * Asks the API to rotate the session if it is due (ADR-002; POST /api/auth/session/rotate). The
 * call goes through the web origin, so the new cookies the API may set reach the browser. The
 * API decides whether rotation is due; this only needs to be called regularly while in use.
 */
export async function rotateSession(
  fetchImpl: Fetch = fetch,
): Promise<ApiResult<RotateSessionResponse>> {
  const csrf = await request<CsrfResponse>(fetchImpl, "/api/auth/csrf", { method: "GET" });
  if (!csrf.ok) return csrf;
  return request<RotateSessionResponse>(fetchImpl, "/api/auth/session/rotate", {
    method: "POST",
    csrfToken: csrf.data.csrfToken,
  });
}

/** Fetches the session's CSRF token, then revokes the session with it (ADR-002). */
export async function logout(fetchImpl: Fetch = fetch): Promise<ApiResult<void>> {
  const csrf = await request<CsrfResponse>(fetchImpl, "/api/auth/csrf", { method: "GET" });
  // No valid session: logout is still safe and needs no token (API_SPEC.md).
  const csrfToken = csrf.ok ? csrf.data.csrfToken : undefined;
  return request<void>(fetchImpl, "/api/auth/logout", { method: "POST", csrfToken });
}

/**
 * Creates a case of the given type for the current user (API_SPEC.md, POST /api/cases): fetches
 * the session's CSRF token, then posts only the type. The API sets the status (DRAFT) and owner.
 */
export async function createCase(
  type: CaseType,
  fetchImpl: Fetch = fetch,
): Promise<ApiResult<Case>> {
  const csrf = await request<CsrfResponse>(fetchImpl, "/api/auth/csrf", { method: "GET" });
  if (!csrf.ok) return csrf;
  const result = await request<CaseResponse>(fetchImpl, "/api/cases", {
    method: "POST",
    body: { type },
    csrfToken: csrf.data.csrfToken,
  });
  return result.ok ? { ok: true, data: result.data.case } : result;
}

/**
 * Uploads a file to one of the user's cases (API_SPEC.md, POST /api/cases/:caseId/documents):
 * the raw file with its name, after fetching the session's CSRF token. The API checks the type
 * by content and the size; this client only shapes the request.
 */
export async function uploadDocument(
  caseId: string,
  file: { content: Blob; name: string },
  fetchImpl: Fetch = fetch,
): Promise<ApiResult<Document>> {
  const csrf = await request<CsrfResponse>(fetchImpl, "/api/auth/csrf", { method: "GET" });
  if (!csrf.ok) return csrf;
  const result = await request<DocumentResponse>(
    fetchImpl,
    `/api/cases/${encodeURIComponent(caseId)}/documents`,
    { method: "POST", file, csrfToken: csrf.data.csrfToken },
  );
  return result.ok ? { ok: true, data: result.data.document } : result;
}

/** A short-lived download URL for one of the user's documents (the API authorizes it). */
export function getDocumentDownloadUrl(
  caseId: string,
  documentId: string,
  fetchImpl: Fetch = fetch,
): Promise<ApiResult<DocumentDownloadResponse>> {
  return request<DocumentDownloadResponse>(
    fetchImpl,
    `/api/cases/${encodeURIComponent(caseId)}/documents/${encodeURIComponent(documentId)}/download`,
    { method: "GET" },
  );
}
