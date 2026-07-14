export interface IdempotencyEntry<T> {
  readonly fingerprint: string;
  readonly expiresAtMs: number;
  readonly inFlight?: Promise<T> | undefined;
  readonly result?: T | undefined;
}

export interface IdempotencyStore<T> {
  get(key: string): IdempotencyEntry<T> | undefined;
  set(key: string, entry: IdempotencyEntry<T>): void;
  delete(key: string): void;
  pruneExpired?(nowMs: number): void;
}

export function createMemoryIdempotencyStore<T>(): IdempotencyStore<T> {
  const entries = new Map<string, IdempotencyEntry<T>>();

  return {
    get: (key) => entries.get(key),
    set: (key, entry) => {
      entries.set(key, entry);
    },
    delete: (key) => {
      entries.delete(key);
    },
    pruneExpired: (nowMs) => {
      for (const [key, entry] of entries.entries()) {
        if (entry.expiresAtMs <= nowMs) {
          entries.delete(key);
        }
      }
    },
  };
}
