const REDACT = /name|email|phone|dob|address|ssn|license|plate/i;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Deep-copy a value replacing values of PII-looking keys with '[redacted]'. */
export function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[truncated]';
  if (value instanceof Error) return { message: value.message, code: value.code };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

/**
 * JSON-line logger with PII key redaction.
 * @param {{ level?: string, write?: (line: string) => void, clock?: object }} [opts]
 */
export function createLogger(opts = {}) {
  const threshold = LEVELS[opts.level ?? process.env.LOG_LEVEL ?? 'info'] ?? LEVELS.info;
  const write = opts.write ?? ((line) => process.stdout.write(line + '\n'));
  const emit = (level, msg, fields) => {
    if (LEVELS[level] < threshold) return;
    const at = opts.clock ? opts.clock.nowIso() : new Date().toISOString();
    write(JSON.stringify({ at, level, msg, ...(fields ? redact(fields) : {}) }));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}
