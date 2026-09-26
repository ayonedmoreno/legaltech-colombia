import { describe, expect, it } from "vitest";
import { buildTestApp } from "../../test-support/build-test-app.js";
import { isSameOrigin } from "./auth.origin.js";

const APP_ORIGIN = "http://localhost:3000";

describe("isSameOrigin", () => {
  it("accepts a matching Origin header", () => {
    expect(isSameOrigin({ origin: APP_ORIGIN }, APP_ORIGIN)).toBe(true);
  });

  it("prefers Origin over Referer when both are present", () => {
    expect(
      isSameOrigin({ origin: "http://evil.example", referer: `${APP_ORIGIN}/login` }, APP_ORIGIN),
    ).toBe(false);
  });

  it("accepts a matching Origin even when Referer is cross-origin (Origin takes precedence)", () => {
    expect(
      isSameOrigin({ origin: APP_ORIGIN, referer: "http://evil.example/login" }, APP_ORIGIN),
    ).toBe(true);
  });

  it("falls back to a same-origin Referer when Origin is absent", () => {
    expect(isSameOrigin({ referer: `${APP_ORIGIN}/login?next=%2Fdashboard` }, APP_ORIGIN)).toBe(
      true,
    );
  });

  it("rejects a cross-origin Referer when Origin is absent", () => {
    expect(isSameOrigin({ referer: "http://evil.example/login" }, APP_ORIGIN)).toBe(false);
  });

  it("rejects a Referer that only shares a prefix with the app origin", () => {
    expect(isSameOrigin({ referer: "http://localhost:3000.evil.example/" }, APP_ORIGIN)).toBe(
      false,
    );
    expect(isSameOrigin({ referer: "https://localhost:3000/login" }, APP_ORIGIN)).toBe(false);
    expect(isSameOrigin({ referer: "http://localhost:3001/login" }, APP_ORIGIN)).toBe(false);
  });

  it("rejects a malformed Referer instead of throwing", () => {
    for (const referer of ["not a url", "/login", "http://", "::::"]) {
      expect(isSameOrigin({ referer }, APP_ORIGIN)).toBe(false);
    }
  });

  it("fails closed when both Origin and Referer are absent", () => {
    expect(isSameOrigin({}, APP_ORIGIN)).toBe(false);
    expect(isSameOrigin({ origin: "", referer: "" }, APP_ORIGIN)).toBe(false);
  });
});

describe("Origin/Referer enforcement on POST /api/auth/login", () => {
  async function loginWith(headers: Record<string, string>) {
    const { app } = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json", ...headers },
      payload: { email: "nobody@example.com", password: "whatever12345" },
    });
    await app.close();
    return response;
  }

  it("lets a request with only a same-origin Referer past the origin check", async () => {
    const response = await loginWith({ referer: `${APP_ORIGIN}/login` });
    // Reaches authentication (unknown user), i.e. it was not rejected as cross-origin.
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("INVALID_CREDENTIALS");
  });

  it.each([
    ["a cross-origin Referer", { referer: "http://evil.example/login" }],
    ["a malformed Referer", { referer: "not a url" }],
    ["neither Origin nor Referer", {}],
  ])("rejects a request with %s as CSRF_INVALID", async (_label, headers) => {
    const response = await loginWith(headers);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("CSRF_INVALID");
  });
});
