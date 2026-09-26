/**
 * Web → API proxy (ADR-002): the browser only ever talks to the web origin, and Next.js
 * forwards `/api/*` to the Fastify API. Session and CSRF cookies therefore stay first-party
 * on `APP_ORIGIN` and no CORS with credentials is needed.
 *
 * `API_INTERNAL_URL` is where the web server reaches the API (never exposed to the browser).
 * It defaults to the local API (`pnpm dev`, `pnpm build` and CI need no configuration). The
 * rewrite is fixed when `next build` runs, so a deployment must build with its own value; a
 * wrong one fails closed (the API is unreachable), it never exposes anything.
 */
export const DEFAULT_API_INTERNAL_URL = "http://127.0.0.1:4000";

export function resolveApiInternalUrl(env: Readonly<Record<string, string | undefined>>): string {
  const value = env.API_INTERNAL_URL;
  if (!value) return DEFAULT_API_INTERNAL_URL;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("API_INTERNAL_URL must be an absolute http(s) URL.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== value) {
    throw new Error(
      "API_INTERNAL_URL must be a bare origin (scheme://host[:port]) with no trailing slash or path.",
    );
  }
  return value;
}

/** Rewrites every `/api/*` request, unchanged, to the same path on the API. */
export function apiProxyRewrites(apiInternalUrl: string) {
  return [{ source: "/api/:path*", destination: `${apiInternalUrl}/api/:path*` }];
}
