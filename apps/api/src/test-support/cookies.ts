/** Minimal Set-Cookie parser for tests: avoids depending on a specific inject client's cookie jar. */
export interface ParsedCookie {
  name: string;
  value: string;
  attributes: string[];
}

export function findSetCookie(
  setCookieHeader: string | string[] | undefined,
  name: string,
): ParsedCookie | undefined {
  const headers = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];
  for (const header of headers) {
    const [pair, ...attributes] = header.split(";").map((part) => part.trim());
    const eq = pair!.indexOf("=");
    const cookieName = pair!.slice(0, eq);
    if (cookieName === name) {
      return { name: cookieName, value: pair!.slice(eq + 1), attributes };
    }
  }
  return undefined;
}

export function cookieHeader(cookies: Record<string, string | undefined>): string {
  return Object.entries(cookies)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}
