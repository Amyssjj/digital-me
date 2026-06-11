/**
 * Tiny TTL cache for dashboard responses.
 *
 * Replaces the module-level Map + setInterval pattern in the upstream
 * brain-client. Class-based so each consumer can keep its own cache,
 * and the sweep is invoked explicitly (or by a setInterval the consumer
 * owns) — no module-scope side effects.
 */

type Entry<T> = {
  readonly value: T;
  readonly expiresAt: number;
};

export class TtlCache {
  private readonly entries = new Map<string, Entry<unknown>>();

  constructor(private readonly defaultTtlMs: number) {}

  get<T>(key: string): T | null {
    const e = this.entries.get(key);
    if (e === undefined) return null;
    if (Date.now() > e.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return e.value as T;
  }

  set<T>(key: string, value: T, ttlMs?: number): void {
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now > entry.expiresAt) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}
