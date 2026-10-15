// ace#2955 — the doctor signal that keeps the unlocked rollout fallback from
// persisting silently, and the manifest the lock is published from.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { classifyTestWorkerPool } from '../../lib/test-worker-pool-probe.js';

const ROOT = join(__dirname, '..', '..');
const cap = (over: Record<string, unknown> = {}) => ({
  capabilities: [{ name: 'test-worker', manifest: { kind: 'pool', slots: ['worker-1', 'worker-2'] }, granted: true, live_leases: 1, ...over }],
});

describe('classifyTestWorkerPool', () => {
  it('WARNs naming the fallback and the publish step while the capability is unpublished', () => {
    const v = classifyTestWorkerPool({ hasToken: true, status: 200, body: { capabilities: [] }, localSlots: ['worker-1'] });
    expect(v.status).toBe('warn');
    expect(v.summary).toMatch(/NOT published.*UNLOCKED as worker-1.*ace#2955/);
    expect(v.remediation).toContain('canopy-runtime publish-capabilities --spec runtime.yaml --agent ace');
  });

  it('WARNs while published but ungranted', () => {
    const v = classifyTestWorkerPool({ hasToken: true, status: 200, body: cap({ granted: false }), localSlots: ['worker-1', 'worker-2'] });
    expect(v.status).toBe('warn');
    expect(v.summary).toMatch(/NOT granted/);
  });

  it('WARNs when the manifest declares a slot this machine has no credentials for', () => {
    const v = classifyTestWorkerPool({ hasToken: true, status: 200, body: cap(), localSlots: ['worker-1'] });
    expect(v.status).toBe('warn');
    expect(v.summary).toMatch(/no credentials for worker-2/);
  });

  it('PASSes when live, granted and fully backed', () => {
    const v = classifyTestWorkerPool({ hasToken: true, status: 200, body: cap(), localSlots: ['worker-1', 'worker-2'] });
    expect(v.status).toBe('pass');
    expect(v.summary).toMatch(/2 slot\(s\).*1 checked out/);
  });

  it('WARNs with no PAT, and on a broken local pool', () => {
    expect(classifyTestWorkerPool({ hasToken: false, localSlots: ['worker-1'] }).summary).toMatch(/no CANOPY_WEB_PAT.*UNLOCKED/);
    expect(classifyTestWorkerPool({ hasToken: true, status: 200, body: cap(), localSlots: 'bad json' }).summary).toMatch(/invalid/);
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

  it('the pool ref, once added (after its 1Password item exists — op inject is all-or-nothing), is the documented one', () => {
    const tpl = readFileSync(join(ROOT, '.env.tpl'), 'utf8');
    expect(tpl).toMatch(/item connect-test-workers, field pool-json/);
    const line = /^ACE_E2E_WORKERS=(.*)$/m.exec(tpl);
    if (line) expect(line[1]).toBe('op://${AGENT_VAULT}/connect-test-workers/pool-json');
    // The per-run flag stays off: the owner chose the pool (ace#2955).
    expect(tpl).not.toMatch(/^ACE_PER_RUN_TEST_USER=/m);
  });
});
