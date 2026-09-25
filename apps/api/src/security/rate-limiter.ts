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
  private nextSweepAt = 0;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  consume(key: string, now = Date.now()): RateLimitResult {
    this.sweepExpired(now);
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

  /**
   * Drops expired buckets at most once per window. Without this, every distinct key (one
   * per client IP) would stay in memory for the life of the process, so a client rotating
   * source addresses could grow the map without bound.
   */
  private sweepExpired(now: number): void {
    if (now < this.nextSweepAt) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    this.nextSweepAt = now + this.windowMs;
  }

  /** Number of keys currently tracked. */
  get size(): number {
    return this.buckets.size;
  }

  /** Test-only: drops all buckets. */
  reset(): void {
    this.buckets.clear();
  }
}
