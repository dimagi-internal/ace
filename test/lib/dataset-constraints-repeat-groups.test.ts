/**
 * dimagi-internal/ace#2432 — a CommCare REPEAT group that was correctly
 * materialised read as `conditional-missing` on every record.
 *
 * `leafPaths` treated an array as an opaque leaf, so `/data/roster/member_name`
 * had no path at all while its gate, `/data/g_consent/consent` at the record's
 * top level, resolved fine. `auditDataset` therefore reported a field the form
 * asked for, and got an answer to, as absent.
 *
 * Measured on `poverty-graduation/20260915-1518` (deliver app
 * e4594937038c42d2be4d01f45df44209 v7, labs opp 10065, 2,207 records) before
 * the fix:
 *
 *   [conditional-missing] 1379 of 2207 — member_name is absent on 1379
 *                                        record(s) where consent = "yes" asks
 *   [conditional-missing] 1379 of 2207 — is_member   …
 *   [conditional-missing] 1379 of 2207 — member_flag …
 *
 * 1,379 is exactly the number of records carrying a NON-EMPTY `form.roster`
 * array, and the run's own `verify_arithmetic.py` summed `roster[].member_flag`
 * across all 1,379 and matched the app's `/data/member_count` with 0 failures —
 * arithmetically impossible on an empty roster. `scrubOffBranchFields` listed
 * the same three leaves under `unresolvedFields`, since both go through the
 * same resolution.
 *
 * Why it mattered beyond the false positive: the run had to spend three
 * `declared_omissions` entries exempting data that was present and correct, so
 * a run that materialised the repeat scored the same on check 9 as one that
 * skipped it — the gate losing resolution exactly where the dataset got better.
 * ace#2225 named that class "structurally impossible" and it no longer is: the
 * labs manifest schema carries `BeneficiaryCohort.repeat_groups`, and this run
 * produced one.
 *
 * The fixtures are REAL captures, because the defect is that synthetic ones
 * agreed with a wrong model of the record shape:
 *   - `../fixtures/connect-labs/opportunity-apps-2255-deliver-roster.json`
 *     — `get_opportunity_apps(2255, 'deliver')`, questions verbatim.
 *   - `../fixtures/connect-labs/user-visits-2255-roster.json`
 *     — 3 of the run's own 2,207 generated records, verbatim.
 *
 * The negative controls are the load-bearing half: widening a resolver until it
 * never reports anything is worse than the false positive it replaces, so an
 * EMPTY repeat and a repeat whose rows lack the leaf must both still be read as
 * absent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  auditDataset,
  scrubOffBranchFields,
  specFromDeliverApp,
  type ConditionalFieldSpec,
} from '../../lib/dataset-constraints.js';

const read = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/connect-labs/${name}`, import.meta.url)), 'utf8'));

const APP = read('opportunity-apps-2255-deliver-roster.json');
const CAPTURED: Record<string, unknown>[] = read('user-visits-2255-roster.json').records;

const SPEC = specFromDeliverApp(APP).spec;
const ROSTER_LEAVES = ['member_name', 'is_member', 'member_flag'];

/** The three-row-roster record, as generated. */
const consented = () => structuredClone(CAPTURED[0]) as any;
/** The refused visit: consent = 'no', so the form never asks for a roster. */
const refused = () => structuredClone(CAPTURED[2]) as any;

const missing = (rows: Record<string, unknown>[]) =>
  auditDataset(rows, SPEC)
    .violations.filter((v) => v.kind === 'conditional-missing')
    .map((v) => v.field);

describe('the spec derived from the real deliver app', () => {
  it('gates all three roster children on consent, as the app declares', () => {
    const gates = (SPEC.conditionalFields ?? []).filter((c) => ROSTER_LEAVES.includes(c.field));
    expect(gates.map((c) => c.field).sort()).toEqual(['is_member', 'member_flag', 'member_name']);
    for (const g of gates) {
      expect(g.path).toBe(`/data/roster/${g.field}`);
      expect(g.requiredWhen).toMatchObject({ path: '/data/g_consent/consent', equals: 'yes' });
    }
  });
});

describe('positive control — a materialised repeat is PRESENT (#2432)', () => {
  it('raises no conditional-missing for a roster leaf on the real records', () => {
    const fields = missing(CAPTURED);
    for (const leaf of ROSTER_LEAVES) expect(fields).not.toContain(leaf);
  });

  it('resolves every row of the repeat, not just the first', () => {
    // The row values are what a per-value check reads, so "present" must not
    // collapse a 3-row roster to one lookup that happens to succeed.
    const record = consented();
    expect(record.form_json.form.roster).toHaveLength(3);
    const names = record.form_json.form.roster.map((r: any) => r.member_name);
    expect(new Set(names).size).toBe(3);
    expect(missing([record])).not.toContain('member_name');
  });

  it('clears the three leaves from the scrub report unresolvedFields', () => {
    const { report } = scrubOffBranchFields(CAPTURED as any, SPEC.conditionalFields);
    for (const leaf of ROSTER_LEAVES) expect(report.unresolvedFields).not.toContain(leaf);
  });
});

