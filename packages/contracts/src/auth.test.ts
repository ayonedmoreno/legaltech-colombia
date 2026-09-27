import { describe, expect, it } from "vitest";
import {
  loginRequestSchema,
  registerRequestSchema,
  revokeSessionParamsSchema,
  sessionsResponseSchema,
  userSchema,
} from "./index.js";

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

describe("sessionsResponseSchema", () => {
  const session = {
    id: "3f1c5d9e-6a1b-4c2d-8e3f-9a0b1c2d3e4f",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:05:00.000Z",
    ip: "203.0.113.7",
    userAgent: null,
    current: true,
  };

  it("accepts the documented Session shape, with nullable ip and userAgent", () => {
    expect(sessionsResponseSchema.safeParse({ sessions: [session] }).success).toBe(true);
    expect(sessionsResponseSchema.safeParse({ sessions: [{ ...session, ip: null }] }).success).toBe(
      true,
    );
  });

  it("requires the current flag", () => {
    const withoutCurrent: Partial<typeof session> = { ...session };
    delete withoutCurrent.current;
    expect(sessionsResponseSchema.safeParse({ sessions: [withoutCurrent] }).success).toBe(false);
  });
});

describe("revokeSessionParamsSchema", () => {
  it("accepts a UUID session id and nothing else", () => {
    const sessionId = "3f1c5d9e-6a1b-4c2d-8e3f-9a0b1c2d3e4f";
    expect(revokeSessionParamsSchema.safeParse({ sessionId }).success).toBe(true);
    expect(revokeSessionParamsSchema.safeParse({ sessionId: "not-a-uuid" }).success).toBe(false);
    expect(revokeSessionParamsSchema.safeParse({ sessionId, extra: "x" }).success).toBe(false);
  });
});
