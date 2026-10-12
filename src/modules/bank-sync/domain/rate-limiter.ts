/** In-process sliding window. One OCI instance today; see memory/bank-sync.md. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: () => number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Records a hit; false when the key is over its budget. */
  allow(key: string, now = Date.now()): boolean {
    const since = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (recent.length >= this.max()) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.delete(key);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) {
      // Map iterates in insertion order, so the first key is the least recent.
      const oldest = this.hits.keys().next().value as string | undefined;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    return true;
  }
}