describe('negative controls — the check still reports a genuine absence (#2432)', () => {
  it('still reports a field that really is absent on the same real records', () => {
    // dwelling_photo is gated on photo_consent = 'yes' and appears NOWHERE in
    // the 2,207 records (labs ships no dwelling-photograph corpus). If widening
    // the resolver had blinded the check, this would have gone quiet too.
    expect(missing(CAPTURED)).toContain('dwelling_photo');
  });

  it('reads an EMPTY repeat as absent', () => {
    const empty = consented();
    empty.form_json.form.roster = [];
    const fields = missing([empty]);
    for (const leaf of ROSTER_LEAVES) expect(fields).toContain(leaf);
  });

  it('reads a repeat whose rows lack the leaf as absent — for THAT leaf only', () => {
    // Non-inertness: this record differs from the positive control in one
    // property, `member_name`, and only `member_name` changes verdict.
    const partial = consented();
    for (const row of partial.form_json.form.roster) delete row.member_name;
    const fields = missing([partial]);
    expect(fields).toContain('member_name');
    expect(fields).not.toContain('is_member');
    expect(fields).not.toContain('member_flag');
  });

  it('reads a row whose leaf is blank as absent', () => {
    const blank = consented();
    for (const row of blank.form_json.form.roster) row.member_name = '';
    expect(missing([blank])).toContain('member_name');
  });

  it('counts a row as an answer when ANY row carries the leaf', () => {
    // One name recorded is an answered question; the form's own `required` is
    // per row and is not what check 9 judges.
    const partial = consented();
    delete partial.form_json.form.roster[0].member_name;
    delete partial.form_json.form.roster[1].member_name;
    expect(partial.form_json.form.roster[2].member_name).toBeTruthy();
    expect(missing([partial])).not.toContain('member_name');
  });

  it('does not demand a roster on a refused visit — the gate does not hold', () => {
    const record = refused();
    expect(record.form_json.form.g_consent.consent).toBe('no');
    expect(record.form_json.form.roster).toBeUndefined();
    const fields = missing([record]);
    for (const leaf of ROSTER_LEAVES) expect(fields).not.toContain(leaf);
  });
});

describe('the scrub resolves the same way it audits (#2432)', () => {
  const insideRepeat: ConditionalFieldSpec[] = [
    {
      field: 'member_name',
      path: '/data/roster/member_name',
      requiredWhen: { field: 'consent', path: '/data/g_consent/consent', equals: 'yes' },
    },
  ];

  it('clears an off-branch value from EVERY row, not just the first', () => {
    // A refused visit cannot carry a roster at all, so a partial delete would
    // leave rows the form could not have collected.
    const offBranch = refused();
    offBranch.form_json.form.roster = [
      { member_name: 'Kemi', is_member: 'yes', member_flag: 1 },
      { member_name: 'Dauda', is_member: 'yes', member_flag: 1 },
    ];
    const { records, report } = scrubOffBranchFields([offBranch] as any, insideRepeat);
    expect(report.totalCleared).toBe(1);
    expect((records[0] as any).form_json.form.roster.every((r: any) => !('member_name' in r))).toBe(true);
    // …and it leaves the rest of the row alone.
    expect((records[0] as any).form_json.form.roster[0].is_member).toBe('yes');
  });

  it('leaves an ON-branch roster untouched', () => {
    const { records, report } = scrubOffBranchFields([consented()] as any, insideRepeat);
    expect(report.totalCleared).toBe(0);
    expect((records[0] as any).form_json.form.roster.map((r: any) => r.member_name)).toEqual(
      (consented() as any).form_json.form.roster.map((r: any) => r.member_name),
    );
  });

  it('still scrubs the repeat GROUP itself when the whole branch is off', () => {
    // The array is indexed as its own leaf as well as being descended into, so
    // a spec naming the repeat still removes it whole.
    const wholeRepeat: ConditionalFieldSpec[] = [
      {
        field: 'roster',
        path: '/data/roster',
        requiredWhen: { field: 'consent', path: '/data/g_consent/consent', equals: 'yes' },
      },
    ];
    const offBranch = refused();
    offBranch.form_json.form.roster = [{ member_name: 'Kemi', is_member: 'yes', member_flag: 1 }];
    const { records, report } = scrubOffBranchFields([offBranch] as any, wholeRepeat);
    expect(report.totalCleared).toBe(1);
    expect((records[0] as any).form_json.form.roster).toBeUndefined();
  });
});
