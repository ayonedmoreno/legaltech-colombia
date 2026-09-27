/**
 * Email links carry their token in the URL fragment (`#token=…`, Sprint 1B decision P14): the
 * browser never sends a fragment to any server, so the token stays out of request lines, server
 * logs and Referer headers. Returns the token, or null when the fragment has none.
 */
export function readTokenFromFragment(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const token = params.get("token");
  return token && /^[A-Za-z0-9_-]{1,256}$/.test(token) ? token : null;
}
