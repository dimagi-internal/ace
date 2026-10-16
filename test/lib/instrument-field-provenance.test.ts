/**
 * dimagi-internal/ace#2197 — a PDD listed an invented field identifier
 * (`partner_staff_attendance`) beside two identifiers reused verbatim from the
 * partner's shipped instrument, and nothing diffed PDD identifiers against it.
 *
 * Both inputs are captured artifacts:
 *
 *   - `test/fixtures/fixed-instrument/spark-fcap-v1392-forms-4.xml` — the
 *     Village Monitoring Form (`modules-0/forms-4.xml`) of Spark's shipped app,
 *     extracted from the manifest-named instrument in `spark-facilitator/inputs/`
 *     ("FCAP Malawi Green FCAP — CommCare app v1392", Drive file
 *     1qpoze4QT6azhattVm4bPluJlMetoG7a5, read 2026-10-16). Its lines 167-170
 *     are the four `meeting_details` binds the issue quotes.
 *   - `test/fixtures/fixed-instrument/spark-facilitator-20260907-1120-pdd.md` —
 *     the run's own PDD (`1-design/idea-to-pdd.source.md`, Drive file
 *     1qkqHP_kwiUwbyCz-OSL8lJx5OovrrJ0a, revision 14).
 *
 * Measured on these fixtures: `grep -c partner_staff_attendance` over the form
 * is 0; `male_leader_attendence` and `female_leader_attendence` each have one bind.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkInstrumentFieldProvenance,
  declaredNetNewIdentifiers,
} from '../../lib/instrument-field-provenance';

const FIX = join(__dirname, '..', 'fixtures', 'fixed-instrument');
const SPARK_FORM = readFileSync(join(FIX, 'spark-fcap-v1392-forms-4.xml'), 'utf8');
const PDD = readFileSync(join(FIX, 'spark-facilitator-20260907-1120-pdd.md'), 'utf8');

/** The PDD's § 5.3 screen-by-screen table rows — the field spec the build read. */
function section53Table(md: string): string {
  const start = md.indexOf('### 5.3 Community Meeting Record');
  const end = md.indexOf('**Derived and written back', start);
  return md
    .slice(start, end)
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .join('\n');
}
const SPEC = section53Table(PDD);
const SCREEN_8 = SPEC.split('\n').find((l) => l.startsWith('| 8 |'))!;

describe('checkInstrumentFieldProvenance (ace#2197)', () => {
  it('NEGATIVE — partner_staff_attendance, co-listed with two verbatim partner fields, is claimed-reused-but-absent', () => {
    const r = checkInstrumentFieldProvenance({ fieldSpec: SCREEN_8, instrumentForms: [SPARK_FORM] });
    expect(r.ok).toBe(false);
    expect(r.rows.map((x) => [x.identifier, x.provenance])).toEqual([
      ['male_leader_attendence', 'reused'],
      ['female_leader_attendence', 'reused'],
      ['partner_staff_attendance', 'claimed-reused-but-absent'],
    ]);
    expect(r.findings.map((f) => f.identifier)).toEqual(['partner_staff_attendance']);
  });

  it('classifies the whole § 5.3 table: every other identifier is reused or net-new', () => {
    const r = checkInstrumentFieldProvenance({
      fieldSpec: SPEC,
      instrumentForms: [SPARK_FORM],
      declaredNetNew: declaredNetNewIdentifiers(PDD),
    });
    const by = Object.fromEntries(r.rows.map((x) => [x.identifier, x.provenance]));
    expect(by).toMatchObject({
      meeting_conducted: 'reused',
      meeting_type: 'reused',
      community_meeting: 'reused',
      committee_meeting: 'reused',
      hh_represented_at_the_meeting: 'reused',
      male_participants: 'reused',
      currently_saving: 'reused',
      amt_savings: 'reused',
      not_conducted_reason: 'net-new',
      pilot_fcap_step: 'net-new',
      step_completed: 'net-new',
      meeting_notes: 'net-new',
    });
    // `meeting_gps` sits beside the reused `date_of_meeting`, and the PDD's
    // split names "Per-meeting GPS" NET-NEW only in prose, never by identifier.
    // That is exactly the ambiguity the check exists to force into the open.
    expect(r.findings.map((f) => f.identifier).sort()).toEqual(['meeting_gps', 'partner_staff_attendance']);
  });

  it('POSITIVE — once the PDD declares its net-new identifiers and drops the invented one, it is clean', () => {
    const fixedSpec = SPEC.replace(', `partner_staff_attendance`', '');
    const r = checkInstrumentFieldProvenance({
      fieldSpec: fixedSpec,
      instrumentForms: [SPARK_FORM],
      declaredNetNew: new Set([...declaredNetNewIdentifiers(PDD), 'meeting_gps']),
    });
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('declaring the invented identifier NET-NEW moves it out of the finding set rather than hiding it', () => {
    const r = checkInstrumentFieldProvenance({
      fieldSpec: SCREEN_8,
      instrumentForms: [SPARK_FORM],
      declaredNetNew: new Set(['partner_staff_attendance']),
    });
    expect(r.findings).toEqual([]);
    expect(r.rows.find((x) => x.identifier === 'partner_staff_attendance')?.provenance).toBe('net-new');
  });
});
