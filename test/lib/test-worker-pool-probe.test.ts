// ace#2955 — the doctor signal that keeps the unlocked rollout fallback from
// persisting silently, and the manifest the lock is published from.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { classifyTestWorkerPool, probeTestWorkerPool } from '../../lib/test-worker-pool-probe.js';
import type { SlotDataReport } from '../../lib/test-worker-slots.js';
import { FakeCanopyPool } from '../fixtures/fake-canopy-pool.js';

const ROOT = join(__dirname, '..', '..');
const cap = (over: Record<string, unknown> = {}) => ({
  capabilities: [{ name: 'test-worker', manifest: { kind: 'pool', slots: ['worker-1', 'worker-2'] }, granted: true, live_leases: 1, ...over }],
});

const report = (over: Partial<SlotDataReport> = {}): SlotDataReport => ({
  ok: true,
  declared: ['worker-1', 'worker-2'],
  slots: [],
  summary: 'all 2 slot(s) carry phone, phoneLocal, countryCode, name, pin and backupCode',
  ...over,
});

describe('classifyTestWorkerPool', () => {
  it('WARNs naming the fallback and the publish step while the capability is unpublished', () => {
    const v = classifyTestWorkerPool({ hasToken: true, status: 200, body: { capabilities: [] } });
    expect(v.status).toBe('warn');
    expect(v.summary).toMatch(/NOT published.*UNLOCKED as the legacy ACE_E2E_\* worker.*ace#2955/);
    expect(v.remediation).toContain('canopy-runtime publish-capabilities --spec runtime.yaml --agent ace');
  });

  it('WARNs while published but ungranted, and still reports slot-data gaps', () => {
    const v = classifyTestWorkerPool({
      hasToken: true,
      status: 200,
      body: cap({ granted: false }),
      slots: report({ ok: false, summary: 'worker-2: no data' }),
    });
    expect(v.status).toBe('warn');
    expect(v.summary).toMatch(/NOT granted.*slot data: worker-2: no data/);
    expect(v.remediation).toContain('scripts/test-worker-set.ts');
  });

  it('WARNs when a declared slot lacks data or a required key', () => {
    const v = classifyTestWorkerPool({ hasToken: true, status: 200, body: cap(), slots: report({ ok: false, summary: 'worker-2: lacks secret.pin' }) });
    expect(v.status).toBe('warn');
    expect(v.summary).toMatch(/worker-2: lacks secret\.pin.*TEST_WORKER_NO_CREDENTIALS/);
  });

  it('PASSes when live, granted and every slot carries its data', () => {
    const v = classifyTestWorkerPool({ hasToken: true, status: 200, body: cap(), slots: report() });
    expect(v.status).toBe('pass');
    expect(v.summary).toMatch(/2 slot\(s\).*1 checked out/);
  });

  it('WARNs with no PAT', () => {
    expect(classifyTestWorkerPool({ hasToken: false }).summary).toMatch(/no CANOPY_WEB_PAT.*UNLOCKED/);
  });
});

describe('probeTestWorkerPool (against the fake canopy-web)', () => {
  function fetchWith(pool: FakeCanopyPool, capBody: unknown): typeof fetch {
    return async (input, init) => {
      const u = new URL(String(input));
      if (u.pathname === '/api/agents/ace/capabilities') {
        pool.calls.push(`GET ${u.pathname}`);
        return new Response(JSON.stringify(capBody), { status: 200 });
      }
      return pool.fetch(input, init);
    };
  }

  it('reads only the capability and the MASKED slot list — never acquires, never sees a secret', async () => {
    const pool = new FakeCanopyPool(['worker-1', 'worker-2']);
    delete (pool.slotData.get('worker-2')!.secret as Record<string, string>).backupCode;
    const v = await probeTestWorkerPool(fetchWith(pool, cap()), 'pat');
    expect(v.status).toBe('warn');
    expect(v.summary).toContain('worker-2: lacks secret.backupCode');
    expect(pool.calls).toEqual(['GET /api/agents/ace/capabilities', 'GET /api/agents/ace/capabilities/test-worker/slots']);
    const text = JSON.stringify(v);
    for (const d of pool.slotData.values()) for (const sec of Object.values(d.secret)) expect(text).not.toContain(sec);
  });

  it('PASSes on complete data', async () => {
    const pool = new FakeCanopyPool(['worker-1', 'worker-2']);
    expect((await probeTestWorkerPool(fetchWith(pool, cap()), 'pat')).status).toBe('pass');
  });

  it('a canopy-web without the slot routes yet WARNs that checkouts would fail', async () => {
    const pool = new FakeCanopyPool(['worker-1', 'worker-2']);
    pool.slotRoutes = false;
    const v = await probeTestWorkerPool(fetchWith(pool, cap()), 'pat');
    expect(v.status).toBe('warn');
    expect(v.summary).toMatch(/does not serve test-worker slot data yet/);
  });
});

describe('infra/capabilities/test-worker/capability.yaml', () => {
  const manifest = parse(readFileSync(join(ROOT, 'infra/capabilities/test-worker/capability.yaml'), 'utf8'));

  it('is the pool contract canopy-web is building', () => {
    expect(manifest).toMatchObject({ version: 1, name: 'test-worker', kind: 'pool' });
    expect(manifest.limits).toEqual({ max_lease_s: 14400, idle_release_s: 900 });
    expect(manifest.slots).toContain('worker-1');
    for (const s of manifest.slots) expect(s).toMatch(/^worker-\d+$/);
    expect(new Set(manifest.slots).size).toBe(manifest.slots.length);
  });

  it('is declared in runtime.yaml next to the emulator', () => {
    const runtime = parse(readFileSync(join(ROOT, 'runtime.yaml'), 'utf8'));
    const refs = runtime.capabilities.map((c: { manifest: string }) => c.manifest);
    expect(refs).toEqual([
      'infra/capabilities/android-emulator/capability.yaml',
      'infra/capabilities/test-worker/capability.yaml',
    ]);
  });

  it('declares worker-1..4 — the four workers signed up in PersonalID (+74260000101..104)', () => {
    expect(manifest.slots).toEqual(['worker-1', 'worker-2', 'worker-3', 'worker-4']);
  });

  it('pool credentials are canopy-web slot data, not env: no ACE_E2E_WORKERS / connect-test-workers anywhere', () => {
    for (const f of ['.env.tpl', 'runtime.yaml', 'skills/test-worker-pool/SKILL.md', 'infra/capabilities/test-worker/capability.yaml']) {
      const text = readFileSync(join(ROOT, f), 'utf8');
      expect(text, f).not.toMatch(/ACE_E2E_WORKERS|connect-test-workers|pool-json/);
    }
    // The per-run flag stays off: the owner chose the pool (ace#2955).
    expect(readFileSync(join(ROOT, '.env.tpl'), 'utf8')).not.toMatch(/^ACE_PER_RUN_TEST_USER=/m);
  });
});
