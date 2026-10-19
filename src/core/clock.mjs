/**
 * Injectable clock. Production uses real time; tests can pin and advance it.
 * @param {{ fixed?: Date|string|number }} [opts]
 */
export function createClock(opts = {}) {
  let offsetBase = null;
  if (opts.fixed !== undefined) offsetBase = new Date(opts.fixed).getTime();
  return {
    /** @returns {Date} */
    now() { return offsetBase === null ? new Date() : new Date(offsetBase); },
    /** @returns {string} ISO-8601 timestamp */
    nowIso() { return this.now().toISOString(); },
    /** Pin the clock to a time (tests). */
    set(date) { offsetBase = new Date(date).getTime(); },
    /** Advance a pinned clock by ms (pins at real now if not pinned). */
    advance(ms) { offsetBase = (offsetBase ?? Date.now()) + ms; },
    /** Return to real time. */
    reset() { offsetBase = null; },
  };
}
