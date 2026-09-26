/**
 * dimagi-internal/ace#2496 — a field whose OWN `relevant` cannot be parsed was
 * judged for presence on its GROUP gate alone.
 *
 * `specFromDeliverApp` puts an unparsable gate in `unparsed[]` and emits the
 * parseable group gate as a `ConditionalFieldSpec`. `auditDataset` evaluates
 * `conditional-missing` over the conjunction of a field's PARSED gates
 * (ace#1693) — which, with the own gate missing from the conjunction, demanded
 * the field wherever the group was shown.
 *
 * Measured on spark-facilitator/20260925-1536, deliver app
 * 0d877e0f7bc14382b34f4a843803ca0a v14 (`get_opportunity_apps(2296, 'deliver')`),
 * questions verbatim below: `other_reason` reported `conditional-missing` on
 * every not-held record that (correctly) did not select 'other'.
 */
import { describe, it, expect } from 'vitest';
import { auditDataset, scrubOffBranchFields, specFromDeliverApp } from '../../lib/dataset-constraints.js';

// Trimmed verbatim from the v14 response (the fields that matter).
const APP = {
  deliver_app: {
    modules: [
      {
        forms: [
          {
            questions: [
              { type: 'Select', value: '/data/about_this_meeting/meeting_conducted' },
              { type: 'FieldList', value: '/data/why_not_held', relevant: "/data/about_this_meeting/meeting_conducted = 'no'" },
              { type: 'MSelect', value: '/data/why_not_held/question2' },
              {
                type: 'Text',
                value: '/data/why_not_held/other_reason',
                relevant: "selected(/data/why_not_held/question2, 'other')",
                constraint: 'string-length(.) <= 200',
              },
              { type: 'Date', value: '/data/why_not_held/reschedule_date' },
            ],
          },
        ],
      },
    ],
  },
};

const notHeld = (reason: string, extra: Record<string, unknown> = {}) => ({
  id: `v-${reason}-${Object.keys(extra).length}`,
  form: {
    about_this_meeting: { meeting_conducted: 'no' },
    why_not_held: { question2: reason, reschedule_date: '2026-09-20', ...extra },
  },
});
const held = (extra: Record<string, unknown> = {}) => ({
  id: `h-${Object.keys(extra).length}`,
  form: { about_this_meeting: { meeting_conducted: 'yes' }, why_not_held: { ...extra } },
});

describe('specFromDeliverApp + auditDataset — an unparsed OWN gate (ace#2496)', () => {
  const derived = specFromDeliverApp(APP);

  it('reports the own gate as unparsed and stamps the parsed group gate with it', () => {
    expect(derived.unparsed.map((u) => u.field)).toContain('other_reason');
    const entry = (derived.spec.conditionalFields ?? []).find((c) => c.field === 'other_reason');
    expect(entry?.requiredWhen.field).toBe('meeting_conducted');
    expect(entry?.unparsedGates).toEqual(["selected(/data/why_not_held/question2, 'other')"]);
  });

  it('does NOT report other_reason missing on not-held records that did not select other', () => {
    const rows = [notHeld('bad_weather'), notHeld('poor_mobilization'), notHeld('other', { other_reason: 'Funeral' })];
    const report = auditDataset(rows, derived.spec);
    expect(report.violations.find((v) => v.field === 'other_reason')).toBeUndefined();
  });

  it('CONTROL: a field under the group gate alone is still judged for presence', () => {
    const rows = [notHeld('bad_weather'), { ...notHeld('other'), form: { about_this_meeting: { meeting_conducted: 'no' }, why_not_held: {} } }];
    const report = auditDataset(rows, derived.spec);
    const missing = report.violations.find((v) => v.kind === 'conditional-missing' && v.field === 'reschedule_date');
    expect(missing?.count).toBe(1);
  });

  it('CONTROL: the off-branch direction still runs on the parsed gate', () => {
    const rows = [held({ other_reason: 'should not exist' }), notHeld('other', { other_reason: 'ok' })];
    const report = auditDataset(rows, derived.spec);
    const off = report.violations.find((v) => v.kind === 'conditional-off-branch' && v.field === 'other_reason');
    expect(off?.count).toBe(1);
    const scrubbed = scrubOffBranchFields(rows, derived.spec.conditionalFields ?? []);
    expect(scrubbed.report.totalCleared).toBeGreaterThanOrEqual(1);
  });
});
