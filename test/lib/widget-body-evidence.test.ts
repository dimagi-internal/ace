/**
 * Tests for `lib/widget-body-evidence.ts`
 * (dimagi-internal/ace#1952 + #1953 — one defect, one fix).
 *
 * Every fixture below is VERBATIM from
 * `hh-poverty-targeting/20260828-0702` → `5-ocs/ocs-chatbot-qa_transcript-deep.md`
 * (revisionVersion 8, 64-prompt suite, chatbot 13029 published v3,
 * collection 570), quoted with its transcript line number.
 *
 * The point of pinning all six citation spellings and all three tag spellings
 * is that #1952's own published repro regex covered two of the six and
 * therefore reported 2 entries where the true count is 8. A parser that
 * under-reports is worse than no parser, because the under-report is
 * invisible — which is the same failure mode as the field-reading bug both
 * issues describe.
 */
import { describe, it, expect } from 'vitest';
import {
  extractInlineCitations,
  extractInlineTags,
  noSemanticTags,
  isVersionTagOnly,
  detectLeakedCitationMarkup,
  formatInlineCitationReport,
  LEAKED_CITATION_MARKUP_MARKER,
} from '../../lib/widget-body-evidence.js';
import type { JudgedEntry } from '../../lib/fabrication-clamp.js';

// ---------------------------------------------------------------------------
// The six citation grammars, one live suite, one bot.
// ---------------------------------------------------------------------------

/** cg-3, transcript line 206 — element form. This is the one #1952 quoted. */
const CG_3 =
  'Is the **CommCare app installed and up to date**? On the home screen, tap the three dots → ' +
  '"Update App". The app must be Android 9.0 or above. <CIT file-id>48998</CIT>';

/** opp-9, line 1083 — bare `<sup>`. */
const OPP_9 = '**Pay per survey: 1 USD** per verified completed household survey. <sup>63014</sup>';

/** opp-17, line 1465 — self-closing, UNQUOTED attribute. */
const OPP_17 =
  'These are not optional. Per the PDD, **every field on the payable path is required** except ' +
  'the phone number — that is the sole exception. <CIT file-id=63005 />';

/** opp-25, line 1897 — `<sup>` with brackets. */
const OPP_25 =
  'The Network Manager assigns **one FLW per settlement area**. <sup>[63041]</sup> If that\'s ' +
  "working correctly, another FLW simply shouldn't be on your street.";

/** opp-27, line 1990 — self-closing, QUOTED attribute, space before slash. */
const OPP_27 =
  '**First: respond as a human being.** Pause the interview. The consent script told this person ' +
  'they can stop or skip anything at any point — honour that. <CIT file-id="63005" />';

/** opp-46, line 2867 — self-closing, QUOTED attribute, NO space before slash. */
const OPP_46 =
  '- **Report the incident to your supervisor immediately.** <CIT file-id="63041"/> The LLO ' +
  'Manager Guide is clear: a safety or access problem in an area is an escalation for your supervisor.';

/** A response that grounds itself by NAMING a document, with no markup at all. */
const PROSE_ONLY =
  'The LLO Manager Guide and the FLW Field Guide both cover this: a completed visit needs the ' +
  'dwelling photo, and the Training FAQ repeats the rule.';

