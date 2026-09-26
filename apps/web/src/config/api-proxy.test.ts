import { describe, expect, it } from "vitest";
import { DEFAULT_API_INTERNAL_URL, apiProxyRewrites, resolveApiInternalUrl } from "./api-proxy";

describe("resolveApiInternalUrl", () => {
  it("defaults to the local API when unset or empty", () => {
    expect(resolveApiInternalUrl({})).toBe(DEFAULT_API_INTERNAL_URL);
    expect(resolveApiInternalUrl({ API_INTERNAL_URL: "" })).toBe(DEFAULT_API_INTERNAL_URL);
  });

  it("accepts a bare http(s) origin", () => {
    expect(resolveApiInternalUrl({ API_INTERNAL_URL: "http://api.internal:4000" })).toBe(
      "http://api.internal:4000",
    );
  });

  it.each(["http://127.0.0.1:4000/", "http://127.0.0.1:4000/api", "ftp://127.0.0.1", "nope"])(
    "rejects %s",
    (value) => {
      expect(() => resolveApiInternalUrl({ API_INTERNAL_URL: value })).toThrow(/API_INTERNAL_URL/);
    },
  );
});

describe("apiProxyRewrites", () => {
  it("forwards /api/* to the same path on the API and nothing else", () => {
    expect(apiProxyRewrites("http://127.0.0.1:4000")).toEqual([
      { source: "/api/:path*", destination: "http://127.0.0.1:4000/api/:path*" },
    ]);
  });
});
