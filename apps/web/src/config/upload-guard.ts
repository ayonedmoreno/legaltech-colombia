import { DOCUMENT_MAX_BYTES, type ApiError } from "@legaltech/contracts";

/**
 * Document uploads whose declared size is over the system's one limit (DOCUMENT_MAX_BYTES) are
 * answered here, at the web origin, with the API's own 413 (API_SPEC.md), instead of being
 * forwarded. Forwarding them made the API answer 413 and close the connection while the proxy was
 * still sending the cut body, which the proxy turned into a 500 for large files. Everything else
 * (and any request without a declared length) still goes to the API, which always checks again.
 */
export const UPLOAD_PATH = /^\/api\/cases\/[^/]+\/documents$/;

export function oversizedUploadError(
  method: string,
  pathname: string,
  contentLength: string | null,
  requestId: string,
): ApiError | null {
  if (method !== "POST" || !UPLOAD_PATH.test(pathname) || contentLength === null) return null;
  const declared = Number(contentLength);
  if (!Number.isFinite(declared) || declared <= DOCUMENT_MAX_BYTES) return null;
  return {
    error: {
      code: "PAYLOAD_TOO_LARGE",
      message: "La solicitud supera el tamaño máximo permitido.",
      details: [],
      requestId,
    },
  };
}
