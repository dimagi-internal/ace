/**
 * The Phase 3 Nova app snapshot (ace#3132, P12): one read shared by every
 * checker. Pins (1) freshness never says "fresh" without proof, (2) the
 * snapshot hands back exactly what `get_form` returned, so no checker verdict
 * can change by reading it, (3) the lint verdict is identical from the
 * snapshot, and (4) every checker reads it while the named live read-backs
 * stay live — the "would fail if" of P12.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NovaAppBundle } from '../../lib/nova-app-bundle';
import { lintNovaApp } from '../../lib/nova-app-lint';
import {
  LIVE_READS,
  readAppUpdatedAt,
  snapshotForm,
  snapshotFreshness,
  snapshotOutline,
  stampSnapshot,
} from '../../lib/nova-app-snapshot';

const ROOT = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const fixture = (n: string): NovaAppBundle => JSON.parse(read(`test/fixtures/nova/lint/${n}.json`));

const T0 = '2026-10-22T04:49:35.379Z';
const stamped = (b: NovaAppBundle, updatedAt: string | null = T0, scope: 'saved' | 'work' = 'saved') =>
  stampSnapshot(b, { fetchedAt: '2026-10-23T17:22:21.098Z', updatedAt, scope });

describe('snapshotFreshness', () => {
  const b = fixture('kaduna-deliver-6dc21bc3');
  it('is fresh only when the live updated_at matches', () => {
    expect(snapshotFreshness(stamped(b), b.appId, T0)).toEqual({ state: 'fresh' });
    expect(snapshotFreshness(stamped(b), b.appId, '2026-10-23T00:00:00.000Z').state).toBe('stale');
  });
  it('never calls an unproven snapshot fresh', () => {
    expect(snapshotFreshness(b, b.appId, T0).state).toBe('unknown');
    expect(snapshotFreshness(stamped(b, null), b.appId, T0).state).toBe('unknown');
    expect(snapshotFreshness(stamped(b), b.appId, null).state).toBe('unknown');
  });
  it('a private-work, partial, or other-app snapshot is stale', () => {
    expect(snapshotFreshness(stamped(b, T0, 'work'), b.appId, T0).state).toBe('stale');
    expect(snapshotFreshness({ ...stamped(b), readErrors: ['get_form X: HTTP 429'] }, b.appId, T0).state).toBe('stale');
    expect(snapshotFreshness(stamped(b), 'other-app', T0).state).toBe('stale');
  });
});

describe('readAppUpdatedAt', () => {
  it('matches on app_id, not name (rebuilds share a name)', async () => {
    const call = async () => ({
      apps: [
        { app_id: 'old', name: 'X Learn app', updated_at: '2026-10-13T00:00:00Z' },
        { app_id: 'new', name: 'X Learn app', updated_at: '2026-10-15T00:00:00Z' },
      ],
    });
    expect(await readAppUpdatedAt('new', 'X Learn app', call)).toBe('2026-10-15T00:00:00Z');
    expect(await readAppUpdatedAt('gone', 'X Learn app', call)).toBeNull();
    expect(await readAppUpdatedAt('new', undefined, call)).toBeNull();
  });
});

describe('reading from the snapshot changes no verdict', () => {
  for (const name of ['kaduna-deliver-6dc21bc3', 'kaduna-learn-56057841', 'smallholder-deliver-199d63dc']) {
    it(`${name}: lint verdict and findings identical with snapshot metadata attached`, () => {
      const b = fixture(name);
      const type = name.includes('learn') ? 'learn' : 'deliver';
      expect(lintNovaApp(stamped(b), { appType: type })).toEqual(lintNovaApp(b, { appType: type }));
    });
  }

  it('--form returns the get_form response itself, by uuid or unique name', () => {
    const b = fixture('kaduna-deliver-6dc21bc3');
    const first = b.forms[0];
    expect(snapshotForm(b, first.formUuid)).toBe(first);
    const name = b.app.modules.flatMap((m: any) => m.forms).find((f: any) => f.uuid === first.formUuid).name;
    expect(snapshotForm(b, name.toUpperCase())).toBe(first);
    expect(() => snapshotForm(b, 'no such form')).toThrow(/no form/);
  });

  it('--outline covers every form in app order with its uuids', () => {
    const b = fixture('kaduna-deliver-6dc21bc3');
    const outline = snapshotOutline(b);
    const appForms = b.app.modules.flatMap((m: any) => m.forms.map((f: any) => f.uuid));
    expect(outline.map((o) => o.formUuid)).toEqual(appForms);
    expect(outline.every((o) => o.moduleUuid && o.fields >= 0)).toBe(true);
  });
});

describe('Phase 3 reads the snapshot; own-write read-backs stay live', () => {
  it('Step 1.4 writes the snapshot and hands it to the checkers', () => {
    const agent = read('agents/commcare-setup.md');
    const s14 = agent.slice(agent.indexOf('### Step 1.4'), agent.indexOf('### Step 1.5'));
    expect(s14).toContain('--snapshot-out');
    expect(s14).toContain('LIVE_READS');
    for (const step of ['### Step 1.5', '### Step 1.6', '### Step 1.7']) {
      const i = agent.indexOf(step);
      expect(agent.slice(i, agent.indexOf('\n### ', i + 5)), step).toContain('nova_snapshot');
    }
  });

  for (const p of [
    'skills/pdd-to-deliver-app-eval/SKILL.md',
    'skills/pdd-to-learn-app-eval/SKILL.md',
    'skills/app-connect-coverage/SKILL.md',
    'skills/app-media-coverage/SKILL.md',
  ]) {
    it(`${p} checks freshness before trusting the snapshot`, () => {
      const s = read(p);
      expect(s).toMatch(/scripts\/nova-app-snapshot\.ts"? --snapshot <nova_snapshot> --app <nova_app_id> --check/);
      expect(s).toMatch(/`FRESH`/);
    });
  }

  for (const { skill, step } of LIVE_READS) {
    it(`${skill} ${step} is named as a live read`, () => {
      const s = read(`skills/${skill}/SKILL.md`);
      expect(s).toMatch(new RegExp(`${step}[^\\n]*\\n?[^\\n]*stays live|${step}.{0,80}stays live`, 'i'));
      expect(s).toContain('LIVE_READS');
    });
  }

  it('the scripts the prose names exist and the lint writes a stamped snapshot', () => {
    expect(read('scripts/nova-app-snapshot.ts')).toContain('snapshotFreshness');
    const lint = read('scripts/nova-app-lint.ts');
    expect(lint).toContain("arg('snapshot-out')");
    expect(lint).toContain('stampSnapshot');
  });
});
