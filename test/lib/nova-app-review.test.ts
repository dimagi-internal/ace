/**
 * Phase 3 post-build app review (P12 / T71). Pins (1) each code check fires on
 * the real fixture shape it was written from and stays quiet where the app is
 * right, (2) every builder finding the code emits is a known, tracked catalog
 * item, so nothing new reaches commcare-nova without hal's §6 verification,
 * and (3) the review reads only the snapshot: no Nova client in the script.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NovaAppBundle } from '../../lib/nova-app-bundle';
import { LONG_LABEL, renderReview, reviewApp, reviewApps } from '../../lib/nova-app-review';

const ROOT = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const fixture = (n: string): NovaAppBundle => JSON.parse(read(`test/fixtures/nova/lint/${n}.json`));

const checks = (fs: { check: string }[]) => [...new Set(fs.map((f) => f.check))].sort();

/** A one-module, one-form bundle around the given fields. */
function bundle(fields: any[], opts: { caseType?: string; type?: string; caseOperations?: any[] } = {}): NovaAppBundle {
  const m = { uuid: 'm1', name: 'M', caseType: opts.caseType, forms: [{ uuid: 'f1', name: 'F', type: opts.type ?? 'survey' }] };
  return {
    appId: 'app-1',
    app: { name: 'T', modules: [m], languages: { available: [{ language: 'eng' }] } },
    modules: [{ uuid: 'm1', case_list_config: { columns: [], searchInputs: [] }, case_search_config: null }],
    forms: [{ moduleUuid: 'm1', formUuid: 'f1', form: { name: 'F', fields, caseOperations: opts.caseOperations } }],
    tables: {},
    readErrors: [],
  };
}

describe('real fixtures', () => {
  it('Kaduna Deliver: write-only child types, imported types, no search, other-twins', () => {
    const fs = reviewApp(fixture('kaduna-deliver-6dc21bc3'), 'deliver');
    expect(checks(fs)).toEqual(['case-list-no-search', 'case-type-never-created', 'case-type-never-opened', 'other-paired-text']);
    const neverOpened = fs.filter((f) => f.check === 'case-type-never-opened').map((f) => f.message.match(/"(\w+)"/)![1]).sort();
    expect(neverOpened).toEqual(['escalation', 'home_visit', 'round']);
  });

  it('Smallholder Deliver: a child type updated per roster row is NOT write-only', () => {
    const fs = reviewApp(fixture('smallholder-deliver-199d63dc'), 'deliver');
    const neverOpened = fs.filter((f) => f.check === 'case-type-never-opened').map((f) => f.message.match(/"(\w+)"/)![1]).sort();
    expect(neverOpened).toEqual(['harvest_cycle', 'session']);
    expect(fs.find((f) => f.check === 'hand-built-gps-accuracy')?.fields).toEqual(['gps_accuracy_m']);
  });

  it('Kaduna Learn: the 21-field hand-rolled scorer is the known §9-C item', () => {
    const fs = reviewApp(fixture('kaduna-learn-56057841'), 'learn');
    const s = fs.find((f) => f.check === 'hand-rolled-scoring');
    expect(s?.fields).toContain('user_score');
    expect(s?.knownIssue).toMatch(/commcare-nova\/issues\/372$/);
  });

  it('every code-emitted builder finding is already tracked, so nothing goes to Nova unverified', () => {
    for (const [n, kind] of [['kaduna-deliver-6dc21bc3', 'deliver'], ['kaduna-learn-56057841', 'learn'], ['smallholder-deliver-199d63dc', 'deliver']] as const) {
      const r = reviewApps({ [kind]: fixture(n) });
      for (const f of r.findings.filter((x) => x.layer === 'builder')) {
        expect(f.knownIssue, `${n} ${f.check}`).toBeTruthy();
        expect(f.category, `${n} ${f.check}`).toBeTruthy();
      }
      expect(r.forVerification).toEqual([]);
    }
  });

  it('renders the shape table and groups findings by layer', () => {
    const md = renderReview(reviewApps({ learn: fixture('kaduna-learn-56057841'), deliver: fixture('kaduna-deliver-6dc21bc3') }));
    expect(md).toContain('| deliver | Kaduna Graduation Deliver app | 7 | 7 |');
    expect(md.indexOf('### Builder (Nova)')).toBeLessThan(md.indexOf('### Brief (ACE)'));
  });
});

describe('synthetic shapes', () => {
  it('§2 long question, but a long teaching label is not a question', () => {
    const long = 'x'.repeat(LONG_LABEL + 1);
    const fs = reviewApp(bundle([
      { id: 'q', kind: 'text', label: long },
      { id: 'teach', kind: 'label', label: long },
    ]), 'deliver');
    expect(fs.find((f) => f.check === 'long-question')?.fields).toEqual(['q']);
  });

  it('§9-A inlined languages route to the brief', () => {
    const fs = reviewApp(bundle([{ id: 'd', kind: 'date', label: '**EN.** Date **Chichewa.** Tsiku' }]), 'deliver');
    expect(fs.find((f) => f.check === 'inlined-languages')?.layer).toBe('brief');
  });

  it('§4 self-attestation and module-as-scroll fire on Learn only', () => {
    const fields = [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `l${i}`, kind: 'label', label: 'teach' })),
      { id: 'done', kind: 'single_select', label: 'Have you read this module through?' },
    ];
    expect(checks(reviewApp(bundle(fields), 'learn'))).toEqual(['module-as-scroll', 'self-attestation']);
    expect(reviewApp(bundle(fields), 'deliver')).toEqual([]);
  });

  it('§3 a registration-only module is never opened', () => {
    const fs = reviewApp(bundle([{ id: 'n', kind: 'text', label: 'Name' }], { caseType: 'household', type: 'registration' }), 'deliver');
    expect(checks(fs)).toEqual(['case-type-never-opened']);
  });
});

describe('reads only the snapshot', () => {
  it('the CLI imports no Nova client', () => {
    const src = read('scripts/nova-app-review.ts');
    expect(src).not.toMatch(/nova-rpc|novaCall|withNovaRetry/);
  });

  it('the skill checks freshness once, reads forms from the snapshot, and never files on commcare-nova', () => {
    const skill = read('skills/app-review/SKILL.md');
    expect(skill).toContain('nova-app-snapshot.ts');
    expect(skill).toContain('--check');
    expect(skill).toContain('scripts/nova-app-review.ts');
    expect(skill).not.toMatch(/gh issue create[^\n]*commcare-nova/);
    expect(skill).toMatch(/hal/);
  });
});
