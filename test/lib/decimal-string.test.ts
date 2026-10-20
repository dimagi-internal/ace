import { describe, expect, it } from 'vitest';
import { DecimalStringError, decimalCompare, decimalEq, decimalMul, decimalSum, fromScaled, toScaled } from '../../lib/decimal-string';

describe('decimal strings as labs writes them', () => {
  it('"38" and "38.00" are one value; 29.5 vs 29.50 too', () => {
    expect(decimalEq('38', '38.00')).toBe(true);
    expect(decimalEq('29.5', '29.50')).toBe(true);
    expect(decimalEq('38', '38.01')).toBe(false);
  });

  it('compares signed values (labs over_invoiced is "-20" when nothing is billed)', () => {
    expect(decimalCompare('-20', '0')).toBe(-1);
    expect(decimalCompare('0', '0.000')).toBe(0);
    expect(decimalCompare('760', '759.999999')).toBe(1);
  });

  it('sums exactly where floats would drift', () => {
    expect(decimalSum(['0.1', '0.2'])).toBe('0.3');
    expect(decimalSum(['20', '0', '1.5'])).toBe('21.5');
    expect(decimalSum([])).toBe('0');
  });

  it('round-trips and refuses what is not a plain decimal', () => {
    expect(fromScaled(toScaled('-12.50'))).toBe('-12.5');
    expect(() => toScaled('12,50')).toThrow(DecimalStringError);
    expect(() => toScaled('1e3')).toThrow(DecimalStringError);
    expect(() => toScaled('0.1234567')).toThrow(DecimalStringError);
  });

  it('multiplies exactly (value arrived = received x unit price, labs contract 323)', () => {
    expect(decimalMul('814', '41500')).toBe('33781000');
    expect(decimalMul('20', '38.00')).toBe('760');
    expect(decimalMul('2.5', '0.1')).toBe('0.25');
    expect(decimalMul('-3', '1.5')).toBe('-4.5');
  });
});
