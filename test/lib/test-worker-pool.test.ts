// ace#2955 — a pool worker's credentials come from its slot's data on
// canopy-web (owner directive 2026-10-15), never from env; plus the masking
// every report goes through, and the add-worker arithmetic.
import { describe, it, expect } from 'vitest';
import {
  LEGACY_SLOT,
  MASK,
  TestWorkerPoolError,
  legacyTestWorker,
  maskSecretsDeep,
  maskSlotData,
  maskWorker,
  missingSlotKeys,
  nextSlotName,
  nextWorkerPhone,
  planTestWorkerAdd,
  redactSecrets,
  workerFromSlotData,
  workerRecipeEnv,
} from '../../lib/test-worker-pool.js';
import { legacyEnv, slotDataFor } from '../fixtures/fake-canopy-pool.js';

function err(fn: () => unknown): TestWorkerPoolError {
  try {
    fn();
  } catch (e) {
    return e as TestWorkerPoolError;
  }
  throw new Error('expected a throw');
}

describe('workerFromSlotData', () => {
  it('maps complete slot data to a worker', () => {
    const d = slotDataFor('worker-3');
    expect(workerFromSlotData('worker-3', d)).toEqual({ slot: 'worker-3', ...d.public, ...d.secret });
  });

  it('no slot_data → TEST_WORKER_NO_CREDENTIALS naming the slot, every key, and the set command', () => {
    const e = err(() => workerFromSlotData('worker-2', null));
    expect(e.code).toBe('TEST_WORKER_NO_CREDENTIALS');
    expect(e.message).toContain('worker-2');
    expect(e.remediation).toContain('scripts/test-worker-set.ts --slot worker-2');
    expect(e.diagnostics?.missing).toEqual(missingSlotKeys([], []));
  });

  it('a missing key is named — and there is NO fallback to the shared ACE_E2E_PIN / ACE_E2E_BACKUP_CODE', () => {
    const d = slotDataFor('worker-2');
    delete (d.secret as Record<string, string>).pin;
    d.secret.backupCode = '  ';
    const e = err(() => workerFromSlotData('worker-2', d));
    expect(e.code).toBe('TEST_WORKER_NO_CREDENTIALS');
    expect(e.message).toContain('secret.pin');
    expect(e.message).toContain('secret.backupCode');
  });

  it('a missing public key is named too', () => {
    const d = slotDataFor('worker-2');
    delete (d.public as Record<string, string>).name;
    expect(err(() => workerFromSlotData('worker-2', d)).message).toContain('public.name');
  });

  it('validates the phone as today: +7426, E.164, countryCode + phoneLocal === phone', () => {
    const outside = slotDataFor('worker-2');
    outside.public.phone = '+15550001234';
    outside.public.phoneLocal = '5550001234';
    outside.public.countryCode = '+1';
    expect(err(() => workerFromSlotData('worker-2', outside)).code).toBe('TEST_WORKER_INVALID');
    const mismatch = slotDataFor('worker-2');
    mismatch.public.phoneLocal = '4260000299';
    expect(err(() => workerFromSlotData('worker-2', mismatch)).message).toMatch(/does not equal phone/);
  });

  it('no thrown message or remediation ever contains a secret value', () => {
    const d = slotDataFor('worker-4');
    d.public.phoneLocal = '4260000999'; // invalid → throws after reading secrets
    const e = err(() => workerFromSlotData('worker-4', d));
    for (const text of [e.message, e.remediation ?? '', JSON.stringify(e.diagnostics)]) {
      expect(text).not.toContain(d.secret.pin);
      expect(text).not.toContain(d.secret.backupCode);
    }
  });
});

describe('legacyTestWorker (rollout fallback only)', () => {
  it('is worker-1 from ACE_E2E_*', () => {
    expect(legacyTestWorker(legacyEnv())).toEqual({
      slot: LEGACY_SLOT,
      phone: '+74260000101',
      phoneLocal: '4260000101',
      countryCode: '+7',
      pin: '1234',
      backupCode: 'LEGACYBACKUP0001',
      name: 'ACE Test',
    });
  });

  it('null when unset or an unresolved op:// ref', () => {
    expect(legacyTestWorker({})).toBeNull();
    expect(legacyTestWorker({ ...legacyEnv(), ACE_E2E_PHONE: 'op://v/connect-test-user/phone' })).toBeNull();
  });

  it('names a missing field without echoing secrets', () => {
    const e = err(() => legacyTestWorker({ ...legacyEnv(), ACE_E2E_PIN: '' }));
    expect(e.message).toContain('ACE_E2E_PIN is missing');
    expect(e.message).not.toContain('LEGACYBACKUP0001');
  });
});

