import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Class-level preventer for ace#1213: Phase 1 can spec a mechanism ACE will
// not deliver, and no gate catches it until Phase 3 — by which point the
// PDD, the Work Order and the Phase-6 training materials all describe a
// control that does not exist.
//
// The section ships as TWO tables, and the split is the point:
//
//   Table A — closed at the platform surface. No path; the design changes.
//   Table B — buildable, but not something ACE's toolchain produces today.
//             Same PDD behaviour (don't assert it), different escalation
//             path (a capability request, not a dead end).
//
// Collapsing B into A manufactures false platform constraints. That is not
// hypothetical: this section SHIPPED with question-bank randomization in
// the unbuildable table, on two wrong arguments — "XForms can't express it"
// (it can: a seeded once(random()) over a fixture nodeset, or hidden
// questions gated on relevant) and "Connect's single passing_score makes it
// incommensurable" (only true for a VARIABLE-size draw; the spec was a
// fixed 12-of-30, so the denominator is constant and passing_score works
// normally). A false constraint in a Work Order outlives the constraint.
//
// Hence the retired-claims guard below: these specific wrong assertions are
// checked for by name, because a doc can be restructured and still quietly
// carry the claim that made it wrong.

const REPO = join(__dirname, '..', '..');
const LIBRARY = join(REPO, 'skills', '_app-component-library.md');
const SECTION = 'Mechanisms a PDD must not assert';

function librarySource(): string {
  return readFileSync(LIBRARY, 'utf8');
}

/** Extract a section body between its heading and the next same-or-higher heading. */
export function extractSection(source: string, heading: string, level = 2): string {
  const lines = source.split('\n');
  const hashes = '#'.repeat(level);
  const start = lines.findIndex((l) => new RegExp(`^${hashes}\\s+${heading}\\s*$`).test(l));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => new RegExp(`^#{1,${level}}\\s+`).test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** Parse markdown table rows out of a section (excluding header + separator). */
export function tableRows(section: string): string[][] {
  const rows: string[][] = [];
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;
    if (/^\|[\s|:-]+\|$/.test(trimmed)) continue;
    rows.push(trimmed.slice(1, -1).split('|').map((c) => c.trim()));
  }
  return rows.length > 1 ? rows.slice(1) : [];
}

const TABLE_A = 'Table A — closed at the platform surface';
const TABLE_B = "Table B — buildable, but not supported by ACE's toolchain today";

