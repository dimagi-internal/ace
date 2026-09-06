/**
 * Tests for `lib/casedb-preload-audit.ts`.
 *
 * The fixtures are the two REAL compiled forms from the released Deliver CCZ of
 * `spark-facilitator/20260828-0703` (HQ app 89881fa67ec74f21b95e37d41e39ba93,
 * build b08533bdf26a48a295a362ff204fb88d) — not hand-written samples. The
 * follow-up form is the defect; the enrolment form is the control, and it
 * matters that it passes: it proves the check discriminates rather than
 * flagging every form with a case block.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  visibleInputRefs,
  casedbPreloads,
  auditCasedbPreloads,
  formatPreloadAudit,
} from '../../lib/casedb-preload-audit.js';

const FIXTURES = join(__dirname, '..', 'fixtures', 'ccz');
const MEETING = readFileSync(join(FIXTURES, 'spark-facilitator-meeting-record.xml'), 'utf8');
const ENROLMENT = readFileSync(join(FIXTURES, 'spark-facilitator-enrolment.xml'), 'utf8');

describe('the shipped follow-up form — the defect this exists for', () => {
  const result = auditCasedbPreloads(MEETING);

  it('finds the casedb preloads Nova emitted', () => {
    expect(result.preloads.length).toBeGreaterThanOrEqual(40);
  });

  it('flags nearly every visible question as answered from the case', () => {
    // 35 of 36. The lone survivor is the photo, an <upload>.
    expect(result.visibleInputCount).toBe(36);
    expect(result.violations).toHaveLength(35);
  });

  it('flags the two fields Connect reads to decide payment', () => {
    const refs = result.violations.map((v) => v.ref);
    expect(refs).toContain('/data/meeting_held/meeting_conducted');
    expect(refs).toContain('/data/meeting_type_screen/meeting_type');
  });

  it('flags the date, which is why last_meeting_date never advanced', () => {
    const date = result.violations.find((v) => v.ref === '/data/meeting_date/date_of_meeting');
    expect(date).toBeDefined();
    expect(date!.property).toBe('date_of_meeting');
  });

  it('flags the geopoint, so location evidence is the previous visit’s', () => {
    expect(result.violations.map((v) => v.ref)).toContain('/data/evidence/meeting_gps');
  });

  it('does NOT flag the photo — the one field a worker must actually supply', () => {
    const refs = result.violations.map((v) => v.ref);
    expect(refs.some((r) => /photo|picture|image/i.test(r) && !/consent/.test(r))).toBe(false);
  });
});

describe('the enrolment form — the control', () => {
  it('has no casedb preloads at all: there is no case to read yet', () => {
    expect(casedbPreloads(ENROLMENT)).toHaveLength(0);
  });

  it('passes the audit', () => {
    const result = auditCasedbPreloads(ENROLMENT);
    expect(result.violations).toHaveLength(0);
    expect(formatPreloadAudit(result, 'modules-0/forms-0.xml')).toContain('[PASS]');
  });

  it('still has visible questions — so the pass is discrimination, not emptiness', () => {
    expect(visibleInputRefs(ENROLMENT).size).toBeGreaterThan(0);
  });
});

describe('declared exceptions', () => {
  it('honours an allowed ref and reports it', () => {
    const result = auditCasedbPreloads(MEETING, ['/data/meeting_date/date_of_meeting']);
    expect(result.allowed).toEqual(['/data/meeting_date/date_of_meeting']);
    expect(result.violations.map((v) => v.ref)).not.toContain('/data/meeting_date/date_of_meeting');
    expect(result.violations).toHaveLength(34);
  });

  it('an allowlist covering everything makes the form pass', () => {
    const all = auditCasedbPreloads(MEETING).violations.map((v) => v.ref);
    expect(auditCasedbPreloads(MEETING, all).violations).toHaveLength(0);
  });
});

describe('a hidden preload is not a violation', () => {
  it('carries context in a hidden node without flagging it', () => {
    const xml = `
      <h:head><model>
        <setvalue ref="/data/hidden/household_count" value="instance('casedb')/casedb/case[@case_id=x]/household_count" event="xforms-ready"/>
      </model></h:head>
      <h:body><input ref="/data/visible/answer"/></h:body>`;
    const result = auditCasedbPreloads(xml);
    expect(result.preloads).toHaveLength(1);
    expect(result.preloads[0].visible).toBe(false);
    expect(result.violations).toHaveLength(0);
  });
});

describe('non-casedb setvalues are ignored', () => {
  it('leaves the meta block alone', () => {
    const xml = `
      <h:head><model>
        <setvalue ref="/data/meta/timeStart" value="now()" event="xforms-ready"/>
        <setvalue ref="/data/meta/instanceID" value="uuid()" event="xforms-ready"/>
      </model></h:head>
      <h:body><input ref="/data/meta/timeStart"/></h:body>`;
    expect(auditCasedbPreloads(xml).violations).toHaveLength(0);
  });
});

describe('formatPreloadAudit', () => {
  it('leads with the ratio, which is what conveys severity', () => {
    const out = formatPreloadAudit(auditCasedbPreloads(MEETING), 'modules-1/forms-0.xml');
    expect(out).toContain('[BLOCKER]');
    expect(out).toContain('35 of 36');
  });

  it('names the offending refs and their case properties', () => {
    const out = formatPreloadAudit(auditCasedbPreloads(MEETING), 'modules-1/forms-0.xml');
    expect(out).toContain('/data/meeting_type_screen/meeting_type  <- casedb/meeting_type');
  });

  it('says how to fix it in the brief', () => {
    const out = formatPreloadAudit(auditCasedbPreloads(MEETING), 'modules-1/forms-0.xml');
    expect(out).toContain('drop the case binding');
  });
});

/**
 * ── Attribute order (dimagi-internal/ace#1809) ──────────────────────────────
 *
 * Every fixture above is `ref`-first, so nothing above can see the gate's real
 * rule. It was `<setvalue ref="…" value="…" event="…">` IN THAT ORDER — which
 * produced the right number on the reported case while carrying a rule that
 * silently drops any node serialized differently. On a `[BLOCKER]` gate a
 * missed node is not a missed finding, it is a PASS.
 *
 * The event-first ordering is observed, not imagined: `HH_VISIT` below is the
 * released Deliver CCZ of hh-poverty-targeting (HQ app
 * ce668763ad6c4b48ac5f4cd4502f3f8c, project space connect-ace-prod, pulled
 * 2026-09-06) and Nova wrote two of its eleven setvalues event-first.
 */
