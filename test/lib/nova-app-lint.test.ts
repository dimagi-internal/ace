/**
 * `lib/nova-app-lint.ts` — the deterministic Phase 3 gate.
 *
 * Fixtures are REAL Nova blueprints read by `fetchNovaAppBundle` on
 * 2026-10-16 (provenance inside each file). Positive controls lint the apps
 * as they shipped; every negative control re-applies a defect state that a
 * real run recorded, quoted from the issue or transcript that recorded it.
 * Calibration (not a test, recorded for the reader): the same lint read live
 * against six other shipped apps (Spark Facilitator, Newborn Care, Turmeric
 * Deliver; Smallholder Learn; the full Kaduna + Smallholder Deliver) returned
 * PASS with zero findings — no false positive on a released app.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NovaAppBundle } from '../../lib/nova-app-bundle';
import { fetchNovaAppBundle, boundTableIds } from '../../lib/nova-app-bundle';
import {
  evalRerunNeeded,
  formatNovaAppLint,
  lintNovaApp,
  LINT_RULES,
  repairWarranted,
} from '../../lib/nova-app-lint';
import { withNovaRetry } from '../../scripts/nova-app-lint';

const FIX = join(__dirname, '../fixtures/nova/lint');
const load = (name: string): NovaAppBundle => JSON.parse(readFileSync(join(FIX, name), 'utf8'));
const kadLearn = () => load('kaduna-learn-56057841.json');
const kadDeliver = () => load('kaduna-deliver-6dc21bc3.json');
const shDeliver = () => load('smallholder-deliver-199d63dc.json');

type J = Record<string, any>;
function allFields(b: NovaAppBundle): J[] {
  const out: J[] = [];
  const walk = (fs: J[] | undefined) => (fs ?? []).forEach((f) => (out.push(f), walk(f.children)));
  b.forms.forEach((fr) => walk(fr.form.fields));
  return out;
}
const tableNamed = (b: NovaAppBundle, name: string) => Object.values(b.tables).find((t) => t.name === name)!;
const colId = (b: NovaAppBundle, table: string, wire: string) =>
  tableNamed(b, table).columns.find((c) => c.wireName === wire)!.id;
const byRule = (r: ReturnType<typeof lintNovaApp>, rule: string) => r.findings.filter((f) => f.rule === rule);

describe('nova-app-lint — every rule reports, none silently skipped', () => {
  it('a result carries exactly one check per rule, in order', () => {
    const r = lintNovaApp(shDeliver(), { appType: 'deliver' });
    expect(r.checks.map((c) => c.rule)).toEqual([...LINT_RULES]);
  });
});

describe('positive controls — apps as they shipped', () => {
  it('smallholder Deliver (after its 3 eval passes) lints PASS', () => {
    const r = lintNovaApp(shDeliver(), { appType: 'deliver' });
    expect(r.verdict).toBe('pass');
    expect(r.gateOpen).toBe(true);
    expect(r.checks.find((c) => c.rule === 'lookup-binds')).toMatchObject({ status: 'checked', findings: 0 });
  });

  it('kaduna Deliver (after repair) has no blocker; its one warn is the trimmed-out writer', () => {
    const r = lintNovaApp(kadDeliver(), { appType: 'deliver' });
    expect(r.blockers).toBe(0);
    expect(r.verdict).toBe('warn');
    expect(r.gateOpen).toBe(true);
    // Enrollment visit (the only writer of current_status = 'enrolled') was
    // dropped from the fixture for size: the missing-writer control, for free.
    expect(byRule(r, 'case-list-label-fidelity')).toHaveLength(1);
    expect(byRule(r, 'case-list-label-fidelity')[0].message).toContain('"enrolled"');
    // One finding for one drift, however many case lists render the property.
    expect(byRule(r, 'case-list-label-fidelity')[0].location.split('; ').length).toBeGreaterThan(1);
  });
});

describe('ace#3036 — role-gated Learn app (real, still gated at capture)', () => {
  it('blocks all 14 learn_module forms: 9 FLW-gated, 5 enumerator-gated', () => {
    const r = lintNovaApp(kadLearn(), { appType: 'learn' });
    expect(r.verdict).toBe('fail');
    expect(r.gateOpen).toBe(false);
    const g = byRule(r, 'learn-display-gating');
    expect(g).toHaveLength(14);
    expect(g.every((f) => f.severity === 'blocker')).toBe(true);
    expect(g.filter((f) => f.message.includes("'FLW'"))).toHaveLength(9);
    expect(g.filter((f) => f.message.includes("'enumerator'"))).toHaveLength(5);
  });

  it('removing the module gates opens the gate (the fix PR #3050 prescribes)', () => {
    const b = kadLearn();
    for (const m of b.modules) m.display_condition = null;
    const r = lintNovaApp(b, { appType: 'learn' });
    expect(byRule(r, 'learn-display-gating')).toHaveLength(0);
    expect(r.gateOpen).toBe(true);
  });

  it('a non-user display condition is a warn, not a blocker', () => {
    const b = kadLearn();
    for (const m of b.modules) m.display_condition = null;
    b.modules[1].display_condition = "today() > date('2026-01-01')";
    const r = lintNovaApp(b, { appType: 'learn' });
    const g = byRule(r, 'learn-display-gating');
    expect(g.length).toBeGreaterThan(0);
    expect(g.every((f) => f.severity === 'warn')).toBe(true);
  });

  it('two assessment forms is a blocker (ace#1131/#1205 any-passed semantics)', () => {
    const b = kadLearn();
    for (const m of b.modules) m.display_condition = null;
    const lm = b.forms.find((fr) => fr.form.connect?.learn_module)!;
    lm.form.connect.assessment = { id: 'pre', user_score: '#form/pre_score' };
    const r = lintNovaApp(b, { appType: 'learn' });
    expect(byRule(r, 'connect-markers').some((f) => f.message.includes('2 forms carry connect.assessment'))).toBe(true);
  });

  it('a form whose post-submit is not "previous" is a blocker', () => {
    const b = kadLearn();
    for (const m of b.modules) m.display_condition = null;
    b.forms[2].form.postSubmit = 'module';
    expect(byRule(lintNovaApp(b, { appType: 'learn' }), 'learn-form-navigation')).toHaveLength(1);
  });
});

describe('ace#2976 — banned word in bound lookup rows (smallholder)', () => {
  it('7 curriculum titles "… module N — PLACEHOLDER" are 7 terminology blockers', () => {
    const b = shDeliver();
    const t = tableNamed(b, 'SS3 Curriculum');
    const title = colId(b, 'SS3 Curriculum', 'title');
    t.rows.slice(0, 7).forEach((row, i) => {
      row.cells!.find((c) => c!.columnId === title)!.value = `Coaching module ${(i % 3) + 1} — PLACEHOLDER`;
    });
    const r = lintNovaApp(b, { appType: 'deliver' });
    const hits = byRule(r, 'terminology');
    expect(hits).toHaveLength(7);
    expect(hits.every((f) => f.severity === 'blocker' && f.location.includes('SS3 Curriculum'))).toBe(true);
    expect(r.verdict).toBe('fail');
  });

  it('"section"/"module" in a form name, label and choice is caught; Learn is exempt', () => {
    const b = shDeliver();
    allFields(b).find((f) => f.kind === 'text' || f.kind === 'single_select')!.label = 'Section A: who is here';
    b.app.modules[0].forms[0].name = 'Module 2 session';
    expect(byRule(lintNovaApp(b, { appType: 'deliver' }), 'terminology').length).toBeGreaterThanOrEqual(2);
    const learn = kadLearn();
    learn.forms[1].form.fields[0].label = 'This module teaches consent';
    expect(byRule(lintNovaApp(learn, { appType: 'learn' }), 'terminology')).toHaveLength(0);
  });

  it('a {{reference}} named like the word is not displayed text', () => {
    const b = shDeliver();
    b.forms[0].form.fields[0].label = 'Hello {{#form/module_id}}';
    expect(byRule(lintNovaApp(b, { appType: 'deliver' }), 'terminology')).toHaveLength(0);
  });
});

describe('ace#2978 — rows wiped by a partial edit_lookup_rows update (smallholder)', () => {
  it('8 rows left holding only `title` → value-column blocker + wiped-row warns', () => {
    const b = shDeliver();
    const t = tableNamed(b, 'SS3 Curriculum');
    const title = colId(b, 'SS3 Curriculum', 'title');
    for (const row of t.rows.slice(4, 12)) {
      for (const c of row.cells!) if (c!.columnId !== title) c!.value = '';
    }
    const r = lintNovaApp(b, { appType: 'deliver' });
    // 8 blank values are also 8 copies of "" — either code names the wipe.
    expect(byRule(r, 'lookup-binds').some((f) => /^\[(blank|duplicate)-values\]/.test(f.message))).toBe(true);
    expect(byRule(r, 'lookup-wiped-rows')).toHaveLength(8);
    expect(r.verdict).toBe('fail');
  });
});

describe('ace#2984 — whitespace in the saved value column (kaduna kgrad_services)', () => {
  it('binding `name` ("Placeholder: services directory entry 1 …") as the value is a blocker', () => {
    const b = kadDeliver();
    const t = tableNamed(b, 'kgrad_services');
    const name = colId(b, 'kgrad_services', 'name');
    t.rows.forEach((row, i) => {
      row.cells!.find((c) => c!.columnId === name)!.value =
        `Placeholder: services directory entry ${i + 1} (LLO and Dimagi to supply)`;
    });
    for (const f of allFields(b)) {
      if (f.optionsSource?.tableId === t.tableId) f.optionsSource.valueColumnId = name;
    }
    const r = lintNovaApp(b, { appType: 'deliver' });
    const w = byRule(r, 'lookup-binds').filter((f) => f.message.startsWith('[whitespace-values]'));
    expect(w).toHaveLength(3); // service, service_where, service_contact — the three binds in the issue
    expect(r.gateOpen).toBe(false);
  });
});

describe('case-list label vs form label (kaduna, caught only at Step 2.8 on the run)', () => {
  it('the released-CCZ drift — Completed / Not found / Refused — is 3 label-mismatch blockers', () => {
    const b = kadDeliver();
    const mod = b.modules.find((m) => m.name === 'Eligibility visit')!;
    const col = mod.case_list_config.columns.find((c: J) => c.field === 'eligibility_outcome');
    col.mapping = [
      { value: 'completed', label: 'Completed' },
      { value: 'not_found', label: 'Not found' },
      { value: 'refused', label: 'Refused' },
    ];
    const r = lintNovaApp(b, { appType: 'deliver' });
    const drift = byRule(r, 'case-list-label-fidelity').filter((f) => f.severity === 'blocker');
    expect(drift).toHaveLength(3);
    expect(drift[0].message).toContain('Found: the visit goes ahead');
  });
});

describe('casedb prefill (ace#2006) from the blueprint declaration', () => {
  it('a visible question listed in answerWrites.preloadedAnswers is a blocker; allowPreload honours it', () => {
    const b = kadDeliver();
    const fr = b.forms.find((x) => (x.answerWrites ?? []).length > 0)!;
    const visible = allFields({ ...b, forms: [fr] } as NovaAppBundle).find((f) => f.kind === 'single_select')!;
    fr.answerWrites[0].preloadedAnswers.push(visible.uuid);
    const r = lintNovaApp(b, { appType: 'deliver' });
    expect(byRule(r, 'casedb-prefill')).toHaveLength(1);
    const allowed = lintNovaApp(b, { appType: 'deliver', allowPreload: [visible.id] });
    expect(byRule(allowed, 'casedb-prefill')).toHaveLength(0);
  });
});

describe('structural rules', () => {
  it('app name without "Deliver app" is a blocker', () => {
    const b = shDeliver();
    b.app.name = 'Smallholder Seasonal v0.3';
    expect(byRule(lintNovaApp(b, { appType: 'deliver' }), 'app-name')).toHaveLength(1);
  });

  it('a Deliver app with no deliver_unit, or two forms sharing an id, is blocked', () => {
    const b = kadDeliver();
    const du = b.forms.filter((fr) => fr.form.connect?.deliver_unit);
    expect(du.length).toBeGreaterThan(1);
    du[1].form.connect.deliver_unit.id = du[0].form.connect.deliver_unit.id;
    du[0].form.connect.deliver_unit.entity_id = '';
    const m = byRule(lintNovaApp(b, { appType: 'deliver' }), 'connect-markers');
    expect(m.some((f) => f.message.includes('declared by 2 forms'))).toBe(true);
    expect(m.some((f) => f.message.includes('empty entity_id'))).toBe(true);
    for (const fr of b.forms) delete fr.form.connect;
    expect(byRule(lintNovaApp(b, { appType: 'deliver' }), 'connect-markers')[0].message).toContain('zero deliver units');
  });

  it('the wrong connect type is a blocker', () => {
    expect(byRule(lintNovaApp(shDeliver(), { appType: 'learn' }), 'connect-type')).toHaveLength(1);
  });

  it("Nova's seeded starter module is a blocker", () => {
    const b = shDeliver();
    b.app.modules.push({ uuid: 'seed-m', name: 'Survey', forms: [{ uuid: 'seed-f', name: 'Survey' }] });
    b.forms.push({ moduleUuid: 'seed-m', formUuid: 'seed-f', form: { id: 'survey', name: 'Survey', fields: [{ uuid: 'q', id: 'question_1', label: 'Question 1', kind: 'text' }] } });
    expect(byRule(lintNovaApp(b, { appType: 'deliver' }), 'starter-module')[0].severity).toBe('blocker');
  });
});

describe('unable is never a pass', () => {
  it('a partially read bound table makes the verdict incomplete and closes the gate', () => {
    const b = shDeliver();
    tableNamed(b, 'SS3 Curriculum').complete = false;
    const r = lintNovaApp(b, { appType: 'deliver' });
    expect(['incomplete', 'fail']).toContain(r.verdict);
    expect(r.gateOpen).toBe(false);
  });

  it('a read error is incomplete, and the report says NOT a pass', () => {
    const b = shDeliver();
    b.readErrors = ['get_form Group session: HTTP 500'];
    const r = lintNovaApp(b, { appType: 'deliver' });
    expect(r.verdict).toBe('incomplete');
    expect(formatNovaAppLint(r)).toContain('NOT a pass');
  });

  it('no app type anywhere is incomplete', () => {
    const b = shDeliver();
    delete b.app.connect;
    expect(lintNovaApp(b).verdict).toBe('incomplete');
  });
});

describe('repair policy helpers', () => {
  it('never repair on a warn', () => {
    expect(repairWarranted({ lintVerdict: 'warn', evalVerdict: 'warn' })).toBe(false);
    expect(repairWarranted({ lintVerdict: 'pass', evalVerdict: 'pass' })).toBe(false);
    expect(repairWarranted({ lintVerdict: 'fail' })).toBe(true);
    expect(repairWarranted({ lintVerdict: 'pass', evalVerdict: 'fail' })).toBe(true);
    expect(repairWarranted({ lintVerdict: 'incomplete' })).toBe(true);
  });

  it('a repair confined to lint-covered surfaces re-lints instead of re-running the eval', () => {
    expect(evalRerunNeeded({ touchedSurfaces: ['lookup-rows', 'choice-label'] })).toBe(false);
    expect(evalRerunNeeded({ touchedSurfaces: ['lookup-rows', 'new-field'] })).toBe(true);
    expect(evalRerunNeeded({ touchedSurfaces: ['lookup-rows'], evalBlockersOutsideLint: 1 })).toBe(true);
  });
});

describe('fetchNovaAppBundle', () => {
  it('reads each module/form once, only BOUND tables, and pages rows to the end', async () => {
    const src = shDeliver();
    const calls: string[] = [];
    const tid = Object.keys(src.tables)[0];
    const rows = src.tables[tid].rows;
    const call = async (tool: string, args: Record<string, unknown>) => {
      calls.push(`${tool}:${String(args.tableId ?? args.formUuid ?? args.moduleUuid ?? '')}:${String(args.cursor ?? '')}`);
      if (tool === 'get_app') return { app: src.app };
      if (tool === 'get_module') return src.modules.find((m) => m.uuid === args.moduleUuid);
      if (tool === 'get_form') return src.forms.find((f) => f.formUuid === args.formUuid);
      if (tool === 'get_lookup_table_rows') {
        const first = !args.cursor;
        return first
          ? { table: { id: tid, name: 'SS3 Curriculum', columns: src.tables[tid].columns }, rows: rows.slice(0, 20), complete: false, nextCursor: 'p2' }
          : { rows: rows.slice(20), complete: true };
      }
      throw new Error(`unexpected ${tool}`);
    };
    const b = await fetchNovaAppBundle(src.appId, call);
    expect(b.readErrors).toEqual([]);
    expect(Object.keys(b.tables)).toEqual(boundTableIds(src.forms));
    expect(b.tables[tid].rows).toHaveLength(rows.length);
    expect(b.tables[tid].complete).toBe(true);
    expect(calls.filter((c) => c.startsWith('get_lookup_tables:'))).toHaveLength(0); // never the project catalog
    expect(lintNovaApp(b, { appType: 'deliver' }).verdict).toBe('pass');
  });

  it('a failed read lands in readErrors, not an exception', async () => {
    const src = shDeliver();
    const call = async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'get_app') return { app: src.app };
      if (tool === 'get_form') throw new Error('HTTP 500');
      return src.modules.find((m) => m.uuid === args.moduleUuid);
    };
    const b = await fetchNovaAppBundle(src.appId, call);
    expect(b.readErrors.length).toBe(src.forms.length);
  });

  it('withNovaRetry retries 429 and 5xx, not other errors', async () => {
    let n = 0;
    const flaky = withNovaRetry(async () => {
      n += 1;
      if (n < 3) throw new Error('Nova tools/call → HTTP 429 Too Many Requests');
      return 'ok';
    }, async () => {});
    expect(await flaky('get_app', {})).toBe('ok');
    expect(n).toBe(3);
    const hard = withNovaRetry(async () => {
      throw new Error('Nova get_app rejected the call: no access');
    }, async () => {});
    await expect(hard('get_app', {})).rejects.toThrow('no access');
  });
});
