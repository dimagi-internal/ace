import { describe, it, expect } from 'vitest';
import { promptHash } from './multimedia-prompt-hash.js';

describe('promptHash', () => {
  it('returns the same hash for identical inputs', () => {
    const a = promptHash({ appContext: 'X', formText: 'Y', directive: 'Z' });
    const b = promptHash({ appContext: 'X', formText: 'Y', directive: 'Z' });
    expect(a).toBe(b);
  });

  it('returns a different hash when any field changes', () => {
    const base = { appContext: 'X', formText: 'Y', directive: 'Z' };
    const h = promptHash(base);
    expect(promptHash({ ...base, appContext: 'X2' })).not.toBe(h);
    expect(promptHash({ ...base, formText: 'Y2' })).not.toBe(h);
    expect(promptHash({ ...base, directive: 'Z2' })).not.toBe(h);
  });

  it('is whitespace-insensitive on leading/trailing whitespace', () => {
    const a = promptHash({ appContext: 'X', formText: 'Y', directive: 'Z' });
    const b = promptHash({ appContext: '  X  ', formText: '\nY\n', directive: ' Z ' });
    expect(a).toBe(b);
  });

  it('treats null/undefined directive as the same as empty string', () => {
    const a = promptHash({ appContext: 'X', formText: 'Y', directive: '' });
    const b = promptHash({ appContext: 'X', formText: 'Y', directive: null });
    const c = promptHash({ appContext: 'X', formText: 'Y', directive: undefined });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('returns a 64-char hex string (SHA-256)', () => {
    const h = promptHash({ appContext: 'X', formText: 'Y', directive: 'Z' });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
