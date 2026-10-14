import { pool } from "../db/pool.js";
import { isWorkerReady } from "../health.js";
import { errorExtra, logWarn } from "../logger.js";
import { getService } from "../serviceRegistry/registry.js";

/**
 * Of the given paid tasks, those a healthy service poller durably owns while
 * they wait on an outside party (`operations.waitSupervision`). A service
 * without the hook supervises nothing; neither does one whose poller worker
 * is not currently healthy, nor one whose hook fails: a slow service is
 * never trusted merely because it says so.
 */
export async function supervisedWaitingTasks(
  tasks: ReadonlyArray<{ id: string; serviceSlug: string }>,
): Promise<Set<string>> {
  const bySlug = new Map<string, string[]>();
  for (const task of tasks) bySlug.set(task.serviceSlug, [...(bySlug.get(task.serviceSlug) ?? []), task.id]);
  const supervised = new Set<string>();
  for (const [slug, taskIds] of bySlug) {
    const supervision = getService(slug)?.operations?.waitSupervision;
    if (!supervision || !isWorkerReady(supervision.worker)) continue;
    try {
      const claimed = await supervision.supervisedTasks({ db: pool, taskIds });
      for (const id of claimed) if (taskIds.includes(id)) supervised.add(id);
    } catch (error) {
      logWarn("Service wait supervision check failed", errorExtra(error, { serviceSlug: slug }));
    }
  }
  return supervised;
}
