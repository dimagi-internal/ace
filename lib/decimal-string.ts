/**
 * Exact arithmetic on the decimal strings labs uses for every quantity and
 * amount (`"38"`, `"38.00"`, `"-20"`).
 *
 * Labs refuses JSON numbers for money and writes the same value with and
 * without trailing zeros, so string equality calls `"38"` and `"38.00"`
 * different and float arithmetic drifts. These helpers scale to a BigInt at a
 * fixed precision instead. Used by the supply-chain QA checks.
 */

const SCALE = 6;
const DECIMAL = /^-?\d*\.?\d+$/;

export class DecimalStringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecimalStringError';
  }
}

/** A decimal string as an integer number of millionths. Refuses anything that is not a plain decimal. */
export function toScaled(value: string): bigint {
  const v = value.trim();
  if (!DECIMAL.test(v)) throw new DecimalStringError(`not a decimal string: ${JSON.stringify(value)}`);
  const neg = v.startsWith('-');
  const [whole, frac = ''] = (neg ? v.slice(1) : v).split('.');
  if (frac.length > SCALE) throw new DecimalStringError(`${value} has more than ${SCALE} decimal places`);
  const n = BigInt((whole || '0') + frac.padEnd(SCALE, '0'));
  return neg ? -n : n;
}

/** Back to a decimal string with trailing zeros removed (`"38"`, `"29.5"`, `"-20"`). */
export function fromScaled(n: bigint): string {
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().padStart(SCALE + 1, '0');
  const whole = s.slice(0, -SCALE);
  const frac = s.slice(-SCALE).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** -1, 0 or 1. */
export function decimalCompare(a: string, b: string): -1 | 0 | 1 {
  const x = toScaled(a);
  const y = toScaled(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function decimalEq(a: string, b: string): boolean {
  return decimalCompare(a, b) === 0;
}

export function decimalSum(values: readonly string[]): string {
  return fromScaled(values.reduce((t, v) => t + toScaled(v), 0n));
}

/**
 * Exact product, truncated toward zero at the fixed precision. Used for
 * value = quantity × unit price (e.g. 814 × 41500 = 33781000).
 */
export function decimalMul(a: string, b: string): string {
  const unit = 10n ** BigInt(SCALE);
  return fromScaled((toScaled(a) * toScaled(b)) / unit);
}
