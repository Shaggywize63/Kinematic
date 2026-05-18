/**
 * Logger facade — wraps winston so call sites can use either order:
 *   logger.error('message', { context })   // winston-native
 *   logger.error({ context }, 'message')   // pino-native
 *
 * The integrations modules and a few newer services use the pino shape
 * (context first) because they were written by someone with a pino
 * muscle memory. Rather than touch ~20 call sites, the facade normalises
 * both shapes and serialises the context into the message before
 * handing to winston.
 *
 * Behavioural change vs. raw winston: structured metadata is appended
 * to the message as JSON instead of being attached as a separate `meta`
 * field. Output is still single-line and grep-friendly; downstream log
 * processors (Railway / log drains) treat each line as one record.
 */
import winston from 'winston';

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} [${level}]: ${stack || message}`;
});

const w = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports: [
    new winston.transports.Console({
      format: combine(colorize(), timestamp({ format: 'HH:mm:ss' }), logFormat),
    }),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); }
  catch { return '[unserialisable]'; }
}

/**
 * Normalise a (a, b?) pair from any of:
 *   logger.x('msg')
 *   logger.x('msg', { ctx })
 *   logger.x({ ctx }, 'msg')
 *   logger.x({ ctx })
 * into a single grep-friendly message string.
 */
function fmt(a: unknown, b?: unknown): string {
  // pino-style: context object first, message string second
  if (a !== null && typeof a === 'object' && typeof b === 'string') {
    return `${b} ${safeJson(a)}`;
  }
  // winston-native: string first, optional context second
  if (typeof a === 'string') {
    if (b === undefined) return a;
    if (b !== null && typeof b === 'object') return `${a} ${safeJson(b)}`;
    return `${a} ${String(b)}`;
  }
  // Single object — stringify
  if (a !== null && typeof a === 'object') return safeJson(a);
  return String(a);
}

export const logger = {
  info:  (a: unknown, b?: unknown) => { w.info(fmt(a, b)); },
  warn:  (a: unknown, b?: unknown) => { w.warn(fmt(a, b)); },
  error: (a: unknown, b?: unknown) => { w.error(fmt(a, b)); },
  debug: (a: unknown, b?: unknown) => { w.debug(fmt(a, b)); },
};
