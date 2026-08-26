/**
 * dimagi-internal/ace#1658 — the `DatasetSpec` behind `demo-data-setup-qa`
 * check 9 was hand-declared from PDD prose, so under-declaring it produced a
 * false green; and the check's auto-fix ("regenerate with the constraint
 * applied at the manifest") named a knob the labs generator does not have.
 *
 * Measured, same opp / same app / same generator:
 *
 *   `bednet-check-2-visit/20260817-1720` recorded check 9 `pass` on the
 *   justification that the deliver form carried "no conditional blocks", with
 *   `conditionalFields: []`. `get_opportunity_apps(2214, 'deliver')` returns
 *   the gates verbatim:
 *
 *     {"value": "/data/net_check/slept_under_net",
 *      "relevant": "/data/agree_again/consent_confirmed = 'yes'", "required": true}
 *     {"value": "/data/net_check/net_visibly_hanging",
 *      "relevant": "/data/agree_again/consent_confirmed = 'yes'", "required": true}
 *
 *   `20260825-1310` declared them honestly and measured 18 of 276 off-branch
 *   on EACH field — the same 18 records. The difference between pass and fail
 *   was the spec, not the data.
 *
 * These tests pin both halves: the spec is derived from the app rather than
 * asserted (so the empty-spec green is unreachable), and the branch scrub is
 * a real, idempotent remedy for the class the generator cannot avoid.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  auditDataset,
  mergeDatasetSpecs,
  scrubOffBranchFields,
  specFromDeliverApp,
  formatScrubReport,
  type ConditionalFieldSpec,
} from '../../lib/dataset-constraints.js';

const APP = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/connect-labs/opportunity-apps-2214-deliver.json', import.meta.url)),
    'utf8',
  ),
);

/** The fixture shape the labs generator writes: nested at the app's own paths. */
const record = (consent: string, extra: Record<string, unknown> = {}) => ({
  id: `v-${Math.random().toString(36).slice(2)}`,
  form: {
    agree_again: { consent_confirmed: consent },
    net_check: { ...extra },
  },
});

