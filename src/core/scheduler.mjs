/**
 * Minimal zero-dependency interval scheduler.
 * Timers are unref'd so they never keep the process alive. A task that throws or
 * rejects is logged and isolated (other tasks and later ticks continue); a tick
 * that fires while the previous run is still in flight is skipped.
 */

/**
 * @param {{ log?: { warn?: Function, error?: Function } }} [opts]
 * @returns {{ every: (ms: number, fn: Function, opts?: { name?: string }) => (() => void),
 *   stopAll: () => void, list: () => Array<{ name: string, ms: number, runs: number, skipped: number, errors: number, running: boolean }> }}
 */
export function createScheduler(opts = {}) {
  const log = opts.log;
  const tasks = new Set();
  let seq = 0;

  /**
   * Run fn every ms milliseconds (first run after ms). Returns a cancel function.
   * @param {number} ms
   * @param {() => any} fn
   * @param {{ name?: string }} [o]
   */
  function every(ms, fn, o = {}) {
    if (!Number.isFinite(ms) || ms <= 0) throw new TypeError('every: ms must be a positive number');
    if (typeof fn !== 'function') throw new TypeError('every: fn must be a function');
    const task = { name: o.name ?? `task-${++seq}`, ms, runs: 0, skipped: 0, errors: 0, running: false, timer: null };
    const fail = (err) => {
      task.errors++;
      try { log?.error?.('scheduler task failed', { task: task.name, error: err }); } catch { /* ignore */ }
    };
    task.timer = setInterval(async () => {
      if (task.running) {
        task.skipped++;
        try { log?.warn?.('scheduler tick skipped (previous run in flight)', { task: task.name }); } catch { /* ignore */ }
        return;
      }
      task.running = true;
      task.runs++;
      try { await fn(); } catch (err) { fail(err); } finally { task.running = false; }
    }, ms);
    task.timer.unref();
    tasks.add(task);
    return () => { clearInterval(task.timer); tasks.delete(task); };
  }

  /** Cancel every scheduled task. */
  function stopAll() {
    for (const t of tasks) clearInterval(t.timer);
    tasks.clear();
  }

  function list() {
    return [...tasks].map(({ name, ms, runs, skipped, errors, running }) => ({ name, ms, runs, skipped, errors, running }));
  }

  return { every, stopAll, list };
}
