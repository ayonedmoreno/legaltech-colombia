import { NextResponse, type NextRequest } from "next/server";
import { buildContentSecurityPolicy, generateNonce } from "./config/csp";

/**
 * Sets a fresh CSP nonce per page request. Next.js reads the nonce from the request's
 * Content-Security-Policy header and applies it to the scripts it renders; the same policy is
 * returned to the browser.
 */
export function middleware(request: NextRequest) {
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
  ],
};
