/**
 * @hyperfleet/logger
 *
 * Structured logging with correlation IDs for request tracing
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  correlationId: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(context: Partial<LogContext>): Logger;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  correlationId: string;
  message: string;
  [key: string]: unknown;
}

/**
 * Create a structured logger with correlation ID support
 */
export function createLogger(context: LogContext): Logger {
  const formatLog = (
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>
  ): string => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      correlationId: context.correlationId,
      message,
      ...Object.fromEntries(
        Object.entries(context).filter(([key]) => key !== "correlationId")
      ),
      ...meta,
    };
    return JSON.stringify(entry);
  };

  return {
    debug: (msg, meta) => console.debug(formatLog("debug", msg, meta)),
    info: (msg, meta) => console.info(formatLog("info", msg, meta)),
    warn: (msg, meta) => console.warn(formatLog("warn", msg, meta)),
    error: (msg, meta) => console.error(formatLog("error", msg, meta)),
    child: (childContext) =>
      createLogger({ ...context, ...childContext } as LogContext),
  };
}

/**
 * Generate a unique correlation ID for request tracing
 */
export function generateCorrelationId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
