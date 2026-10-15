// ace#2955 — the test-worker pool's credential half and the add-worker arithmetic.
import { describe, it, expect } from 'vitest';
import {
  LEGACY_SLOT,
  POOL_ENV,
  TestWorkerPoolError,
  loadTestWorkerPool,
  nextSlotName,
  nextWorkerPhone,
  parsePoolJson,
  planTestWorkerAdd,
  resolveTestWorker,
  workerRecipeEnv,
} from '../../lib/test-worker-pool.js';
import { poolEnv } from '../fixtures/fake-canopy-pool.js';

const LEGACY = {
  ACE_E2E_PHONE: '+74260000100',
  ACE_E2E_PHONE_LOCAL: '4260000100',
  ACE_E2E_COUNTRY_CODE: '+7',
  ACE_E2E_PIN: '1234',
  ACE_E2E_BACKUP_CODE: '123456789012',
  ACE_E2E_NAME: 'ACE Test',
};

function err(fn: () => unknown): TestWorkerPoolError {
  try {
    fn();
  } catch (e) {
    return e as TestWorkerPoolError;
  }
  throw new Error('expected a throw');
}

describe('loadTestWorkerPool', () => {
  it('a single-worker setup (legacy ACE_E2E_* only) is exactly worker-1', () => {
    const pool = loadTestWorkerPool(LEGACY);
    expect([...pool.keys()]).toEqual([LEGACY_SLOT]);
    expect(pool.get(LEGACY_SLOT)).toEqual({
      slot: 'worker-1',
      phone: '+74260000100',
      phoneLocal: '4260000100',
      countryCode: '+7',
      pin: '1234',
      backupCode: '123456789012',
      name: 'ACE Test',
    });
  });

  it('an unresolved op:// pool ref reads as no pool, not as an error', () => {
    const pool = loadTestWorkerPool({ ...LEGACY, [POOL_ENV]: 'op://Agent-Ace/connect-test-workers/pool-json' });
    expect([...pool.keys()]).toEqual(['worker-1']);
  });

  it('reads the JSON pool, sorted naturally, with pin/backup/countryCode falling back to the legacy worker', () => {
    const env = {
      ...LEGACY,
      [POOL_ENV]: JSON.stringify({
        'worker-10': { phone: '+74260000110', phoneLocal: '4260000110' },
        'worker-2': { phone: '+74260000102', phone_local: '4260000102', name: 'Two', pin: '9999' },
      }),
    };
    const pool = loadTestWorkerPool(env);
    expect([...pool.keys()]).toEqual(['worker-1', 'worker-2', 'worker-10']);
    expect(pool.get('worker-2')).toMatchObject({ pin: '9999', backupCode: '123456789012', countryCode: '+7', name: 'Two' });
    expect(pool.get('worker-10')!.name).toBe('ACE Test 10');
  });

  it('a JSON worker-1 overrides the legacy vars', () => {
    const env = { ...LEGACY, [POOL_ENV]: JSON.stringify({ 'worker-1': { phone: '+74260000555', phoneLocal: '4260000555' } }) };
    expect(loadTestWorkerPool(env).get('worker-1')!.phone).toBe('+74260000555');
  });

  it('refuses a non-+7426 phone, naming the slot', () => {
    const e = err(() =>
      loadTestWorkerPool({ ...LEGACY, [POOL_ENV]: JSON.stringify({ 'worker-3': { phone: '+15550001234', phoneLocal: '5550001234' } }) }),
    );
    expect(e).toBeInstanceOf(TestWorkerPoolError);
    expect(e.code).toBe('TEST_WORKER_INVALID');
    expect(e.slot).toBe('worker-3');
    expect(e.message).toMatch(/worker-3.*\+7426/);
  });

  it('refuses a phone that is not E.164-shaped, naming the slot', () => {
    const e = err(() =>
      loadTestWorkerPool({ ...LEGACY, [POOL_ENV]: JSON.stringify({ 'worker-2': { phone: '+7426-000', phoneLocal: '426-000' } }) }),
    );
    expect(e.code).toBe('TEST_WORKER_INVALID');
    expect(e.message).toMatch(/worker-2.*E\.164/);
  });

  it('refuses countryCode + phoneLocal that does not spell the phone', () => {
    const e = err(() =>
      loadTestWorkerPool({ ...LEGACY, [POOL_ENV]: JSON.stringify({ 'worker-2': { phone: '+74260000102', phoneLocal: '4260000199' } }) }),
    );
    expect(e.slot).toBe('worker-2');
    expect(e.message).toMatch(/does not equal phone/);
  });

  it('refuses two slots on one phone (that would defeat the lock)', () => {
    const e = err(() =>
      loadTestWorkerPool({ ...LEGACY, [POOL_ENV]: JSON.stringify({ 'worker-2': { phone: '+74260000100', phoneLocal: '4260000100' } }) }),
    );
    expect(e.code).toBe('TEST_WORKER_DUPLICATE_PHONE');
  });

  it('refuses malformed JSON and bad slot names', () => {
    expect(err(() => parsePoolJson('{nope')).code).toBe('TEST_WORKER_POOL_MALFORMED');
    expect(err(() => parsePoolJson('[1]')).code).toBe('TEST_WORKER_POOL_MALFORMED');
    expect(err(() => parsePoolJson('{"alice": {}}')).code).toBe('TEST_WORKER_SLOT_NAME');
  });

  it('a missing pin with no legacy fallback fails loud', () => {
    const e = err(() => loadTestWorkerPool({ [POOL_ENV]: JSON.stringify({ 'worker-2': { phone: '+74260000102', phoneLocal: '4260000102' } }) }));
    expect(e.message).toMatch(/pin is missing/);
  });

  it('resolveTestWorker names an unknown slot and the slots it does have', () => {
    const e = err(() => resolveTestWorker('worker-7', poolEnv()));
    expect(e.code).toBe('TEST_WORKER_NO_CREDENTIALS');
    expect(e.message).toMatch(/worker-7.*worker-1, worker-2, worker-3, worker-4/);
  });

  it('workerRecipeEnv gives recipes the keys static palettes use', () => {
    const w = resolveTestWorker('worker-3', poolEnv());
    expect(workerRecipeEnv(w)).toEqual({
      PHONE: w.phone,
      PHONE_LOCAL: w.phoneLocal,
      COUNTRY_CODE: '+7',
      PIN: '1234',
      BACKUP_CODE: '123456789012',
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
