// ace#2955 — scripts/test-worker-set.ts stores a pool slot's data on canopy-web
// as ACE. Secrets come only from env vars or stdin, never argv, and never
// reach stdout/stderr.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SetArgsError, formatSlotTable, legacyEnv as readLegacyEnv, main, parseSetArgs } from '../../scripts/test-worker-set.js';
import { planFromSlots } from '../../scripts/test-worker-add.js';
import { classifySlotData, normalizeSlotList } from '../../lib/test-worker-slots.js';
import { FakeCanopyPool, legacyEnv, slotDataFor } from '../fixtures/fake-canopy-pool.js';

const PUB = ['--slot', 'worker-2', '--phone', '+74260000102', '--phone-local', '4260000102', '--country-code', '+7', '--name', 'ACE Test 2'];

function err(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a throw');
}

describe('parseSetArgs — secrets never on argv', () => {
  it.each([['--pin', '9002'], ['--pin=9002'], ['--backup-code', 'SECRET'], ['--backupCode=SECRET'], ['--secret', 'x']])(
    'refuses %s without echoing the value',
    (...a) => {
      const e = err(() => parseSetArgs([...PUB, ...a.filter(Boolean)], {}));
      expect(e).toBeInstanceOf(SetArgsError);
      expect(e.message).toMatch(/secrets never go on argv/);
      expect(e.message).not.toContain('9002');
      expect(e.message).not.toContain('SECRET');
    },
  );

  it('takes secrets from the env vars it is told to read', () => {
    const a = parseSetArgs([...PUB, '--pin-env', 'MY_PIN', '--backup-code-env', 'MY_BC'], { MY_PIN: '9002', MY_BC: 'BC-0002' });
    expect(a).toEqual({
      kind: 'put',
      slot: 'worker-2',
      dryRun: false,
      body: {
        public: { phone: '+74260000102', phoneLocal: '4260000102', countryCode: '+7', name: 'ACE Test 2' },
        secret: { pin: '9002', backupCode: 'BC-0002' },
      },
    });
  });

  it('an unset env var is named, not guessed', () => {
    expect(err(() => parseSetArgs([...PUB, '--pin-env', 'NOPE', '--backup-code-env', 'MY_BC'], { MY_BC: 'x' })).message).toMatch(/NOPE: that environment variable is unset/);
  });

  it('takes secrets as JSON on stdin', () => {
    const a = parseSetArgs([...PUB, '--secrets-stdin'], {}, '{"pin": "9002", "backup_code": "BC-0002"}');
    expect(a.kind === 'put' && a.body.secret).toEqual({ pin: '9002', backupCode: 'BC-0002' });
  });

  it('--secrets-from-legacy-env stores the legacy PIN + backup code as THIS slot\'s own', () => {
    const a = parseSetArgs([...PUB, '--secrets-from-legacy-env'], legacyEnv());
    expect(a.kind === 'put' && a.body.secret).toEqual({ pin: '1234', backupCode: 'LEGACYBACKUP0001' });
  });

  it('--from-legacy-env seeds worker-1 entirely from ACE_E2E_*', () => {
    expect(parseSetArgs(['--from-legacy-env'], legacyEnv())).toEqual({
      kind: 'put',
      slot: 'worker-1',
      dryRun: false,
      body: {
        public: { phone: '+74260000101', phoneLocal: '4260000101', countryCode: '+7', name: 'ACE Test' },
        secret: { pin: '1234', backupCode: 'LEGACYBACKUP0001' },
      },
    });
  });

  it('a full set needs all six keys and a sound identity; --partial updates some', () => {
    expect(err(() => parseSetArgs(PUB, {})).message).toMatch(/missing secret\.pin, secret\.backupCode/);
    const bad = PUB.map((x) => (x === '4260000102' ? '4260000199' : x));
    expect(err(() => parseSetArgs([...bad, '--secrets-from-legacy-env'], legacyEnv())).message).toMatch(/does not equal phone/);
    const p = parseSetArgs(['--slot', 'worker-2', '--partial', '--pin-env', 'P'], { P: '7777' });
    expect(p.kind === 'put' && p.body).toEqual({ public: {}, secret: { pin: '7777' } });
  });

  it('--list, --delete, and slot-name checks', () => {
    expect(parseSetArgs(['--list'], {})).toEqual({ kind: 'list' });
    expect(parseSetArgs(['--delete', '--slot', 'worker-3'], {})).toEqual({ kind: 'delete', slot: 'worker-3' });
    expect(err(() => parseSetArgs(['--slot', 'alice'], {})).message).toMatch(/worker-<n>/);
  });

  it('legacyEnv fills ACE_E2E_* from ACE\'s .env, keeping set process values', () => {
    const env = readLegacyEnv({ ACE_E2E_PIN: '1111' }, (k) => (k === 'ACE_E2E_PHONE' ? '+74260000101' : k === 'ACE_E2E_PIN' ? '9999' : null));
    expect(env.ACE_E2E_PHONE).toBe('+74260000101');
    expect(env.ACE_E2E_PIN).toBe('1111');
  });
});

