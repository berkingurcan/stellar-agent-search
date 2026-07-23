/**
 * clock.ts — injectable clock for deterministic tests.
 *
 * Any code that stamps a time (verification.checkedAt, log timestamps, cache
 * expiry) takes a Clock so tests can freeze time and assert byte-identical
 * structuredContent.
 */

export interface Clock {
  /** Milliseconds since the Unix epoch (like Date.now()). */
  now(): number;
  /** ISO-8601 string for the current instant. */
  nowIso(): string;
}

/** The real system clock. */
export const systemClock: Clock = {
  now: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

/** A clock frozen at a fixed instant (tests). Accepts ms or an ISO string. */
export function fixedClock(instant: number | string): Clock {
  const ms = typeof instant === "number" ? instant : new Date(instant).getTime();
  const iso = new Date(ms).toISOString();
  return {
    now: () => ms,
    nowIso: () => iso,
  };
}

/** A clock that advances manually; useful for TTL/expiry tests. */
export function manualClock(startMs = 0): Clock & { advance(ms: number): void; set(ms: number): void } {
  let cur = startMs;
  return {
    now: () => cur,
    nowIso: () => new Date(cur).toISOString(),
    advance: (ms: number) => {
      cur += ms;
    },
    set: (ms: number) => {
      cur = ms;
    },
  };
}
