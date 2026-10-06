import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkRegistryDisplayText,
  indicatorsDocOf,
  lintDisplayText,
  readerFacingTexts,
} from '../../lib/registry-display-text';
import { checkRegistryAuthoring, type RegistryDocs } from '../../lib/semantic-registry-authoring';
import { checkRegistryTextIsPlain, checksForProvider } from '../../skills/demo-data-setup-qa/checks';

// ace#2748 — spark-facilitator/20261004-1706, registry 7748. These strings are
// verbatim from the live registry: the targets_note capped DDD run
// spark-facilitator-programme-cascade-2026-10-06-004 at clarity 2.
const SPARK_BEFORE = "Targets are the PDD's own (§8.1 P1 ≥ 80%, P3 ≥ 75%). Spark's participation indicators carry no target in the PDD, so they are shown without one. Synthetic data.";
const SPARK_AFTER =
  "Targets come from the pilot design: a meeting in at least 80% of each community's weeks, and at least 75% of communities finishing Step 7 within 15 weeks. The design sets no target for participation or for the review flags, so none is shown.";
const SPARK_FLAG_DESCRIPTIONS = [
  'Attendance counts exactly repeat the previous meeting (PDD §7.2 S-1)',
  'Location worse than 50 m or more than 2 km from the community (PDD §5.4)',
];

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, `../fixtures/cascade/${name}.json`), 'utf8')) as RegistryDocs;

const rules = (text: string) => lintDisplayText(text).map((f) => f.rule);

describe('lintDisplayText — negatives (each rule fires)', () => {
  it('fails the exact Spark targets_note on every rule it breaks', () => {
    const found = lintDisplayText(SPARK_BEFORE);
    expect(found).toEqual(
      expect.arrayContaining([
        { rule: 'design-doc-ref', match: 'PDD' },
        { rule: 'design-doc-ref', match: '§8.1' },
        { rule: 'indicator-code', match: 'P1' },
        { rule: 'indicator-code', match: 'P3' },
        { rule: 'symbol', match: '≥' },
      ]),
    );
  });

  it('fails registry 7748 visit-flag descriptions that cite the PDD', () => {
    expect(rules(SPARK_FLAG_DESCRIPTIONS[0])).toEqual(expect.arrayContaining(['design-doc-ref', 'indicator-code']));
    expect(lintDisplayText(SPARK_FLAG_DESCRIPTIONS[0]).map((f) => f.match)).toContain('S-1');
    expect(rules(SPARK_FLAG_DESCRIPTIONS[1])).toContain('design-doc-ref');
  });

  it.each([
    ['section numbers without a § sign', 'See section 8.1 for targets', 'design-doc-ref'],
    ['a bracketed section number', 'Repeat counts (5.4) are reviewed', 'design-doc-ref'],
    ['a multi-level section number', 'As defined in 7.2.1', 'design-doc-ref'],
    ['a series indicator id', 'Tracks SF_P1 weekly', 'indicator-code'],
    ['a hyphenated metric code', 'The S-1 flag', 'indicator-code'],
    ['an ASCII comparison', 'Communities >= 80%', 'symbol'],
    ['≤', 'Distance ≤ 2 km', 'symbol'],
    ['a bare < before a number', 'Accuracy < 50 m', 'symbol'],
    ['a snake_case column', 'Households (enrolled_households)', 'field-name'],
  ])('fails %s', (_label, text, rule) => {
    expect(rules(text)).toContain(rule);
  });
});

describe('lintDisplayText — positives (plain language passes)', () => {
  it('passes the Spark targets_note rewritten for a programme manager', () => {
    expect(lintDisplayText(SPARK_AFTER)).toEqual([]);
  });

  it.each([
    'No targets are shown: the app defines pass rules (a chlorine test passes at 0.2 mg/L or more; a visit counts within 30 m) but the programme has not set targets.',
    'Of communities on Step 5 or later, the share whose latest meeting reported the community is saving.',
    'Location worse than 50 m or more than 2 km from the community — reviewed, never a payment condition.',
    'Free chlorine (mg/L)',
    'FCAP step',
    'Reported quarterly (Q3 onwards)',
    'Of the full weeks since each dispenser was installed, the share with at least one rider visit.',
  ])('passes %j', (text) => {
    expect(lintDisplayText(text)).toEqual([]);
  });
});

