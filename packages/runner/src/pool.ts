/**
 * Run a bounded number of jobs at a time, preserving input order.
 *
 * Each offline case runs in its own worker thread, so an unbounded fan-out over a
 * few hundred cases would spawn a few hundred threads. Results come back in the
 * order the jobs were given regardless of the order they finish, which is what
 * keeps a report identical at any concurrency.
 */
export async function mapPooled<In, Out>(
  items: In[],
  concurrency: number,
  job: (item: In, index: number) => Promise<Out>,
): Promise<Out[]> {
  const results = new Array<Out>(items.length);
  const width = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await job(items[index] as In, index);
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
