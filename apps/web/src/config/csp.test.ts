import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, generateNonce } from "./csp";

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name!, values];
    }),
  );
}

describe("buildContentSecurityPolicy — production", () => {
  const policy = directives(buildContentSecurityPolicy("abc123", false));

  it("only runs scripts that carry the request nonce", () => {
    expect(policy.get("script-src")).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
  });

  it("allows neither inline nor eval'd code", () => {
    const all = [...policy.values()].flat();
    expect(all).not.toContain("'unsafe-inline'");
    expect(all).not.toContain("'unsafe-eval'");
  });

  it("locks down plugins, base URI, form targets, framing and connections", () => {
    expect(policy.get("default-src")).toEqual(["'self'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'self'"]);
    expect(policy.get("form-action")).toEqual(["'self'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("connect-src")).toEqual(["'self'"]);
    expect(policy.has("upgrade-insecure-requests")).toBe(true);
  });
});

describe("buildContentSecurityPolicy — development", () => {
  const policy = directives(buildContentSecurityPolicy("abc123", true));

  it("adds only what the Next.js dev server needs", () => {
    expect(policy.get("script-src")).toContain("'unsafe-eval'");
    expect(policy.get("style-src")).toContain("'unsafe-inline'");
    expect(policy.get("script-src")).not.toContain("'unsafe-inline'");
  });

  it("does not upgrade requests on http://localhost", () => {
    expect(policy.has("upgrade-insecure-requests")).toBe(false);
  });
});

describe("generateNonce", () => {
  it("returns 128 random bits, base64-encoded, different every time", () => {
    const nonces = new Set(Array.from({ length: 100 }, generateNonce));
    expect(nonces.size).toBe(100);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    }
  });
});