describe('masking', () => {
  it('maskWorker / maskSlotData hide secret values, keep keys and public data', () => {
    const d = slotDataFor('worker-2');
    const w = workerFromSlotData('worker-2', d);
    expect(maskWorker(w)).toEqual({ ...w, pin: MASK, backupCode: MASK });
    expect(maskSlotData(d)).toEqual({ public: d.public, secret: { pin: MASK, backupCode: MASK } });
    expect(maskSlotData(null)).toBeNull();
  });

  it('maskSecretsDeep masks anything under `secret` and any pin/backupCode key, at any depth', () => {
    const d = slotDataFor('worker-2');
    const out = JSON.stringify(maskSecretsDeep({ lease_id: 'L1', slot_data: d, nested: [{ backup_code: 'X1234' }], secret_keys: ['pin'] }));
    expect(out).not.toContain(d.secret.pin);
    expect(out).not.toContain(d.secret.backupCode);
    expect(out).not.toContain('X1234');
    expect(out).toContain(d.public.phone);
    expect(out).toContain('"secret_keys":["pin"]');
  });

  it('redactSecrets replaces every occurrence', () => {
    expect(redactSecrets('pin 9002 then 9002, code ABCDEF', ['9002', 'ABCDEF', '', null])).toBe('pin *** then ***, code ***');
  });
});

describe('workerRecipeEnv', () => {
  it('gives recipes the keys static palettes use', () => {
    const d = slotDataFor('worker-3');
    expect(workerRecipeEnv(workerFromSlotData('worker-3', d))).toEqual({
      PHONE: d.public.phone,
      PHONE_LOCAL: d.public.phoneLocal,
      COUNTRY_CODE: '+7',
      PIN: d.secret.pin,
      BACKUP_CODE: d.secret.backupCode,
      NAME: 'ACE Test 3',
    });
  });
});

describe('add-worker number + slot picker', () => {
  it('takes one past the highest pool number of the standard width', () => {
    expect(nextWorkerPhone(['+74260000100', '+74260000105'])).toBe('+74260000106');
  });

  it('skips numbers to avoid (retired workers keep their Connect accounts)', () => {
    expect(nextWorkerPhone(['+74260000100'], ['+74260000101', '+74260000102'])).toBe('+74260000103');
  });

  it('ignores numbers of another width or prefix, and starts at …0001 when there are none', () => {
    expect(nextWorkerPhone(['+1555000', '+742612'])).toBe('+74260000001');
    expect(nextWorkerPhone([])).toBe('+74260000001');
  });

  it('the result is a valid demo E.164 number', () => {
    expect(nextWorkerPhone(['+74260000100'])).toMatch(/^\+7426\d{7}$/);
  });

  it('next slot is one past every slot the pool or manifest knows', () => {
    expect(nextSlotName(['worker-1', 'worker-2'], ['worker-1', 'worker-4'])).toBe('worker-5');
    expect(nextSlotName([])).toBe('worker-1');
  });

  it('planTestWorkerAdd fills a declared-but-unbacked manifest slot first (initial bootstrap)', () => {
    const plan = planTestWorkerAdd({
      pool: [{ slot: 'worker-1', phone: '+74260000101' }],
      manifestSlots: ['worker-1', 'worker-2', 'worker-3', 'worker-4'],
    });
    expect(plan).toEqual({
      slot: 'worker-2',
      phone: '+74260000102',
      phoneLocal: '4260000102',
      countryCode: '+7',
      name: 'ACE Test 2',
    });
  });

  it('planTestWorkerAdd grows the pool when every manifest slot is backed', () => {
    const pool = ['worker-1', 'worker-2'].map((slot, i) => ({ slot, phone: `+7426000010${i + 1}` }));
    expect(planTestWorkerAdd({ pool, manifestSlots: ['worker-1', 'worker-2'] }).slot).toBe('worker-3');
  });
});
