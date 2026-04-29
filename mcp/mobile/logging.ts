const TAG = 'ace-mobile';

export function logInfo(...args: unknown[]): void {
  process.stderr.write(`[${TAG}] ${args.map(stringify).join(' ')}\n`);
}

export function logDebug(...args: unknown[]): void {
  if (process.env.ACE_MOBILE_DEBUG) {
    process.stderr.write(`[${TAG}:debug] ${args.map(stringify).join(' ')}\n`);
  }
}

export function logError(...args: unknown[]): void {
  process.stderr.write(`[${TAG}:error] ${args.map(stringify).join(' ')}\n`);
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