describe('readerFacingTexts', () => {
  it('reads the rendered fields and skips the author-facing ones', () => {
    const doc = {
      display: {
        title: 'T',
        targets_note: 'N',
        entity: { name: 'community', plural: 'communities' },
        case_fields: [{ field: 'step_number', label: 'Step' }],
        visit_fields: [{ field: 'male_attendance', label: 'Men attending' }],
        visit_flags: [{ column: 'repeat_counts_flag', label: 'Repeat count', description: 'D' }],
      },
      measures: [
        { name: 'x', meta: { indicator: 'SF_P1', label: 'L', plain: 'P', scope_note: 'PDD §8.1 P1 — Target ≥ 80%', means: 'PDD §8.1' } },
        { name: 'x_numerator', description: 'PDD §8.1 numerator' },
      ],
    };
    const paths = readerFacingTexts(doc).map((t) => t.path);
    expect(paths).toEqual([
      'display.title',
      'display.targets_note',
      'display.entity.name',
      'display.entity.plural',
      'display.case_fields[0].label',
      'display.visit_fields[0].label',
      'display.visit_flags[0].label',
      'display.visit_flags[0].description',
      'indicator SF_P1 meta.label',
      'indicator SF_P1 meta.plain',
    ]);
    // scope_note / means / description cite the PDD — and must not fail the lint.
    expect(checkRegistryDisplayText(doc).pass).toBe(true);
  });
});

describe('checkRegistryDisplayText over real registries', () => {
  it('passes the chlorine registry (decimals like 0.2 mg/L are not section numbers)', () => {
    const r = checkRegistryDisplayText(fixture('chlorine-registry').indicators_doc);
    expect(r.findings).toEqual([]);
    expect(r.checked).toBeGreaterThan(20);
  });

  it('passes the Spark registry fixture, and fails it with registry 7748\'s targets_note and flag descriptions restored', () => {
    const reg = fixture('spark-facilitator-registry');
    expect(checkRegistryDisplayText(reg.indicators_doc).findings).toEqual([]);

    const broken = structuredClone(reg);
    const display = broken.indicators_doc.display as Record<string, unknown>;
    display.targets_note = SPARK_BEFORE;
    display.visit_flags = [
      { column: 'repeat_counts_flag', label: 'Repeat count', description: SPARK_FLAG_DESCRIPTIONS[0] },
      { column: 'far_from_enrolment_flag', label: 'Far from community', description: SPARK_FLAG_DESCRIPTIONS[1] },
    ];
    const r = checkRegistryDisplayText(broken.indicators_doc);
    expect(r.pass).toBe(false);
    expect(new Set(r.findings.map((f) => f.path))).toEqual(
      new Set(['display.targets_note', 'display.visit_flags[0].description', 'display.visit_flags[1].description']),
    );
  });
});

describe('the gates run it', () => {
  it('semantic-registry-author-qa: display-text fails the restored Spark note and passes the rewrite', () => {
    const reg = fixture('spark-facilitator-registry');
    const ok = checkRegistryAuthoring(reg).findings.filter((f) => f.check === 'display-text');
    expect(ok).toEqual([]);

    const broken = structuredClone(reg);
    (broken.indicators_doc.display as Record<string, unknown>).targets_note = SPARK_BEFORE;
    const bad = checkRegistryAuthoring(broken).findings.filter((f) => f.check === 'display-text');
    expect(bad.length).toBeGreaterThan(0);
    expect(bad.every((f) => f.severity === 'fail')).toBe(true);
    expect(bad[0].detail).toMatch(/display\.targets_note/);
    expect(bad.map((f) => f.detail).join(' ')).toMatch(/the pilot design|at least/);
  });

  it('demo-data-setup-qa: check 28 is an ace-run check, fails Spark 7748 and passes the rewrite', () => {
    expect(checksForProvider('ace-run')).toContain('cascade_registry_text_is_plain');
    const reg = fixture('spark-facilitator-registry');
    expect(checkRegistryTextIsPlain(reg).pass).toBe(true);
    // a semantic_registry_get response nests the docs one level down
    expect(checkRegistryTextIsPlain({ registry: reg }).pass).toBe(true);

    const broken = structuredClone(reg);
    (broken.indicators_doc.display as Record<string, unknown>).targets_note = SPARK_BEFORE;
    const r = checkRegistryTextIsPlain(broken);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/§8\.1/);
    expect(r.auto_fix_hint).toMatch(/semantic-registry-author § 3/);
  });

  it('demo-data-setup-qa: with no registry, check 28 fails rather than passing', () => {
    expect(checkRegistryTextIsPlain(null).pass).toBe(false);
    expect(indicatorsDocOf({})).toBeNull();
  });
});
