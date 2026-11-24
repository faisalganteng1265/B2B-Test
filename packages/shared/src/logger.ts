import pino, { type Logger } from 'pino';

export type { Logger };

export function createLogger(service: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}

/** Child logger carrying the correlation id (= deposit id / workflow id). */
export function withCorrelation(
  log: Logger,
  correlationId: string,
  extra: Record<string, unknown> = {},
): Logger {
  return log.child({ correlationId, ...extra });
}
