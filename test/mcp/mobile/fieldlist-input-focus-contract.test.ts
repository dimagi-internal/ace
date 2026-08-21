import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────
// CLASS-LEVEL PREVENTER — a technique validated on-device may not be
// re-prohibited by the prose that authors against it.
//
// dimagi-internal/ace#1547. ace#1299 established that `tapOn: below:
// <question label>` is inert for any CommCare form question carrying a
// `hint` — the calibrated layout order is `label TextView -> optional hint
// TextView -> EditText`, so the anchor resolves to the hint and the tap
// lands on a TextView. Its own follow-up comment then PROVED the
// replacement on-device (isolated probe, spark-facilitator/20260813-2126:
// `cbf_name` = 'PROBE-NAME' and `phone_number` = '0991234567' each landed
// in its own field), and the issue closed COMPLETED on that basis.
//
// PR #1397 landed ~14h after that comment and still told authors both
// replacement idioms "remain **uncalibrated** — do not emit either until
// one is proven on a live device". Read literally that makes any Deliver
// field-list with more than one text input unauthorable: Step 2.6 halts
// `[BLOCKER]` and Phase 6 captures zero Deliver screenshots
// (hh-poverty-targeting/20260819-1435). The defect was pure prose —
// nothing in the harness could see it, and it survived two later passes
// over the same paragraph, one of which copied the prohibition forward
// into `docs/mobile-atlas/connect-2.63.2.md`.
//
// So pin the sanctioned technique in every place that teaches it. The
// assertions are one-directional: the validated rule must be PRESENT and
// the retracted prohibition ABSENT. Narrowing the rule on new device
// evidence stays allowed — it just has to happen here, deliberately,
// rather than by a paragraph drifting back.

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');

const SKILL_PATH = 'skills/app-test-cases/SKILL.md';
const ATLAS_PATH = 'docs/mobile-atlas/connect-2.63.2.md';
const PROBE_PATH = 'mcp/mobile/recipe-sanity-probe.ts';

/** Phrasings that put the hint anchor back behind a do-not-use bar. */
const RETRACTS_HINT_ANCHOR = [
  /hint[- ]anchored[^.]*\b(uncalibrated|do not emit|must not|not proven)\b/i,
  /\bhint\b[^.]*\bdo not emit\b/i,
  /anchoring on the hint[^.]*\buncalibrated\b/i,
];

/**
 * Blank-line-separated paragraphs, each flattened to a single line and
 * tagged with the line it starts on.
 *
 * Scanning line-by-line is not enough: the retracted prohibition was
 * hard-wrapped across four lines ("Anchoring on the HINT text where one
 * exists, or on index within the / field-list, both remain **uncalibrated**
 * — do not emit either until / one is proven on a live device…"), so no
 * single line carried both halves of the claim. Flattening first is what
 * makes this rail non-vacuous against the exact text it exists to keep out.
 * Sentence boundaries still bound each match (`[^.]`), so a paragraph that
 * says "…is calibrated. Index-based anchoring is not." does not trip.
 */
function paragraphs(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let start = -1;
  let buf: string[] = [];
  const flush = (): void => {
    if (buf.length > 0) out.push({ line: start + 1, text: buf.join(' ') });
    buf = [];
    start = -1;
  };
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') {
      flush();
      return;
    }
    if (start < 0) start = i;
    buf.push(line.trim());
  });
  flush();
  return out;
}

describe('app-test-cases field-list input focus contract', () => {
  const skill = read(SKILL_PATH);
  const atlas = read(ATLAS_PATH);
  const probe = read(PROBE_PATH);

  for (const [name, text] of [
    [SKILL_PATH, skill],
    [ATLAS_PATH, atlas],
  ] as const) {
    it(`${name} states the anchor rule ace#1299 validated on-device`, () => {
      expect(
        text,
        'the focus anchor is the element immediately above the EditText — say so verbatim (ace#1299)',
      ).toMatch(/element immediately above the `EditText`/);
      expect(
        text,
        "…and name which element that is: the field's `hint` when it has one, the question label when it does not",
      ).toMatch(/`hint` when it has one, the question label when it does not/);
    });

    it(`${name} does not re-forbid the hint anchor`, () => {
      const offenders = paragraphs(text).filter(({ text: para }) =>
        RETRACTS_HINT_ANCHOR.some((re) => re.test(para)),
      );
      expect(
        offenders.map((o) => `${name}:${o.line} ${o.text.slice(0, 140)}`),
        'ace#1299 proved the hint-anchored focus tap on a live device and closed COMPLETED; ' +
          'restoring the "uncalibrated / do not emit" bar makes multi-input field-list Deliver ' +
          'forms unauthorable and deadlocks Phase 3 Step 2.6 (ace#1547)',
      ).toEqual([]);
    });
  }

  it('SKILL.md keeps BOTH scroll shapes and the discriminator between them', () => {
    // The guarded shape is ace#1070's: an unconditional scroll on an option
    // that already fits reads as backward form navigation and exits the
    // form. The unconditional shape is ace#1299's: when the anchor is a
    // DIFFERENT element from the tap target, `notVisible: <anchor>` cannot
    // see "anchor visible, its EditText still below the fold". Deleting
    // either re-opens the bug it closes, so both are pinned.
    expect(skill, 'the guarded option-tap scroll (ace#1070) must survive').toMatch(
      /when:\s*\n\s*notVisible:/,
    );
    expect(skill, 'the unconditional input-focus scroll (ace#1299) must be present').toMatch(
      /\*\*unconditional\*\* centring scroll/,
    );
    expect(
      skill,
      'and the rule for choosing between them — whether the anchor IS the tap target',
    ).toMatch(/whether the anchor IS[\s\S]{0,40}the tap target/);
  });

  it('SKILL.md does not prescribe the overshooting scroll speed', () => {
    // ace#1299: at `speed: 80` the centring scroll overshot a ~300px radio
    // band and halted the leg. Every scroll snippet here is now `speed: 30`.
    const speeds = (skill.match(/^\s*speed:\s*\d+\s*$/gm) ?? []).map((line) =>
      Number(line.split(':')[1].trim()),
    );
    expect(speeds.length, 'the authoring snippets must still carry scroll speeds').toBeGreaterThan(
      0,
    );
    expect(
      speeds.filter((n) => n > 40),
      'authoring snippets must not teach speed > 40 — ace#1299 measured the overshoot at 80',
    ).toEqual([]);
  });

  it('the sanity probe does not remediate toward the inert bare `below:` tap', () => {
    // `group-field-list-per-question-walk` told authors to fix a bad walk
    // with "a bare below:-scoped tap then inputText" — precisely the idiom
    // ace#1299 proved inert. A remediation string is authoring guidance
    // too, so it has to agree with the skill (ace#1547).
    expect(probe, 'ace#1547').not.toMatch(/bare below:-scoped tap/);
    expect(probe, 'the probe must name the calibrated sequence instead').toMatch(
      /tapOn: below: that anchor/,
    );
  });
});
