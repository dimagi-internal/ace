import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Class-level preventer for the 2026-08-14 English-only decision (ace#968).
//
// The hazard is specific and it is NOT "someone deletes a doc line". Between
// 2026-07-30 and 2026-08-14 the SANCTIONED mechanism was to stack every
// language inline in one label, and that instruction was written into four
// skills, two rubrics and a component brief. Reverting is therefore the cheap
// direction: any future edit that reaches for "complete translation coverage"
// restores a mechanism Jon explicitly retired as a fake, and — because the
// eval dimension inverted rather than disappeared — a stale rubric line does
// not fail loudly, it silently grades every correct build as broken.
//
// So this file pins the INVERSION, not just the presence of a doc:
//   1. the component exists under its new name, and the retired one is gone
//   2. no build skill still instructs inline stacking / translation coverage
//   3. both rubrics grade `language_conformance`, and `localization_match`
//      survives only as history (change log + explicitly amended anchors)
//   4. Phase 1 still records the working language but must not promise a
//      translated app
const REPO = join(__dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(REPO, ...p), 'utf8');

const LIBRARY = ['skills', '_app-component-library.md'] as const;
const BUILD_SKILLS = [
  ['skills', 'pdd-to-learn-app', 'SKILL.md'],
  ['skills', 'pdd-to-deliver-app', 'SKILL.md'],
] as const;
const RUBRICS = [
  ['skills', 'pdd-to-learn-app-eval', 'SKILL.md'],
  ['skills', 'pdd-to-deliver-app-eval', 'SKILL.md'],
] as const;

/** Strip change-log table rows: history is allowed to name the retired mechanism. */
function withoutChangeLog(source: string): string {
  return source
    .split('\n')
    .filter((l) => !/^\|\s*20\d\d-\d\d-\d\d\s*\|/.test(l))
    .join('\n');
}

describe('English-only app UI (ace#968, 2026-08-14)', () => {
  it('the component ships under its new name and the retired one is gone', () => {
    const lib = read(...LIBRARY);
    expect(lib).toMatch(/^### english-only-ui$/m);
    expect(
      lib,
      'the `localization-layer` component heading must not come back — it named ' +
        'inline stacking as the sanctioned mechanism',
    ).not.toMatch(/^### localization-layer$/m);
  });

  it('the component states the decision and cites the live re-verification', () => {
    const lib = read(...LIBRARY);
    const section = lib.slice(lib.indexOf('### english-only-ui'));
    const body = section.slice(0, section.indexOf('\n---'));
    expect(body, 'must name the standing decision').toMatch(/ENGLISH ONLY|English-only/);
    // The claim "Nova has no itext channel" is a fact about another system, so
    // it must carry the date + surface it was checked against, per the repo's
    // close-the-loop rule. A bare assertion here is what went stale last time.
    expect(body, 'must cite the date it was verified live').toMatch(/2026-08-14/);
    expect(body, 'must cite the surface + scale it was verified against').toMatch(/81 tools/);
  });

  it('no build skill instructs inline language stacking any more', () => {
    const offenders: string[] = [];
    for (const parts of [...BUILD_SKILLS, LIBRARY]) {
      const body = withoutChangeLog(read(...parts));
      // The retired instruction, in the shapes it actually shipped in.
      for (const [label, re] of [
        ['inline multilingual authoring', /inline multilingual/i],
        ['"complete translation coverage" requirement', /complete (translation|language) coverage/i],
        ['"English-only is a hard fail"', /English-only\b[^.\n]{0,40}hard[- ]fail/i],
      ] as const) {
        if (re.test(body)) offenders.push(`${parts.join('/')}: still carries ${label}`);
      }
    }
    expect(
      offenders,
      'ACE builds English-only UIs. These phrases restore the retired mechanism ' +
        '(see _app-component-library.md § english-only-ui).',
    ).toEqual([]);
  });

  it('both build skills emit the english-only-ui component by name', () => {
    for (const parts of BUILD_SKILLS) {
      const body = read(...parts);
      expect(body, `${parts[1]} must emit \`english-only-ui\``).toMatch(/english-only-ui/);
      expect(body, `${parts[1]} must not emit the retired component`).not.toMatch(
        /localization-layer/,
      );
    }
  });

  it('both rubrics grade language_conformance, not localization_match', () => {
    for (const parts of RUBRICS) {
      const raw = read(...parts);
      const body = withoutChangeLog(raw);
      expect(body, `${parts[1]}: dimension must be renamed`).toMatch(/language_conformance/);
      expect(body, `${parts[1]}: weight line must be renamed`).toMatch(
        /language_conformance:\s*\{ weight: 0\.08 \}/,
      );

      // `localization_match` may survive ONLY inside an explicitly amended
      // calibration anchor — the anchor has to say the clause was removed,
      // because an un-amended anchor is what re-teaches the old verdict.
      for (const line of body.split('\n')) {
        if (!/localization_match/.test(line)) continue;
        const idx = body.indexOf(line);
        const context = body.slice(Math.max(0, idx - 600), idx + 600);
        expect(
          context,
          `${parts[1]}: a surviving \`localization_match\` mention must sit in an ` +
            `anchor explicitly amended on 2026-08-14 — otherwise it still teaches ` +
            `the retired verdict. Offending line: ${line.trim().slice(0, 90)}`,
        ).toMatch(/[Aa]nchor amended\s+2026-08-14|amended\s*\n?2026-08-14/);
      }
    }
  });

  it('the rubrics warn the judge that the dimension inverted', () => {
    // A judge re-reading this rubric carries months of "English-only = fail"
    // in its own priors. The criteria must say so out loud.
    for (const parts of RUBRICS) {
      const body = read(...parts);
      expect(body, `${parts[1]}: must flag the inversion to the judge`).toMatch(
        /inverted|mirror image/i,
      );
      expect(
        body,
        `${parts[1]}: must state that absent translations are NOT a deduction`,
      ).toMatch(/[Dd]o NOT deduct for the absence of translations/);
    }
  });

  it('multilingual UI is a Table B row, never a platform limit', () => {
    const lib = read(...LIBRARY);
    const section = lib.slice(lib.indexOf('### Table B'));
    const tableB = section.slice(0, section.indexOf('\n**Evidence discipline'));
    expect(tableB, 'Table B must carry the multilingual-UI row').toMatch(/multilingual app UI/i);
    // CommCare/XForms DO support itext. Calling this a platform limit is the
    // over-claim the section's own evidence-discipline rule forbids.
    expect(tableB, 'the row must say CommCare can express it').toMatch(
      /Expressible in CommCare/i,
    );

    const tableAStart = lib.indexOf('### Table A');
    const tableA = lib.slice(tableAStart, lib.indexOf('### Table B'));
    expect(
      tableA,
      'multilingual UI must NOT be in Table A — itext exists in CommCare; it is ' +
        "ACE's builder that is closed",
    ).not.toMatch(/multilingual app UI/i);
  });

  it('Phase 1 records the working language but does not promise a translated app', () => {
    const pdd = read('skills', 'idea-to-pdd', 'SKILL.md');
    expect(pdd, 'the Working language line stays — it drives training + chatbot').toMatch(
      /\*\*Working language\.\*\*/,
    );
    expect(pdd, 'Phase 1 must be told the app ships English-only').toMatch(
      /English only|English-only/,
    );
    expect(
      pdd,
      'the retired instruction ("build ships that language\'s translations") must be gone',
    ).not.toMatch(/ships that\s+language's translations/);
  });
});
