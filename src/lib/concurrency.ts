/**
 * concurrency.ts — bounded fan-out for upstream reads (Explorer detail
 * hydration, registry-mode contract reads and registration fetches).
 */

/**
 * A gate that runs at most `limit` tasks at once, the rest in arrival order.
 * Registry mode reads many agents at once, mostly waiting on registration hosts,
 * and sends their contract simulations through a narrower gate so the RPC sees
 * a bounded load.
 */
export function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  const max = Math.max(1, Math.floor(limit) || 1);
  const waiting: Array<() => void> = [];
  let active = 0;
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < max) active++;
    // A finishing task hands its slot straight to the next waiter, so a newcomer can't slip in between.
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/** Small dependency-free pMap used for bounded Explorer fan-out. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(items.length || 1, Math.floor(limit) || 1)) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        output[index] = await mapper(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return output;
}