const HH_VISIT = readFileSync(join(FIXTURES, 'hh-poverty-targeting-visit.xml'), 'utf8');

/** A visible question plus one preload, with the setvalue attributes ordered as given. */
const formWith = (setvalue: string) =>
  [
    '<h:html><h:head><model><instance><data>',
    '  <hh_size/>',
    '</data></instance>',
    setvalue,
    '</model></h:head>',
    '<h:body><input ref="/data/hh_size"><label>Household size</label></input></h:body>',
    '</h:html>',
  ].join('\n');

const CASEDB =
  "instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/case_id]/hh_size";

describe('a preload is found whatever order its attributes are written in', () => {
  // Nova's own ordering, taken verbatim from the live hh-poverty-targeting CCZ.
  it('event-first — the ordering Nova actually emits', () => {
    const xml = formWith('<setvalue event="xforms-ready" ref="/data/hh_size" value="' + CASEDB + '"/>');
    expect(auditCasedbPreloads(xml).violations.map((v) => v.ref)).toEqual(['/data/hh_size']);
  });

  it('ref-first — HQ’s ordering, the one the first cut pinned', () => {
    const xml = formWith('<setvalue ref="/data/hh_size" value="' + CASEDB + '" event="xforms-ready"/>');
    expect(auditCasedbPreloads(xml).violations.map((v) => v.ref)).toEqual(['/data/hh_size']);
  });

  it('value-first', () => {
    const xml = formWith('<setvalue value="' + CASEDB + '" ref="/data/hh_size" event="xforms-ready"/>');
    expect(auditCasedbPreloads(xml).violations.map((v) => v.ref)).toEqual(['/data/hh_size']);
  });

  it('with no event at all — a casedb read into a question is the defect regardless', () => {
    const xml = formWith('<setvalue ref="/data/hh_size" value="' + CASEDB + '"/>');
    expect(auditCasedbPreloads(xml).violations.map((v) => v.ref)).toEqual(['/data/hh_size']);
  });

  it('and still ignores a non-casedb setvalue in any of those orders', () => {
    for (const sv of [
      '<setvalue event="xforms-ready" ref="/data/hh_size" value="today()"/>',
      '<setvalue ref="/data/hh_size" value="today()" event="xforms-ready"/>',
    ]) {
      expect(auditCasedbPreloads(formWith(sv)).violations).toHaveLength(0);
    }
  });
});

describe('the live hh-poverty-targeting visit form — a second real app', () => {
  it('really does carry event-first setvalues, which is why this matters', () => {
    expect((HH_VISIT.match(/<setvalue\s+event=/g) ?? []).length).toBeGreaterThan(0);
  });

  it('passes the audit — it opens the case, so there is nothing to read back', () => {
    const result = auditCasedbPreloads(HH_VISIT);
    expect(result.preloads).toHaveLength(0);
    expect(result.violations).toHaveLength(0);
  });

  it('still asks plenty of questions, so the pass is discrimination', () => {
    expect(auditCasedbPreloads(HH_VISIT).visibleInputCount).toBeGreaterThan(15);
  });
});
