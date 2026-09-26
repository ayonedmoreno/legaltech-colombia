import type { NextConfig } from "next";
import { apiProxyRewrites, resolveApiInternalUrl } from "./src/config/api-proxy";

// Base security headers. The Content-Security-Policy (per-request nonce) is set by
// src/middleware.ts; HSTS is set by the TLS-terminating reverse proxy (see SECURITY_SPEC.md).
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const apiInternalUrl = resolveApiInternalUrl(process.env);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // ADR-002: single origin. The browser calls /api/* on the web origin; Next.js forwards it.
  async rewrites() {
    return apiProxyRewrites(apiInternalUrl);
  },
};

export default nextConfig;
