/**
 * concurrency.ts — bounded fan-out for upstream reads (Explorer detail
 * hydration, registry-mode contract reads).
 */

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
