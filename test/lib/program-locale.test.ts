import { describe, it, expect } from 'vitest';
import {
  COUNTRY_CURRENCY,
  normalizeCountry,
  currencyForCountry,
  checkProgramLocale,
  CONNECT_COUNTRY_NAME,
  connectCountryName,
} from '../../lib/program-locale';

/**
 * The regression this file pins is a LIVE one, not a hypothetical: on
 * 2026-09-16 seven of the eleven turmeric programs on `ai-demo-space` carried
 * `country: IND` with `currency: USD`, including the current
 * `b2ca75f6` (turmeric-market-study 2026). The operator's rule is that an
 * opportunity's amounts are always in its country's local currency.
 */
describe('normalizeCountry', () => {
  it('accepts alpha-3 unchanged', () => {
    expect(normalizeCountry('IND')).toBe('IND');
    expect(normalizeCountry('NGA')).toBe('NGA');
  });

  it('accepts alpha-2', () => {
    expect(normalizeCountry('IN')).toBe('IND');
    expect(normalizeCountry('NG')).toBe('NGA');
  });

  it('accepts the human names Connect renders, case- and punctuation-insensitive', () => {
    expect(normalizeCountry('India')).toBe('IND');
    expect(normalizeCountry('nigeria')).toBe('NGA');
    expect(normalizeCountry('United States of America')).toBe('USA');
    expect(normalizeCountry("Côte d'Ivoire")).toBe('CIV');
    expect(normalizeCountry('Viet Nam')).toBe('VNM');
  });

  it('returns null rather than guessing on an unknown or empty value', () => {
    expect(normalizeCountry('Wakanda')).toBeNull();
    expect(normalizeCountry('')).toBeNull();
    expect(normalizeCountry('   ')).toBeNull();
    expect(normalizeCountry(null)).toBeNull();
    expect(normalizeCountry(undefined)).toBeNull();
  });
});

describe('currencyForCountry', () => {
  it('derives the local currency', () => {
    expect(currencyForCountry('IND')).toBe('INR');
    expect(currencyForCountry('Nigeria')).toBe('NGN');
    expect(currencyForCountry('KEN')).toBe('KES');
    expect(currencyForCountry('USA')).toBe('USD');
  });

  it('NEVER falls back to USD on an unknown country', () => {
    expect(currencyForCountry('Wakanda')).toBeNull();
    expect(currencyForCountry(undefined)).toBeNull();
  });
});

describe('checkProgramLocale', () => {
  it('passes a coherent pair', () => {
    const v = checkProgramLocale({ country: 'NGA', currency: 'NGN' });
    expect(v.ok).toBe(true);
    expect(v.country).toBe('NGA');
    expect(v.expected).toBe('NGN');
    expect(v.detail).toBe('');
  });

  it('normalizes the country on the pass path too', () => {
    const v = checkProgramLocale({ country: 'India', currency: 'inr' });
    expect(v.ok).toBe(true);
    expect(v.country).toBe('IND');
  });

  it('REJECTS the live turmeric defect (IND + USD)', () => {
    const v = checkProgramLocale({ country: 'IND', currency: 'USD' });
    expect(v.ok).toBe(false);
    expect(v.expected).toBe('INR');
    expect(v.actual).toBe('USD');
    expect(v.detail).toContain('INR');
    // The remedy must say the fields are immutable after create — there is no
    // repair path, only a replacement program.
    expect(v.detail).toMatch(/cannot change country or currency/i);
  });

  it('rejects a missing currency instead of deriving one silently', () => {
    const v = checkProgramLocale({ country: 'NGA', currency: null });
    expect(v.ok).toBe(false);
    expect(v.expected).toBe('NGN');
    expect(v.detail).toContain('NGN');
  });

  it('rejects an unrecognised country WITHOUT proposing a currency', () => {
    const v = checkProgramLocale({ country: 'Wakanda', currency: 'USD' });
    expect(v.ok).toBe(false);
    expect(v.country).toBeNull();
    expect(v.expected).toBeNull();
    expect(v.detail).toMatch(/not a recognised/i);
    expect(v.detail).toMatch(/Do NOT default/i);
  });
});

describe('COUNTRY_CURRENCY table hygiene', () => {
  it('keys are alpha-3 and values are ISO-4217 shaped', () => {
    for (const [country, currency] of Object.entries(COUNTRY_CURRENCY)) {
      expect(country, `${country} is not alpha-3`).toMatch(/^[A-Z]{3}$/);
      expect(currency, `${currency} is not a 3-letter currency`).toMatch(/^[A-Z]{3}$/);
    }
  });

  it('every alias resolves to a country the table prices', () => {
    // Guards the failure mode where an alias is added but its target isn't:
    // normalizeCountry would return a key currencyForCountry then reads as
    // undefined, which is neither a clean halt nor a currency.
    for (const name of ['India', 'Nigeria', 'Kenya', 'Bangladesh', 'United Kingdom']) {
      const alpha3 = normalizeCountry(name)!;
      expect(alpha3, `${name} did not normalize`).not.toBeNull();
      expect(COUNTRY_CURRENCY[alpha3], `${alpha3} has no currency`).toBeTruthy();
    }
  });
});

/**
 * ace#2486: Connect's program-create serializer matches `country` on
 * `Country.name`, so alpha-3 is rejected ("Object with name=MWI does not
 * exist.") while "Malawi" succeeds — live, spark-facilitator/20260925-1536.
 */
describe('connectCountryName', () => {
  it('maps MWI to Malawi (the live-verified value)', () => {
    expect(connectCountryName('MWI')).toBe('Malawi');
  });

  it('covers exactly the COUNTRY_CURRENCY keys — a gated country always has a send value', () => {
    expect(Object.keys(CONNECT_COUNTRY_NAME).sort()).toEqual(Object.keys(COUNTRY_CURRENCY).sort());
    for (const alpha3 of Object.keys(COUNTRY_CURRENCY)) {
      expect(connectCountryName(alpha3), alpha3).toBeTruthy();
    }
  });

  it('never sends the alpha-3 code itself', () => {
    for (const [alpha3, name] of Object.entries(CONNECT_COUNTRY_NAME)) {
      expect(name, alpha3).not.toBe(alpha3);
    }
  });

  it('round-trips through normalizeCountry, so the gate and the send agree', () => {
    for (const [alpha3, name] of Object.entries(CONNECT_COUNTRY_NAME)) {
      expect(normalizeCountry(name), name).toBe(alpha3);
    }
  });

  it('returns null for an unknown or missing code — never a default', () => {
    expect(connectCountryName('XXX')).toBeNull();
    expect(connectCountryName('')).toBeNull();
    expect(connectCountryName(null)).toBeNull();
    expect(connectCountryName(undefined)).toBeNull();
  });

  it('tolerates case and whitespace on the alpha-3 input', () => {
    expect(connectCountryName(' mwi ')).toBe('Malawi');
  });
});
