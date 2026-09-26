/**
 * Content-Security-Policy for the web app (SECURITY_SPEC.md §4), with a per-request nonce set
 * by src/middleware.ts. Scripts run only if they carry the nonce ('strict-dynamic' extends that
 * trust to the scripts they load); there is no 'unsafe-inline' for scripts. Development adds
 * only what Next.js' dev server needs ('unsafe-eval' for fast refresh, inline styles for the
 * error overlay) and drops upgrade-insecure-requests, which would break http://localhost.
 * HSTS is set by the TLS-terminating reverse proxy, not here.
 */
export function buildContentSecurityPolicy(nonce: string, isDevelopment: boolean): string {
  const directives: Array<[string, ...string[]]> = [
    ["default-src", "'self'"],
    [
      "script-src",
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(isDevelopment ? ["'unsafe-eval'"] : []),
    ],
    ["style-src", "'self'", ...(isDevelopment ? ["'unsafe-inline'"] : [`'nonce-${nonce}'`])],
    ["img-src", "'self'", "blob:", "data:"],
    ["font-src", "'self'"],
    ["connect-src", "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
  ];
  if (!isDevelopment) directives.push(["upgrade-insecure-requests"]);

  return directives.map((directive) => directive.join(" ")).join("; ");
}

/** 128 random bits, base64-encoded (Web Crypto: available in the middleware runtime). */
export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