describe('specFromDeliverApp (#1658 defect 1 — the spec is derived, not asserted)', () => {
  it('derives BOTH consent gates from the real get_opportunity_apps response', () => {
    const derived = specFromDeliverApp(APP);
    const gated = (derived.spec.conditionalFields ?? []).map((c) => c.field).sort();
    expect(gated).toEqual(['net_visibly_hanging', 'nets_in_household', 'slept_under_net']);
    for (const c of derived.spec.conditionalFields ?? []) {
      expect(c.requiredWhen).toMatchObject({ field: 'consent_confirmed', equals: 'yes' });
    }
    // The false green's premise — "no conditional blocks" — is now unreachable:
    // the derivation returns a non-empty conditionalFields for this exact app.
    expect(derived.spec.conditionalFields ?? []).not.toHaveLength(0);
    expect(derived.questionsSeen).toBe(4);
    expect(derived.unparsed).toEqual([]);
  });

  it('derives integer bounds from the question constraint', () => {
    const derived = specFromDeliverApp(APP);
    expect(derived.spec.integerFields).toEqual([{ field: 'nets_in_household', min: 1, max: 30 }]);
  });

  it('accepts the get_opportunity_apps envelope and a bare app JSON alike', () => {
    const bare = specFromDeliverApp(APP.deliver_app);
    expect(bare.gatesParsed).toBe(specFromDeliverApp(APP).gatesParsed);
  });

  it('the derived spec turns the 20260817 false green into the 20260825 finding', () => {
    const derived = specFromDeliverApp(APP);
    // 18 off-branch records among 30, exactly the observed shape.
    const rows = [
      ...Array.from({ length: 12 }, () => ({
        consent_confirmed: 'yes',
        slept_under_net: 'yes',
        net_visibly_hanging: 'yes',
      })),
      ...Array.from({ length: 18 }, () => ({
        consent_confirmed: 'no',
        slept_under_net: 'yes',
        net_visibly_hanging: 'no',
      })),
    ];
    const withEmptySpec = auditDataset(rows, { conditionalFields: [] });
    expect(withEmptySpec.ok).toBe(true); // the shape of the false green

    const measured = auditDataset(rows, derived.spec);
    const offBranch = measured.violations.filter((v) => v.kind === 'conditional-off-branch');
    expect(offBranch.map((v) => [v.field, v.count])).toEqual(
      expect.arrayContaining([
        ['slept_under_net', 18],
        ['net_visibly_hanging', 18],
      ]),
    );
  });

  it('a group-level relevant gates every question underneath it', () => {
    const app = {
      deliver_app: {
        modules: [
          {
            forms: [
              {
                questions: [
                  { value: '/data/gate/ok', type: 'Select1' },
                  { value: '/data/block', type: 'Group', is_group: true, relevant: "/data/gate/ok = 'yes'" },
                  { value: '/data/block/child_a', type: 'Text' },
                  { value: '/data/block/child_b', type: 'Text' },
                ],
              },
            ],
          },
        ],
      },
    };
    const derived = specFromDeliverApp(app);
    expect((derived.spec.conditionalFields ?? []).map((c) => c.field).sort()).toEqual([
      'child_a',
      'child_b',
    ]);
  });

  it('RETURNS what it cannot parse instead of silently narrowing the spec', () => {
    const app = {
      deliver_app: {
        modules: [
          {
            forms: [
              {
                questions: [
                  { value: '/data/a', type: 'Text', relevant: "selected(/data/g, 'x')" },
                  { value: '/data/b', type: 'Text', relevant: "/data/g != 'no'" },
                  { value: '/data/c', type: 'Int', constraint: '. >= 1 or . <= 30' },
                ],
              },
            ],
          },
        ],
      },
    };
    const derived = specFromDeliverApp(app);
    expect(derived.spec.conditionalFields).toBeUndefined();
    expect(derived.unparsed.map((u) => [u.kind, u.field])).toEqual([
      ['relevant', 'a'],
      ['relevant', 'b'],
      ['constraint', 'c'],
    ]);
    // An unreadable `!=` must NOT become an equality gate on field `g!`.
    expect(derived.unparsed[1].expression).toBe("/data/g != 'no'");
    // The Int check still applies; only its bounds are unknown.
    expect(derived.spec.integerFields).toEqual([{ field: 'c' }]);
  });

  it('an empty / unreachable app derives nothing and says so', () => {
    expect(specFromDeliverApp({ deliver_app: null }).questionsSeen).toBe(0);
    expect(specFromDeliverApp(undefined).questionsSeen).toBe(0);
  });
});

describe('mergeDatasetSpecs (hand-declared entries are ADDITIONS)', () => {
  it('keeps every derived gate when additions are supplied', () => {
    const derived = specFromDeliverApp(APP);
    const merged = mergeDatasetSpecs(derived.spec, {
      wholeCurrencyFields: ['incentive_paid'],
      conditionalFields: [
        { field: 'referral_reason', requiredWhen: { field: 'referred', equals: 'yes' } },
      ],
    });
    const fields = (merged.conditionalFields ?? []).map((c) => c.field);
    expect(fields).toContain('slept_under_net');
    expect(fields).toContain('net_visibly_hanging');
    expect(fields).toContain('referral_reason');
    expect(merged.wholeCurrencyFields).toEqual(['incentive_paid']);
    expect(merged.integerFields).toEqual([{ field: 'nets_in_household', min: 1, max: 30 }]);
  });
});

