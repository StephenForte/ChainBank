/**
 * Race helper for cron-vs-API concurrency tests (C16).
 *
 * Starts every task, settles all, and never rejects — so a race that fails one
 * side is asserted on via PromiseSettledResult, not thrown away by Promise.all.
 */
export async function runRacing<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(tasks.map((task) => task()));
}