describe('main — against the fake canopy-web', () => {
  let out: string[];
  const prevEnvFile = process.env.ACE_ENV_FILE;
  beforeEach(() => {
    out = [];
    process.env.ACE_ENV_FILE = '/nonexistent/ace.env'; // never read the real machine's .env
    vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => void out.push(a.join(' ')));
    process.env.TWS_PIN = '9002';
    process.env.TWS_BC = 'BC-SECRET-0002';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (prevEnvFile === undefined) delete process.env.ACE_ENV_FILE;
    else process.env.ACE_ENV_FILE = prevEnvFile;
    delete process.env.TWS_PIN;
    delete process.env.TWS_BC;
  });

  const run = (pool: FakeCanopyPool, argv: string[]) =>
    main(argv, pool.fetch, 'pat');

  it('PUTs the slot as ACE and prints only the masked answer', async () => {
    const pool = new FakeCanopyPool(['worker-1']);
    expect(await run(pool, [...PUB, '--pin-env', 'TWS_PIN', '--backup-code-env', 'TWS_BC'])).toBe(0);
    expect(pool.calls).toEqual(['PUT /api/agents/ace/capabilities/test-worker/slots/worker-2']);
    expect(pool.puts[0].body).toEqual({
      public: { phone: '+74260000102', phoneLocal: '4260000102', countryCode: '+7', name: 'ACE Test 2' },
      secret: { pin: '9002', backupCode: 'BC-SECRET-0002' },
    });
    const text = out.join('\n');
    expect(text).toContain('"secret_keys"');
    expect(text).not.toContain('9002');
    expect(text).not.toContain('BC-SECRET-0002');
  });

  it('--dry-run sends nothing and prints the request masked', async () => {
    const pool = new FakeCanopyPool(['worker-1']);
    expect(await run(pool, [...PUB, '--pin-env', 'TWS_PIN', '--backup-code-env', 'TWS_BC', '--dry-run'])).toBe(0);
    expect(pool.calls).toEqual([]);
    expect(out.join('\n')).toContain('"pin": "***"');
    expect(out.join('\n')).not.toContain('BC-SECRET-0002');
  });

  it('a server error that echoes the input is redacted', async () => {
    const pool = new FakeCanopyPool(['worker-1']);
    const echoing: typeof fetch = async () =>
      new Response(
        JSON.stringify({ title: 'Validation failed', detail: 'bad', errors: [{ input: 'BC-SECRET-0002' }], extras: { errors: [{ input: '9002' }] } }),
        { status: 422 },
      );
    expect(await main([...PUB, '--pin-env', 'TWS_PIN', '--backup-code-env', 'TWS_BC'], echoing, 'pat')).toBe(1);
    const text = out.join('\n');
    expect(text).toMatch(/test-worker-set:/);
    expect(text).not.toContain('9002');
    expect(text).not.toContain('BC-SECRET-0002');
    void pool;
  });

  it('argv secrets exit 2 before any HTTP', async () => {
    const pool = new FakeCanopyPool(['worker-1']);
    expect(await run(pool, [...PUB, '--pin', '9002'])).toBe(2);
    expect(pool.calls).toEqual([]);
    expect(out.join('\n')).not.toContain('9002');
  });

  it('--list prints the masked table and flags slots lacking data', async () => {
    const pool = new FakeCanopyPool(['worker-1', 'worker-2', 'worker-3']);
    pool.slotData.delete('worker-3');
    expect(await run(pool, ['--list'])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('worker-1   +74260000201');
    expect(text).toMatch(/worker-3 .*!! lacks public\.phone/);
    for (const d of pool.slotData.values()) for (const s of Object.values(d.secret)) expect(text).not.toContain(s);
  });

  it('--delete removes the slot data', async () => {
    const pool = new FakeCanopyPool(['worker-1', 'worker-2']);
    expect(await run(pool, ['--delete', '--slot', 'worker-2'])).toBe(0);
    expect(pool.slotData.has('worker-2')).toBe(false);
  });
});

describe('slot list classification + add planner', () => {
  const rows = (pool: FakeCanopyPool) =>
    normalizeSlotList({
      slots: [...pool.slotData.entries()].map(([slot, d]) => ({ slot, public: d.public, secret_keys: Object.keys(d.secret) })),
    });

  it('normalizeSlotList drops secret VALUES even if a server sent them', () => {
    const r = normalizeSlotList({ slots: [{ slot: 'worker-2', public: { phone: '+74260000102' }, secret: { pin: '9002' } }] });
    expect(r[0].secretKeys).toEqual(['pin']);
    expect(JSON.stringify(r)).not.toContain('9002');
  });

  it('classifySlotData flags absent slots, missing keys, bad identities and shared phones', () => {
    const pool = new FakeCanopyPool(['worker-1', 'worker-2', 'worker-3']);
    pool.slotData.get('worker-3')!.public.phone = slotDataFor('worker-1').public.phone;
    pool.slotData.get('worker-3')!.public.phoneLocal = slotDataFor('worker-1').public.phoneLocal;
    const r = classifySlotData(['worker-1', 'worker-2', 'worker-3', 'worker-4'], rows(pool));
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('worker-3: shares phone +74260000201 with worker-1');
    expect(r.summary).toContain('worker-4: no data');
    expect(classifySlotData(['worker-1', 'worker-2'], rows(pool)).ok).toBe(true);
  });

  it('planFromSlots fills the first declared slot without data, past every known number', () => {
    const r = normalizeSlotList({
      slots: [
        { slot: 'worker-1', public: { phone: '+74260000101' }, secret_keys: ['pin', 'backupCode'] },
        { slot: 'worker-2', public: { phone: '+74260000102' }, secret_keys: ['pin', 'backupCode'] },
      ],
    });
    expect(planFromSlots({ rows: r, manifestSlots: ['worker-1', 'worker-2', 'worker-3', 'worker-4'] })).toMatchObject({
      slot: 'worker-3',
      phone: '+74260000103',
    });
  });

  it('planFromSlots counts the legacy worker as worker-1 until its data is stored', () => {
    expect(planFromSlots({ rows: [], manifestSlots: ['worker-1'], legacyPhone: '+74260000101' })).toMatchObject({
      slot: 'worker-2',
      phone: '+74260000102',
    });
  });
});
