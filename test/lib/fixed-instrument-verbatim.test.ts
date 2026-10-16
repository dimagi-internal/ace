/**
 * dimagi-internal/ace#2366 — a released Deliver app added "Declined or does not
 * know" to ONE question of a [FIXED] verbatim-only instrument (the Nigeria PPI
 * fan question), and no gate diffed the released form against the instrument.
 *
 * Both inputs are captured artifacts, not literals typed beside the assertions:
 *
 *   - `test/fixtures/fixed-instrument/nigeria-ppi-2018-instrument.md` — the
 *     instrument file itself, read verbatim from `poverty-graduation/inputs/`
 *     ("INSTRUMENT — Nigeria 2018 PPI (IPA, published October 2020; official,
 *     extracted verbatim).md", Drive file 1_6cR_KN8h5wScrzjxsKUrO_XAxvNyhQa,
 *     revision 13, read 2026-10-16).
 *   - `test/fixtures/ccz/poverty-graduation-targeting-survey.xml` — the released
 *     targeting-survey form of `poverty-graduation/20260915-1518` (provenance in
 *     `test/lib/entity-id-grain.test.ts`). Its ten PPI selects match the
 *     instrument, so it is the POSITIVE control; the NEGATIVE controls mutate it
 *     to reproduce the defect observed on `poverty-graduation/20260908-0510`:
 *
 *       ppi_assets-ppi_fan-opt2-label | Declined or does not know
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkFixedInstrumentVerbatim,
  normaliseOptionLabel,
  parseInstrumentMarkdown,
  readReleasedSelects,
} from '../../lib/fixed-instrument-verbatim';

const FIX = join(__dirname, '..', 'fixtures');
const INSTRUMENT_MD = readFileSync(join(FIX, 'fixed-instrument', 'nigeria-ppi-2018-instrument.md'), 'utf8');
const SURVEY = readFileSync(join(FIX, 'ccz', 'poverty-graduation-targeting-survey.xml'), 'utf8');
const INSTRUMENT = parseInstrumentMarkdown(INSTRUMENT_MD);

/** The instrument says to derive household size from a roster, never ask it. */
const ROSTER_EXEMPTION = [
  {
    question: '2',
    reason: 'Instrument: "Indicator 2 (household size) uses a Household Roster: do NOT ask household size directly."',
  },
];

/** The fan select, with the ace#2366 option appended. */
const FAN_SELECT = /(<select1 ref="\/data\/g_assets\/i9_fan">[\s\S]*?)(<\/select1>)/;
function withDeclinedFanOption(xml: string): string {
  const withItem = xml.replace(
    FAN_SELECT,
    `$1  <item>\n          <label ref="jr:itext('g_assets-i9_fan-opt2-label')"/>\n          <value>declined</value>\n        </item>\n      $2`,
  );
  return withItem.replace(
    /(<text id="g_assets-i9_fan-label">)/,
    `<text id="g_assets-i9_fan-opt2-label">\n            <value>Declined or does not know</value>\n          </text>\n          $1`,
  );
}

describe('parseInstrumentMarkdown — the real instrument file', () => {
  it('reads all ten indicators with their lettered options, and ignores the lookup table', () => {
    expect(INSTRUMENT.map((q) => q.number)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(INSTRUMENT[0].options.map((o) => o.label)).toEqual([
      'A. North Central',
      'B. North East',
      'C. North West',
      'D. South East',
      'E. South South',
      'F. South West',
    ]);
    const fan = INSTRUMENT.find((q) => q.number === '9')!;
    expect(fan.text).toBe('Does your household own an FAN?');
    expect(fan.options).toEqual([
      { label: 'A.Yes', points: 5 },
      { label: 'B. No', points: 0 },
    ]);
  });

  it('strips the scorecard letter from an option label and nothing else', () => {
    expect(normaliseOptionLabel('A.Yes')).toBe('Yes');
    expect(normaliseOptionLabel('B. No')).toBe('No');
    expect(normaliseOptionLabel('Declined or does not know')).toBe('Declined or does not know');
  });
});

describe('checkFixedInstrumentVerbatim (ace#2366)', () => {
  it('POSITIVE — the released targeting survey carries every instrument question and option verbatim', () => {
    const r = checkFixedInstrumentVerbatim({ instrument: INSTRUMENT, forms: [SURVEY], exempt: ROSTER_EXEMPTION });
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.matched).toHaveLength(9);
    expect(r.exempted.map((e) => e.question)).toEqual(['2']);
  });

  it('NEGATIVE — the added "Declined or does not know" fan option is reported (the observed defect)', () => {
    const bad = withDeclinedFanOption(SURVEY);
    // Sanity: the mutation landed in the released shape the reader parses.
    const fan = readReleasedSelects(bad).find((s) => s.ref === '/data/g_assets/i9_fan')!;
    expect(fan.options).toEqual(['Yes', 'No', 'Declined or does not know']);

    const r = checkFixedInstrumentVerbatim({ instrument: INSTRUMENT, forms: [bad], exempt: ROSTER_EXEMPTION });
    expect(r.ok).toBe(false);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      kind: 'option-added',
      question: '9',
      ref: '/data/g_assets/i9_fan',
      built: 'Declined or does not know',
    });
  });

  it('NEGATIVE — an un-exempted roster-derived question is reported, never silently skipped', () => {
    const r = checkFixedInstrumentVerbatim({ instrument: INSTRUMENT, forms: [SURVEY] });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => `${f.kind}:${f.question}`)).toEqual(['question-not-found:2']);
  });

  it('NEGATIVE — a reworded question and a dropped option are both reported', () => {
    const bad = SURVEY.replace(
      '<value>Does your household own an IRON?</value>',
      '<value>Does your household have an IRON at home?</value>',
    ).replace(
      /(<select1 ref="\/data\/g_zone\/i1_zone">[\s\S]*?)<item>\s*<label ref="jr:itext\('g_zone-i1_zone-opt5-label'\)"\/>\s*<value>south_west<\/value>\s*<\/item>/,
      '$1',
    );
    const r = checkFixedInstrumentVerbatim({ instrument: INSTRUMENT, forms: [bad], exempt: ROSTER_EXEMPTION });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => `${f.kind}:${f.question}`).sort()).toEqual([
      'option-dropped:1',
      'question-text-changed:10',
    ]);
  });
});
