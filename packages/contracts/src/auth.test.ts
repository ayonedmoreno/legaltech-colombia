import { describe, expect, it } from "vitest";
import { loginRequestSchema, registerRequestSchema, userSchema } from "./index.js";

describe("registerRequestSchema", () => {
  it("accepts a valid payload", () => {
    const result = registerRequestSchema.safeParse({
      email: "Ana@Example.com",
      password: "correct horse battery",
      fullName: "Ana Gómez",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a role field supplied by the client (public registration is always USER)", () => {
    const result = registerRequestSchema.safeParse({
      email: "ana@example.com",
      password: "correct horse battery",
      fullName: "Ana Gómez",
      role: "ADMIN",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a short password", () => {
    const result = registerRequestSchema.safeParse({
      email: "ana@example.com",
      password: "short",
      fullName: "Ana Gómez",
    });
    expect(result.success).toBe(false);
  });
});

describe("loginRequestSchema", () => {
  it("rejects an empty password", () => {
    expect(loginRequestSchema.safeParse({ email: "ana@example.com", password: "" }).success).toBe(
      false,
    );
  });
});

describe("userSchema", () => {
  it("never allows a passwordHash-like field to pass through unnoticed", () => {
    const shape = Object.keys(userSchema.shape);
    expect(shape).not.toContain("passwordHash");
    expect(shape).not.toContain("tokenHash");
  });
});