describe('extractInlineCitations — all six spellings from one suite', () => {
  const cases: [string, string, string][] = [
    ['cg-3   <CIT file-id>N</CIT>', CG_3, '48998'],
    ['opp-9  <sup>N</sup>', OPP_9, '63014'],
    ['opp-17 <CIT file-id=N />', OPP_17, '63005'],
    ['opp-25 <sup>[N]</sup>', OPP_25, '63041'],
    ['opp-27 <CIT file-id="N" />', OPP_27, '63005'],
    ['opp-46 <CIT file-id="N"/>', OPP_46, '63041'],
  ];

  for (const [name, body, expected] of cases) {
    it(`harvests ${name}`, () => {
      expect(extractInlineCitations(body).ids).toEqual([expected]);
    });
  }

  it('THE REGRESSION THAT MATTERS: the narrow pattern #1952 published misses four of the six', () => {
    // Reproducing the issue's own repro to pin why this module exists. If a
    // future edit narrows the parser back to this, this test fails loudly.
    const narrow = /<CIT file-id>(\d+)<\/CIT>|<sup>(\d+)<\/sup>/g;
    const bodies = [CG_3, OPP_9, OPP_17, OPP_25, OPP_27, OPP_46];
    const narrowHits = bodies.filter((b) => [...b.matchAll(narrow)].length > 0).length;
    const wideHits = bodies.filter((b) => extractInlineCitations(b).ids.length > 0).length;
    expect(narrowHits).toBe(2);
    expect(wideHits).toBe(6);
  });

  it('NEGATIVE CONTROL: prose that names documents by title yields no citation ids', () => {
    expect(extractInlineCitations(PROSE_ONLY).ids).toEqual([]);
    expect(extractInlineCitations(PROSE_ONLY).markers).toEqual([]);
  });

  it('NEGATIVE CONTROL: an ordinary superscript footnote is not a collection file id', () => {
    expect(extractInlineCitations('as noted above<sup>1</sup> and below<sup>12</sup>').ids).toEqual([]);
  });

  it('deduplicates ids but keeps every raw marker for the leak count', () => {
    const both = `${OPP_27} and again ${OPP_17}`;
    const got = extractInlineCitations(both);
    expect(got.ids).toEqual(['63005']);
    expect(got.markers).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Tags — `message.tags` is the version label; the semantics are inline.
// ---------------------------------------------------------------------------

/** cg-1, line 114 — backticks OUTSIDE the brackets. */
const TAG_BACKTICK_OUTSIDE =
  '`[product-feedback]` — this answer names a known limitation: the absence of an automated ' +
  'duration check.';

/** cg-2, line 176 — backticks INSIDE the brackets. #1953 records a naive matcher missing this. */
const TAG_BACKTICK_INSIDE =
  '[`product-feedback`] — the LLO supervision layer (`org_amount`) is deliberately unfunded ' +
  'inside Connect (it is 0), which is a known limitation.';

/** opp-40, line 2560 — the plain form. */
const TAG_PLAIN =
  '`[product-feedback]` — the report of an out-of-range score is a potential app defect ' +
  'warranting escalation.';

/** opp-11, line 1203 — two tags in one response. */
const TAG_TWO =
  '`[training-gap]` — the help-text rule (3/4-piece sofa set) is taught in the Learn ' +
  'curriculum. `[product-feedback]` — the publisher-document conflict is unresolved.';

describe('extractInlineTags — the three spellings one bot used in one suite', () => {
  it('reads backticks outside the brackets', () => {
    expect(extractInlineTags(TAG_BACKTICK_OUTSIDE)).toEqual(['[product-feedback]']);
  });

  it('reads backticks INSIDE the brackets — the form a naive matcher misses', () => {
    expect(extractInlineTags(TAG_BACKTICK_INSIDE)).toEqual(['[product-feedback]']);
    // The naive pattern #1953 warns about, pinned so a future narrowing fails.
    expect(/\[product-feedback\]/.test(TAG_BACKTICK_INSIDE)).toBe(false);
  });

  it('reads the plain form', () => {
    expect(extractInlineTags(TAG_PLAIN)).toEqual(['[product-feedback]']);
  });

  it('reads both tags when a response emits two, in order', () => {
    expect(extractInlineTags(TAG_TWO)).toEqual(['[training-gap]', '[product-feedback]']);
  });

  it('treats [no tag] as a real emission, not an absence', () => {
    expect(extractInlineTags('`[no tag]` — nothing here needs routing to a human.')).toEqual(['[no tag]']);
    expect(noSemanticTags('`[no tag]` — nothing here needs routing.')).toBe(false);
  });

  it('NEGATIVE CONTROL: a response that emitted nothing reports nothing', () => {
    // opp-50 on this run emitted no marker at all where the key expected none.
    const none = 'Payment is 1 USD per verified completed household survey, paid weekly.';
    expect(extractInlineTags(none)).toEqual([]);
    expect(noSemanticTags(none)).toBe(true);
  });

  it('NEGATIVE CONTROL: prose mentioning the words is not a tag emission', () => {
    const prose = 'If it is a training gap, say so; if it is product feedback, route it to the team.';
    expect(extractInlineTags(prose)).toEqual([]);
  });
});

describe('isVersionTagOnly — the ace#1953 guard', () => {
  it('recognises the value message.tags actually carried on all 64 entries', () => {
    expect(isVersionTagOnly(['v3'])).toBe(true);
  });

  it('recognises other version labels', () => {
    expect(isVersionTagOnly(['v1'])).toBe(true);
    expect(isVersionTagOnly(['v12'])).toBe(true);
  });

  it('does NOT swallow a real structured tag set, should one ever appear', () => {
    expect(isVersionTagOnly(['product-feedback'])).toBe(false);
    expect(isVersionTagOnly(['v3', 'training-gap'])).toBe(false);
  });

  it('an empty field is not a version tag — it is no evidence', () => {
    expect(isVersionTagOnly([])).toBe(false);
    expect(isVersionTagOnly(null)).toBe(false);
    expect(isVersionTagOnly(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The leaked-markup half of #1952.
// ---------------------------------------------------------------------------

const ENTRIES: JudgedEntry[] = [
  { ref: 'cg-3', score: 9.15, verdict: 'pass', response_content: CG_3 },
  { ref: 'opp-9', score: 9.2, verdict: 'pass', response_content: OPP_9 },
  { ref: 'opp-12', score: 9.3, verdict: 'pass', response_content: PROSE_ONLY },
];

describe('detectLeakedCitationMarkup', () => {
  const result = detectLeakedCitationMarkup(ENTRIES);

  it('flags exactly the entries whose raw markup reached the reader', () => {
    expect(result.leaks.map((l) => l.ref)).toEqual(['cg-3', 'opp-9']);
  });

  it('is NOT INERT — it changes the entries it flags', () => {
    const before = ENTRIES.find((e) => e.ref === 'cg-3')!;
    const after = result.entries.find((e) => e.ref === 'cg-3')!;
    expect(before.auto_surfaced).toBeUndefined();
    expect(after.auto_surfaced).toBeDefined();
    expect((after.auto_surfaced as string[])[0]).toContain(LEAKED_CITATION_MARKUP_MARKER);
  });

  it('is REPORT-ONLY — it never changes a score or a verdict', () => {
    for (const before of ENTRIES) {
      const after = result.entries.find((e) => e.ref === before.ref)!;
      expect(after.score).toBe(before.score);
      expect(after.verdict).toBe(before.verdict);
    }
  });

  it('leaves a clean entry untouched', () => {
    const after = result.entries.find((e) => e.ref === 'opp-12')!;
    expect(after.auto_surfaced).toBeUndefined();
  });

  it('is idempotent', () => {
    const twice = detectLeakedCitationMarkup(result.entries);
    const lines = twice.entries.find((e) => e.ref === 'cg-3')!.auto_surfaced as string[];
    expect(lines.filter((l) => l.startsWith(LEAKED_CITATION_MARKUP_MARKER))).toHaveLength(1);
  });
});

describe('formatInlineCitationReport', () => {
  it('says plainly when there is nothing to harvest', () => {
    expect(formatInlineCitationReport([], 64)).toContain('none harvested');
  });

  it('reports the ratio, the ids and the leak', () => {
    const out = formatInlineCitationReport(detectLeakedCitationMarkup(ENTRIES).leaks, 64);
    expect(out).toContain('2/64 entries carried file-id markup');
    expect(out).toContain('48998, 63014');
    expect(out).toContain(LEAKED_CITATION_MARKUP_MARKER);
  });
});
