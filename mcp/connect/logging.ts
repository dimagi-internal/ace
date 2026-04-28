import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface LogEntry {
  ts: string;
  atom: string;
  duration_ms: number;
  result: 'ok' | 'error';
  error_class?: string;
  error_message?: string;
}

export type LogFn = (entry: LogEntry) => void;

/**
 * Wraps a ConnectClient (or any object) in a Proxy that logs every method call.
 * Non-function properties pass through untouched.
 */
export function createLoggingProxy<T extends object>(target: T, log: LogFn): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const orig = Reflect.get(obj, prop, receiver);
      if (typeof orig !== 'function') return orig;

      return async (...args: unknown[]) => {
        const start = Date.now();
        const atom = String(prop);
        try {
          const result = await (orig as (...a: unknown[]) => Promise<unknown>).apply(obj, args);
          log({
            ts: new Date(start).toISOString(),
            atom,
            duration_ms: Date.now() - start,
            result: 'ok',
          });
          return result;
        } catch (err) {
          const e = err as Error;
          log({
            ts: new Date(start).toISOString(),
            atom,
            duration_ms: Date.now() - start,
            result: 'error',
            error_class: e.constructor?.name ?? 'Error',
            error_message: e.message,
          });
          throw err;
        }
      };
    },
  }) as T;
}

/**
 * Default logger: appends JSONL to ~/.ace/logs/connect-mcp.jsonl.
 * Silent on filesystem errors so logging failures never break atom calls.
 */
export function defaultFileLogger(): LogFn {
  const dir = path.join(os.homedir(), '.ace', 'logs');
  const file = path.join(dir, 'connect-mcp.jsonl');
  return (entry) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      // swallow
    }
  };
}