describe('mechanisms a PDD must not assert (ace#1213)', () => {
  it('the section exists and carries BOTH tables', () => {
    expect(existsSync(LIBRARY)).toBe(true);
    const section = extractSection(librarySource(), SECTION);
    expect(section).not.toBe('');
    expect(section, 'Table A (platform-closed) must exist').toContain(TABLE_A);
    expect(section, 'Table B (buildable, unsupported) must exist').toContain(TABLE_B);
  });

  it('seeds the three shipped instances across the two tables', () => {
    const section = extractSection(librarySource(), SECTION);
    const a = tableRows(extractSection(section, TABLE_A, 3));
    const b = tableRows(extractSection(section, TABLE_B, 3));

    expect(a.length, 'Table A must be seeded').toBeGreaterThanOrEqual(2);
    expect(b.length, 'Table B must be seeded').toBeGreaterThanOrEqual(1);

    const aBody = a.map((r) => r.join(' ')).join('\n');
    const bBody = b.map((r) => r.join(' ')).join('\n');

    // Platform-closed: the Connect verification-flags surface, and the
    // JavaRosa calculate-recomputation semantics.
    expect(aBody).toMatch(/ace#1006/);
    expect(aBody).toMatch(/ace#995/);

    // Buildable-but-unsupported: question-bank randomization. It must be in
    // B, and must NOT have crept back into A.
    expect(bBody, 'question-bank randomization belongs in Table B').toMatch(/ace#1121/);
    expect(aBody, 'question-bank randomization must NOT be in Table A').not.toMatch(/ace#1121/);
  });

  it('Table A carries the followup-form case-read closure (ace#1180/#1224/#1232)', () => {
    // Three separately-proven closures, rediscovered one per run as each
    // workaround was reached for in turn: `case-ref` parts rejected app-wide
    // (#1180), `caseWrite` write-only (#1224), and a visible case-bound field
    // emitting no preload (#1232, proven against a compiled CCZ). The row is
    // what stops a fourth guess.
    const section = extractSection(librarySource(), SECTION);
    const rows = tableRows(extractSection(section, TABLE_A, 3));
    const row = rows.find((cells) => /case propert/i.test(cells[0] ?? ''));

    expect(row, 'Table A must carry a "reading a case property into a followup form" row').toBeDefined();
    const [mechanism, why, alternative, origin] = row!;
    expect(mechanism).toMatch(/followup form/i);
    for (const issue of ['1180', '1224', '1232']) {
      expect(why, `the row must name the surface closed by ace#${issue}`).toMatch(
        new RegExp(`ace#${issue}|#${issue}`),
      );
    }
    expect(alternative, 'the row must name the sanctioned alternative').toMatch(
      /user-ref|re-ask|select/i,
    );
    expect(origin).toMatch(/ace#\d+/);
  });

  it('every row names a mechanism, a status, an alternative, and an origin', () => {
    const section = extractSection(librarySource(), SECTION);
    const rows = [
      ...tableRows(extractSection(section, TABLE_A, 3)),
      ...tableRows(extractSection(section, TABLE_B, 3)),
    ];
    const defective: string[] = [];

    for (const cells of rows) {
      const label = (cells[0] ?? '(blank)').slice(0, 60);
      if (cells.length < 4) {
        defective.push(`${label}: expected 4 columns, got ${cells.length}`);
        continue;
      }
      const [, why, alternative, origin] = cells;
      if (why.length < 40) defective.push(`${label}: status/reason too thin to verify`);
      if (alternative.length < 30) defective.push(`${label}: no usable alternative`);
      if (!/ace#\d+|#\d+/.test(origin)) defective.push(`${label}: origin cites no issue`);
    }

    expect(
      defective,
      'Every row must name the mechanism, its verified status, what ACE does ' +
        'instead, and an origin issue — see the section\'s "How to add a row" bar.',
    ).toEqual([]);
  });

  it('does not resurrect the two retired false claims about randomization', () => {
    // Both of these shipped and both were wrong. Named explicitly so a
    // future rewrite cannot quietly reintroduce them.
    const source = librarySource();
    const producer = readFileSync(join(REPO, 'skills', 'idea-to-pdd', 'SKILL.md'), 'utf8');

    for (const [name, text] of [
      ['_app-component-library.md', source],
      ['idea-to-pdd/SKILL.md', producer],
    ] as const) {
      expect(
        text,
        `${name}: "incommensurable" was the wrong argument — a FIXED-size draw ` +
          `keeps the denominator constant, so Connect's single passing_score is ` +
          `not violated. Do not restore it.`,
      ).not.toMatch(/incommensurable/i);

      expect(
        text,
        `${name}: must not claim CommCare/XForms cannot randomize — it can ` +
          `(seeded once(random()) over a fixture nodeset, or hidden questions ` +
          `gated on relevant).`,
      ).not.toMatch(/CommCare (has no|cannot) random/i);
    }
  });

  it('keeps the evidence-discipline rule and the default-to-Table-B tiebreak', () => {
    const section = extractSection(librarySource(), SECTION);
    expect(section).toMatch(/Evidence discipline/i);
    expect(section).toMatch(/verified at the surface/i);
    // The tiebreak is what stops the next over-claim.
    expect(
      section,
      'The section must say that an uncertain mechanism defaults to Table B.',
    ).toMatch(/when in doubt it goes in \*\*table b\*\*/i);
  });

  it('the producer and the grader both point at the section', () => {
    const producer = readFileSync(join(REPO, 'skills', 'idea-to-pdd', 'SKILL.md'), 'utf8');
    const grader = readFileSync(join(REPO, 'skills', 'idea-to-pdd-eval', 'SKILL.md'), 'utf8');

    for (const [name, source] of [
      ['idea-to-pdd', producer],
      ['idea-to-pdd-eval', grader],
    ] as const) {
      expect(source, `${name}/SKILL.md must reference § ${SECTION}`).toMatch(
        // Whitespace-tolerant: the reference legitimately wraps in prose.
        /Mechanisms a PDD\s+must not assert/i,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The build side of the same class. A PDD that must not ASSERT a mechanism is
// half the preventer; the other half is that the build skill must not INSTRUCT
// it. Four defects hit live in one day, all in Phase 3, all of them the skill
// text telling the architect to do the wrong thing:
//
//   ace#1232  the case-UPDATE entity_id rule mandated a case read that is
//             closed on all three surfaces — and the same section claimed
//             `parts` joins its members, which compiles a bare " - " separator
//             to XPath SUBTRACTION (key = NaN = one payable entity, programme-
//             wide, with no error anywhere).
//   ace#1224  a hidden caseWrite field with a literal default_value looks like
//             a preload, holds the literal forever, and writes it back over
//             the case property. Nothing catches it structurally.
//   ace#1223  consent-script-floor was read as not firing when the PDD is
//             silent about consent — it must fire on photo capture alone.
//   ace#1238  app-hq-settings' <case>-substring guard tripped on Nova's own
//             __nova_operations SaveToCase block, so camera-only could never
//             apply and app-release-qa then halted for its absence.
//
// These assertions are static because the guidance is static. A skill is prose
// an LLM executes: the wrong sentence IS the defect.
// ---------------------------------------------------------------------------

const DELIVER = join(REPO, 'skills', 'pdd-to-deliver-app', 'SKILL.md');
const HQ_SETTINGS = join(REPO, 'skills', 'app-hq-settings', 'SKILL.md');

/**
 * Collapse markdown wrapping so a prose assertion survives a re-wrap.
 * Skill text is hard-wrapped and heavily blockquoted; matching raw source
 * would make every one of these tests a formatting tripwire instead of a
 * claim about what the skill says.
 */
function flatten(md: string): string {
  return md.replace(/\n\s*>?\s*/g, ' ');
}

describe('pdd-to-deliver-app entity_id guidance (ace#1232)', () => {
  const deliver = () => readFileSync(DELIVER, 'utf8');

  it('states that parts is XPath source, and never that it concatenates for you', () => {
    const source = deliver();

    expect(
      source,
      '`entity_id.parts` is interpolated RAW into XPath. Claiming it joins ' +
        'its members produces a bare " - " separator, which is the XPath minus ' +
        'operator — the key evaluates to NaN for every worker (ace#1232).',
    ).not.toMatch(/concatenat\w*\s+natively/i);

    expect(flatten(source), 'the rule itself must be stated').toMatch(
      /`parts` is XPath SOURCE/i,
    );
    // The only correct construction: an explicit concat() the author writes,
    // with the separator quoted INSIDE it.
    expect(source).toMatch(/text:\s*"concat\("/);
    expect(source).toMatch(/text:\s*", ' - ', "/);
  });

  it('does not mandate a case-ref (or any case read) for a followup entity_id', () => {
    const source = flatten(deliver());

    // Named retired claims — each one shipped, each one was false.
    expect(
      source,
      'A visible/hidden case-bound field does NOT preload on this Nova ' +
        'instance (ace#1232, proven against a compiled CCZ). Do not restore it.',
    ).not.toMatch(/case-bound fields open pre-filled/i);

    expect(
      source,
      "Nova's \"preload mechanic\" is not a mechanism a brief can request " +
        '(ace#1224/#1232) — do not point the architect at it.',
    ).not.toMatch(/preload\s+mechanic/i);

    // And the positive form: the closure is stated, with all three surfaces.
    expect(source).toMatch(/MUST NOT depend on reading the case back/i);
    for (const issue of ['1180', '1224', '1232']) {
      expect(source, `the case-UPDATE rule must cite ace#${issue}`).toMatch(
        new RegExp(`ace#${issue}`),
      );
    }
    // The sanctioned alternative.
    expect(source).toMatch(/kind:\s*"user-ref"/);
  });

  it('carries the fake-preload structural step, with the payment halt (ace#1224)', () => {
    const raw = deliver();
    const source = flatten(raw);

    expect(raw, 'a sibling step of 4a–4g must enumerate the shape').toMatch(/^4h\./m);
    // The three parts of the check that make it more than a lint.
    expect(source, 'the defect shape: hidden + caseWrite + literal default').toMatch(
      /`kind == "hidden"`/,
    );
    expect(
      source,
      'feeding entity_id/entity_name is payment correctness — it must HALT',
    ).toMatch(/\*\*HALT if any of them feeds a `connect\.deliver_unit`/);
    expect(
      source,
      'the dead-advisory mode is invisible to an entity_id-only scan',
    ).toMatch(/hidden field referenced by a `relevant`/);
    expect(
      source,
      'hidden is terminal in Nova — the repair is add-and-neutralise, never convert',
    ).toMatch(/TERMINAL kind in Nova/);
  });

  it('fires consent-script-floor on photo capture alone (ace#1223)', () => {
    // Two misses on the same opp: 20260731-0656 shipped 4/6, 20260812-1635
    // shipped 0/6 on an app photographing 8+ identifiable people. Both PDDs
    // were silent about consent, which is exactly when it must still fire.
    const source = flatten(deliver());
    const library = flatten(librarySource());

    for (const [name, text] of [
      ['pdd-to-deliver-app/SKILL.md', source],
      ['_app-component-library.md', library],
    ] as const) {
      expect(
        text,
        `${name}: the consent floor must fire on image capture whether or not ` +
          `the PDD mentions consent at all (ace#1223).`,
      ).toMatch(/silent\W{0,2}about consent/i);
    }

    expect(
      source,
      'the trigger must be tied to live-photo-capture so one detection drives both',
    ).toMatch(/same condition as `live-photo-capture`/i);
  });
});

describe('app-hq-settings case-block prediction is deleted (ace#1238)', () => {
  const hq = () => readFileSync(HQ_SETTINGS, 'utf8');

  it('carries no pre-patch halt on a <case> block — not even a narrowed one', () => {
    const source = flatten(hq());

    // The retired claim, named so it cannot come back from the same
    // intuition. It had no reproducer anywhere in the repo, and it fired on
    // every ACE Deliver app that writes case properties.
    // The old guard's own instructions, by name. (Its "this should never
    // fire on a Deliver photo form" wording survives as a QUOTED postmortem,
    // which is the point — so these match the imperative, not the quote.)
    expect(
      source,
      'The pre-patch scan is the defect: Nova emits a <case> element inside ' +
        '__nova_operations on every app that writes case properties, so it ' +
        'fired everywhere and camera-only could never apply.',
    ).not.toMatch(/scan the fetched `xform_xml` for a `<case>` block/i);

    expect(
      source,
      'and the halt it drove must be gone too.',
    ).not.toMatch(/halt the form and surface it rather than risk the drift/i);

    expect(
      source,
      'A narrower scan is still a guess — the prediction must be DELETED, ' +
        'not tightened.',
    ).not.toMatch(/\*\*Halt\*\* on a `<case>` block/);

    expect(source, 'the deletion must be stated so nobody reinstates it').toMatch(
      /pre-patch halt is DELETED/i,
    );
    expect(
      source,
      'and the reason must be recorded: no reproducer ever existed',
    ).toMatch(/no recorded reproducer/i);

    // A breadcrumb is fine; blocking is not.
    expect(source, 'the non-blocking INFO breadcrumb must survive').toMatch(
      /Breadcrumb only, never blocking/i,
    );
    expect(source).toMatch(/__nova_operations/);
  });

  it('makes commcare_make_build the authority on the drift class', () => {
    const source = flatten(hq());

    // "Attempt the transition and treat the conflict as the skip" — a
    // substring scan predicting the rejection is the read-back-flag
    // anti-pattern the fix exists to remove.
    expect(source).toMatch(/commcare_make_build/);
    expect(source, 'the HQ rejection is the real signal, and must be named').toMatch(
      /Cannot use Case Management UI if you already have a case block in your form/,
    );
    expect(
      source,
      'the failure-modes table must carry the make_build rejection row',
    ).toMatch(/`commcare_make_build` rejects with "Cannot use Case Management UI/);
  });

  it('the skills author contract requires a reproducer behind any such guard', () => {
    // Three uncited predictions landed in one day (ace#1224, #1232, #1238).
    // The convention is the class-level preventer for the next one.
    const readme = flatten(readFileSync(join(REPO, 'skills', 'README.md'), 'utf8'));
    expect(readme).toMatch(/must cite a reproducer/i);
    expect(
      readme,
      'and it must say that narrowing an uncited guard is not the fix',
    ).toMatch(/a narrower guess is still a guess/i);
  });
});

describe('section/table parsing helpers', () => {
  it('extracts a section and stops at the next heading', () => {
    expect(extractSection(['## A', 'body a', '## B', 'body b'].join('\n'), 'A').trim()).toBe(
      'body a',
    );
  });

  it('extracts a level-3 subsection without swallowing the next one', () => {
    const doc = ['### One', 'a', '### Two', 'b'].join('\n');
    expect(extractSection(doc, 'One', 3).trim()).toBe('a');
  });

  it('returns empty for a missing section', () => {
    expect(extractSection('## A\nbody', 'Nope')).toBe('');
  });

  it('drops the header and separator rows', () => {
    const section = ['| M | Why | Alt | Origin |', '|---|---|---|---|', '| a | b | c | d |'].join(
      '\n',
    );
    expect(tableRows(section)).toEqual([['a', 'b', 'c', 'd']]);
  });
});
