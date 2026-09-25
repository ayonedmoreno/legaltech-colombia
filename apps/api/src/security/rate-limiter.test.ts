import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "./rate-limiter.js";

describe("FixedWindowRateLimiter", () => {
  it("allows up to max requests per window, then reports Retry-After", () => {
    const limiter = new FixedWindowRateLimiter(2, 1000);
    expect(limiter.consume("a", 0).allowed).toBe(true);
    expect(limiter.consume("a", 100).allowed).toBe(true);
    expect(limiter.consume("a", 200)).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.consume("a", 1000).allowed).toBe(true);
  });

  it("drops expired buckets instead of keeping every key for the life of the process", () => {
    const limiter = new FixedWindowRateLimiter(5, 1000);
    for (let i = 0; i < 100; i++) limiter.consume(`10.0.0.${i}`, 0);
    expect(limiter.size).toBe(100);

    // After the window has passed, the next request sweeps the stale keys.
    limiter.consume("10.0.1.1", 1000);
    expect(limiter.size).toBe(1);
  });

  it("does not drop buckets whose window is still open", () => {
    const limiter = new FixedWindowRateLimiter(1, 1000);
    limiter.consume("a", 0);
    limiter.consume("b", 900);
    limiter.consume("c", 1000); // sweeps "a" only; "b" expires at 1900
    expect(limiter.consume("b", 1100).allowed).toBe(false);
  });
});
