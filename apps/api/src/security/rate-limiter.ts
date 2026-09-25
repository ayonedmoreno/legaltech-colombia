/**
 * In-memory fixed-window rate limiter, per Node process.
 *
 * Known limitation (ADR-002, SECURITY_SPEC.md): does not share state across instances.
 * If the API ever runs with more than one instance, this must move to a shared store
 * before it can be relied on; that migration needs its own ADR (no Redis introduced here).
 */
export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  consume(key: string, now = Date.now()): RateLimitResult {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (bucket.count < this.max) {
      bucket.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return { allowed: false, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) };
  }

  /** Test-only: drops all buckets. */
  reset(): void {
    this.buckets.clear();
  }
}
