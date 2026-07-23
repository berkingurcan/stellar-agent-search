/**
 * logger.ts — stderr-only structured logger.
 *
 * NON-NEGOTIABLE (INFRA-BLUEPRINT §7.3, threat T5): stdout carries ONLY
 * JSON-RPC. Every log line therefore goes to process.stderr as a single JSON
 * object. There is deliberately no console.log path here.
 */

import { systemClock, type Clock } from "./clock.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Structured fields attached to a log line. `requestId` is first-class. */
export interface LogFields {
  requestId?: string;
  tool?: string;
  durationMs?: number;
  status?: string;
  errorCode?: string;
  [key: string]: unknown;
}

export interface LoggerOptions {
  /** Minimum level to emit. Defaults to LOG_LEVEL env or "info". */
  level?: LogLevel;
  /** Base fields merged into every line (e.g. a bound requestId). */
  base?: LogFields;
  /** Injectable clock for deterministic timestamps in tests. */
  clock?: Clock;
  /** Sink for lines; defaults to process.stderr. Overridable in tests. */
  write?: (line: string) => void;
}

function envLevel(): LogLevel {
  const v = (process.env.LOG_LEVEL ?? "").trim().toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  return "info";
}

export class Logger {
  private readonly level: LogLevel;
  private readonly base: LogFields;
  private readonly clock: Clock;
  private readonly write: (line: string) => void;

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? envLevel();
    this.base = opts.base ?? {};
    this.clock = opts.clock ?? systemClock;
    this.write = opts.write ?? ((line) => process.stderr.write(line + "\n"));
  }

  /** Derive a child logger with additional bound fields (e.g. requestId). */
  child(fields: LogFields): Logger {
    return new Logger({
      level: this.level,
      base: { ...this.base, ...fields },
      clock: this.clock,
      write: this.write,
    });
  }

  /** Bind a requestId onto a child logger (convenience). */
  withRequestId(requestId: string): Logger {
    return this.child({ requestId });
  }

  private emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const line: Record<string, unknown> = {
      ts: this.clock.nowIso(),
      level,
      msg,
      ...this.base,
      ...fields,
    };
    let serialized: string;
    try {
      serialized = JSON.stringify(line);
    } catch {
      serialized = JSON.stringify({ ts: this.clock.nowIso(), level, msg, error: "unserializable log fields" });
    }
    this.write(serialized);
  }

  debug(msg: string, fields?: LogFields): void {
    this.emit("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.emit("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.emit("warn", msg, fields);
  }
  error(msg: string, fieldsOrErr?: LogFields | unknown): void {
    if (fieldsOrErr instanceof Error) {
      this.emit("error", msg, { error: fieldsOrErr.message, stack: fieldsOrErr.stack });
    } else {
      this.emit("error", msg, fieldsOrErr as LogFields | undefined);
    }
  }
}

/** Default process-wide logger. */
export const log = new Logger();

/** Factory for a fresh logger (tests / bound base fields). */
export function createLogger(opts: LoggerOptions = {}): Logger {
  return new Logger(opts);
}