describe('scrubOffBranchFields (#1658 defect 2 — the remedy that actually exists)', () => {
  const gates = () => specFromDeliverApp(APP).spec.conditionalFields as ConditionalFieldSpec[];

  it('clears off-branch values inside NESTED fixture records and leaves on-branch alone', () => {
    const rows = [
      ...Array.from({ length: 12 }, () =>
        record('yes', { slept_under_net: 'yes', net_visibly_hanging: 'yes', nets_in_household: 2 }),
      ),
      ...Array.from({ length: 18 }, () =>
        record('no', { slept_under_net: 'yes', net_visibly_hanging: 'no', nets_in_household: 3 }),
      ),
    ];
    const { records, report } = scrubOffBranchFields(rows, gates());

    expect(report.records).toBe(30);
    expect(report.totalCleared).toBe(54); // 18 records x 3 gated fields
    const byField = Object.fromEntries(report.fields.map((f) => [f.field, f.recordsScrubbed]));
    expect(byField.slept_under_net).toBe(18);
    expect(byField.net_visibly_hanging).toBe(18);
    expect(byField.nets_in_household).toBe(18);
    expect(report.unresolvedFields).toEqual([]);

    const off = records.filter((r) => r.form.agree_again.consent_confirmed === 'no');
    expect(off.every((r) => Object.keys(r.form.net_check).length === 0)).toBe(true);
    const on = records.filter((r) => r.form.agree_again.consent_confirmed === 'yes');
    expect(on.every((r) => r.form.net_check.slept_under_net === 'yes')).toBe(true);

    // Pure: the caller's records are untouched.
    expect(rows[12].form.net_check.slept_under_net).toBe('yes');
  });

  it('a scrubbed set audits clean against the SAME derived spec', () => {
    const rows = [
      { consent_confirmed: 'yes', slept_under_net: 'yes', net_visibly_hanging: 'yes', nets_in_household: 2 },
      { consent_confirmed: 'no', slept_under_net: 'yes', net_visibly_hanging: 'no', nets_in_household: 3 },
    ];
    const derived = specFromDeliverApp(APP);
    expect(auditDataset(rows, derived.spec).ok).toBe(false);
    const { records } = scrubOffBranchFields(rows, derived.spec.conditionalFields);
    expect(auditDataset(records, derived.spec).ok).toBe(true);
  });

  it('is idempotent — a second pass clears nothing', () => {
    const rows = [record('no', { slept_under_net: 'yes' })];
    const first = scrubOffBranchFields(rows, gates());
    expect(first.report.totalCleared).toBe(1);
    const second = scrubOffBranchFields(first.records, gates());
    expect(second.report.totalCleared).toBe(0);
  });

  it('reports a field it could never locate rather than reporting a silent zero', () => {
    const rows = [{ consent_confirmed: 'no' }];
    const { report } = scrubOffBranchFields(rows, [
      { field: 'ghost', path: '/data/x/ghost', requiredWhen: { field: 'consent_confirmed', equals: 'yes' } },
    ]);
    expect(report.unresolvedFields).toEqual(['ghost']);
    expect(formatScrubReport(report)).toMatch(/UNRESOLVED/);
  });

  it('counts records with no gate field rather than deleting on a guess', () => {
    const rows = [{ slept_under_net: 'yes' }];
    const { records, report } = scrubOffBranchFields(rows, gates());
    expect(report.fields.every((f) => f.recordsGateMissing === 1)).toBe(true);
    expect(report.totalCleared).toBe(0);
    expect(records[0].slept_under_net).toBe('yes');
  });

  it('does not delete a same-leaf field on a different branch of the tree', () => {
    const rows = [
      {
        form: {
          agree_again: { consent_confirmed: 'no' },
          net_check: { slept_under_net: 'yes' },
          prior_visit: { slept_under_net: 'no' },
        },
      },
    ];
    const { records, report } = scrubOffBranchFields(rows, gates());
    // The XPath tail `/net_check/slept_under_net` disambiguates the two leaves.
    expect(records[0].form.net_check.slept_under_net).toBeUndefined();
    expect(records[0].form.prior_visit.slept_under_net).toBe('no');
    expect(report.fields.find((f) => f.field === 'slept_under_net')?.recordsScrubbed).toBe(1);
  });
});
