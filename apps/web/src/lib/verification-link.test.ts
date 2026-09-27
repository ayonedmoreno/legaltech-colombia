import { describe, expect, it } from "vitest";
import { readTokenFromFragment } from "./verification-link";

describe("readTokenFromFragment", () => {
  it("reads the token from the URL fragment", () => {
    expect(readTokenFromFragment("#token=abc_DEF-123")).toBe("abc_DEF-123");
    expect(readTokenFromFragment("token=abc")).toBe("abc");
  });

  it("returns null without a well-formed token", () => {
    for (const hash of ["", "#", "#other=1", "#token=", "#token=a%20b", "#token=<script>"]) {
      expect(readTokenFromFragment(hash)).toBeNull();
    }
    expect(readTokenFromFragment(`#token=${"a".repeat(257)}`)).toBeNull();
  });
});
