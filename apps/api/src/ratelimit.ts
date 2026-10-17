/** Counts failures per key in memory. Resets on restart and isn't shared across instances. */
export class FailureLimiter {
  private entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  isLocked(key: string) {
    const e = this.entries.get(key);
    if (!e) return false;
    if (e.resetAt < Date.now()) {
      this.entries.delete(key);
      return false;
    }
    return e.count >= this.max;
  }

  fail(key: string) {
    const e = this.entries.get(key);
    if (e && e.resetAt >= Date.now()) e.count++;
    else this.entries.set(key, { count: 1, resetAt: Date.now() + this.windowMs });
  }

  reset(key: string) {
    this.entries.delete(key);
  }
}
