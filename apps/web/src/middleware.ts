import { NextResponse, type NextRequest } from "next/server";
import { buildContentSecurityPolicy, generateNonce } from "./config/csp";
import { oversizedUploadError } from "./config/upload-guard";

/**
 * Pages: sets a fresh CSP nonce per request. Next.js reads the nonce from the request's
 * Content-Security-Policy header and applies it to the scripts it renders; the same policy is
 * returned to the browser.
 *
 * Document uploads (`POST /api/cases/:caseId/documents`): a declared size over the system's
 * limit gets the API's 413 here instead of being forwarded (see upload-guard.ts). Every other
 * upload continues, unchanged, to the API.
 */
export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    const requestId = crypto.randomUUID();
    const error = oversizedUploadError(
      request.method,
      request.nextUrl.pathname,
      request.headers.get("content-length"),
      requestId,
    );
    if (!error) return NextResponse.next();
    return NextResponse.json(error, {
      status: 413,
      headers: { "x-request-id": requestId, "cache-control": "no-store" },
    });
  }

  const nonce = generateNonce();
  const policy = buildContentSecurityPolicy(nonce, process.env.NODE_ENV === "development");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: /api/* is proxied to the API (which sets its own headers) and static
      // assets need no nonce. Prefetches reuse the page's policy.
      source: "/((?!api/|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
    // The one API route that receives files, for the size guard.
    "/api/cases/:caseId/documents",
  ],
};
