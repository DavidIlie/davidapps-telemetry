interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class ProjectRateLimiter {
  readonly #buckets = new Map<string, Bucket>();

  take(project: string, ratePerSecond = 20, burst = 40, now = Date.now()): boolean {
    const bucket = this.#buckets.get(project) ?? { tokens: burst, updatedAt: now };
    const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1_000;
    bucket.tokens = Math.min(burst, bucket.tokens + elapsedSeconds * ratePerSecond);
    bucket.updatedAt = now;

    if (bucket.tokens < 1) {
      this.#buckets.set(project, bucket);
      return false;
    }

    bucket.tokens -= 1;
    this.#buckets.set(project, bucket);
    return true;
  }
}

