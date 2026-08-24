import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Class-level preventer for the 2026-08-17 multilingual decision (ace#1391
// forward), replacing test/skills/english-only-ui.test.ts.
//
// This dimension has now flipped TWICE in four days, and that is the whole
// hazard:
//   2026-07-30  inline stacking sanctioned      (ace#968)
//   2026-08-14  English-only, stacking retired  (ace#1391)
//   2026-08-17  real per-language channel       (PR #1463, superseding ace#968/#1391)
//
// Two distinct failure modes follow, and this file pins both:
//
//   1. REGRESSION TO A FAKE. Inline stacking is the one thing that was never
//      right and must never return. It survived a whole rubric cycle as the
//      sanctioned mechanism, so it is the cheap direction to drift back into.
//
//   2. SILENT MIS-GRADING. Because `language_conformance` inverted rather than
//      disappeared — twice — a stale rubric line does not fail loudly. It
//      grades every correct build as broken. The 2026-08-14 sweep left exactly
//      such a line in the Deliver rubric's weight comment ("HARD-FAIL on
//      English-only ... inline coverage = the sanctioned mechanism"), and the
//      previous preventer's regexes missed it on word order. The checks below
//      are order-independent for that reason.
//
// It also pins the two Nova contract facts ACE cannot re-derive from docs and
// would otherwise guess wrong (both proven live 2026-08-17, scratch app
// b4e2c8fd): translate-LAST, and `needs-review` text being served to workers.
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

/** Strip change-log table rows: history is allowed to name retired mechanisms. */
function withoutChangeLog(source: string): string {
  return source
    .split('\n')
    .filter((l) => !/^\|\s*20\d\d-\d\d-\d\d\s*\|/.test(l))
    .join('\n');
}

function componentBody(): string {
  const lib = read(...LIBRARY);
  const start = lib.indexOf('### app-language-layer');
  expect(start, 'the app-language-layer component must exist').toBeGreaterThan(-1);
  const rest = lib.slice(start + 1);
  const end = rest.search(/\n### |\n## /);
  return rest.slice(0, end === -1 ? undefined : end);
}

describe('app-language-layer (PR #1463, superseding ace#968/#1391, 2026-08-17)', () => {
  it('the component ships under its new name; both retired names are gone', () => {
    const lib = read(...LIBRARY);
    expect(lib).toMatch(/^### app-language-layer$/m);
    for (const retired of ['english-only-ui', 'localization-layer']) {
      expect(
        lib,
        `the \`${retired}\` component heading must not come back`,
      ).not.toMatch(new RegExp(`^### ${retired}$`, 'm'));
    }
  });

  it('the component cites the live re-verification that justifies the flip', () => {
    const body = componentBody();
    // "Nova has a per-language channel" is a claim about another system. Per
    // the repo's close-the-loop rule it carries the date and the surface it
    // was checked against — a bare assertion is what went stale last time.
    expect(body, 'must cite the date it was verified live').toMatch(/2026-08-17/);
    expect(body, 'must cite the surface + scale it was verified against').toMatch(/95 tools/);
  });

  it('the component pins translate-LAST and the out-of-date fallback', () => {
    const body = componentBody();
    // The single most expensive thing to get wrong: adding a language early
    // means every later English edit silently reverts that string.
    expect(body, 'must state the translate-LAST ordering rule').toMatch(/translate\s+LAST/i);
    expect(body, 'must state that a stale unit falls back to English').toMatch(
      /out-of-date/,
    );
    expect(body, 'must require out-of-date === 0 at hand-off').toMatch(
      /`out-of-date`\s*(is|=|must be)\s*\*?\*?0/i,
    );
  });

  it('the component pins English-as-source and needs-review-is-not-a-gate', () => {
    const body = componentBody();
    expect(body, 'English must be named the source language').toMatch(
      /English is (always )?the source language|source language[^.]{0,40}English/i,
    );
    // Nova serves needs-review text live. A skill that believes otherwise
    // will tell an LLO that unreviewed strings are not live yet.
    expect(body, 'must state that needs-review text IS served to workers').toMatch(
      /needs-review[^|]{0,120}(ARE|is) served|served to workers/i,
    );
    expect(body, 'must state that review is not a publish gate').toMatch(
      /not a publish gate/i,
    );
  });

  it('inline stacking stays forbidden everywhere — the invariant across both flips', () => {
    const offenders: string[] = [];
    for (const parts of [...BUILD_SKILLS, ...RUBRICS, LIBRARY]) {
      const body = withoutChangeLog(read(...parts));
      for (const [label, re] of [
        ['inline multilingual authoring', /inline multilingual/i],
        ['"complete translation coverage" requirement', /complete (translation|language) coverage/i],
        // Order-independent, unlike the previous preventer: catch the claim
        // whichever way round it is phrased.
        [
          'inline coverage named as the sanctioned mechanism',
          /inline coverage[^.\n]{0,40}sanctioned/i,
        ],
        ['"English-only is a hard fail"', /English-only\b[^.\n]{0,40}hard[- ]fail/i],
        ['"hard-fail on English-only"', /hard[- ]fail[^.\n]{0,40}English-only/i],
      ] as const) {
        if (re.test(body)) offenders.push(`${parts.join('/')}: still carries ${label}`);
      }
    }
    expect(
      offenders,
      'Inline stacking was a fake when Nova had no channel and is indefensible ' +
        'now that it has one (see _app-component-library.md § app-language-layer).',
    ).toEqual([]);
  });

  it('both build skills emit app-language-layer and neither retired component', () => {
    for (const parts of BUILD_SKILLS) {
      const body = read(...parts);
      expect(body, `${parts[1]} must emit \`app-language-layer\``).toMatch(
        /app-language-layer/,
      );
      for (const retired of ['english-only-ui', 'localization-layer']) {
        expect(
          withoutChangeLog(body),
          `${parts[1]} must not emit the retired component \`${retired}\``,
        ).not.toMatch(new RegExp(`\`${retired}\``));
      }
    }
  });

  // ---------------------------------------------------------------------
  // The ownership split (ace#1556, 2026-08-23).
  //
  // The 2026-08-17 decision said translations are AUTHORED BY ACE. The wiring
  // asked `/nova:autobuild` to author them, and the architect's operating
  // prompt (nova plugin 1.26.0 AND 1.27.0, skills/autobuild/SKILL.md +
  // agents/nova-architect-autonomous.md, read verbatim off disk) says:
  //
  //   "Never treat your own language fluency as a substitute or bulk-translate
  //    self-generated text through `update_translations`. Only save target text
  //    supplied by the user"
  //
  // An /ace:run supplies no human target strings, so the architect declined and
  // the layer was a silent no-op: spark-facilitator/20260820-0817 shipped 207
  // units `origin: copied` / 0 ready in BOTH nya and tum.
  //
  // These three checks pin the split. Regressing any of them re-creates a build
  // that reports a language layer and ships English under the language's name.
  // ---------------------------------------------------------------------

  /** Collapse markdown wrapping (newlines + blockquote markers) to single spaces. */
  const unwrap = (t: string) => t.replace(/\n>?\s*/g, ' ').replace(/\s+/g, ' ');

  it('the component assigns translation authoring to ACE at level 0, not the architect', () => {
    const body = componentBody();
    const flat = unwrap(body);
    expect(body, 'must cite the issue the split was filed under').toMatch(/ace#1556/);
    expect(
      flat,
      'must quote the architect-prompt clause that forbids it authoring translations — ' +
        'a paraphrase is what let the conflict survive three days',
    ).toMatch(/Only save target text supplied by the user/);
    expect(body, 'must name ACE as the author, at level 0').toMatch(
      /ACE at level 0|level 0, never the architect|ACE.{0,40}level.0/i,
    );
    // The recipe has to live somewhere runnable, not as an aspiration.
    expect(body, 'must carry a level-0 recipe naming the two skill homes').toMatch(
      /pdd-to-learn-app § 4e/,
    );
    expect(body, 'must carry a level-0 recipe naming the two skill homes').toMatch(
      /pdd-to-deliver-app § 4l/,
    );
  });

  it('both brief paragraphs forbid the architect calling any language atom', () => {
    const body = componentBody();
    const briefs = body.split('**Brief paragraph (verbatim)').slice(1);
    expect(briefs.length, 'both the Deliver and Learn briefs must exist').toBe(2);
    for (const brief of briefs) {
      expect(
        brief,
        'the brief must tell the architect NOT to call the language atoms — ' +
          'instructing an action its operating prompt forbids is ace#1556',
      ).toMatch(/[Dd]o NOT add any language and do NOT call `add_language`/);
      expect(unwrap(brief), 'the brief must say English only').toMatch(
        /English, and \*?\*?only English/,
      );
    }
  });

  it('both build skills own the language layer at level 0, after the English is final', () => {
    // translate-LAST is now STRUCTURAL: the architect's turn is over before the
    // language exists. The step must therefore exist, run at level 0, and gate.
    const steps = { 'pdd-to-learn-app': '4e', 'pdd-to-deliver-app': '4l' } as const;
    for (const parts of BUILD_SKILLS) {
      const skill = parts[1] as keyof typeof steps;
      const body = read(...parts);
      expect(body, `${skill}: must carry the level-0 language step`).toMatch(
        new RegExp(`^${steps[skill]}\\. \\*\\*Language layer`, 'm'),
      );
      expect(body, `${skill}: the language step must run at LEVEL 0`).toMatch(
        /Language layer — runs at LEVEL 0/,
      );
      expect(body, `${skill}: must cite the issue`).toMatch(/ace#1556/);
      expect(body, `${skill}: must gate on out-of-date`).toMatch(/out-of-date/);
      // The emit-checklist entry must NOT still tell the architect to author.
      expect(
        body,
        `${skill}: the emit-checklist must not tell the architect to author translations`,
      ).not.toMatch(/as the \*\*LAST\*\* build step, add the/);
    }
  });

  it('both rubrics grade language_conformance at 0.08 and dropped the English-only clause', () => {
    for (const parts of RUBRICS) {
      const body = withoutChangeLog(read(...parts));
      expect(body, `${parts[1]}: dimension name`).toMatch(/language_conformance/);
      expect(body, `${parts[1]}: weight line`).toMatch(
        /language_conformance:\s*\{ weight: 0\.08 \}/,
      );
      // This clause was correct for exactly three days. Left in place it tells
      // the judge to ignore the very thing the build now produces.
      expect(
        body,
        `${parts[1]}: the English-only-era clause "Do NOT deduct for the absence ` +
          `of translations" must be gone — translations are now expected`,
      ).not.toMatch(/[Dd]o NOT deduct for the absence of translations/);
    }
  });

  it('the rubrics warn the judge that the dimension flipped again', () => {
    // A judge re-reading this rubric carries BOTH prior rules in its priors.
    //
    // Scoped to NON-change-log content on purpose. The change-log row names the
    // re-inversion too, so reading the whole file lets a STALE CRITERIA LINE
    // hide behind history — which is exactly the silent-mis-grade failure this
    // suite exists to catch. (Caught by negative control: reverting only the
    // criteria wording left the file-wide check green.)
    for (const parts of RUBRICS) {
      const body = withoutChangeLog(read(...parts));
      expect(body, `${parts[1]}: must flag the re-inversion to the judge`).toMatch(
        /RE-INVERTED|re-inverted|flipped TWICE|flipped twice/,
      );
      expect(
        body,
        `${parts[1]}: must tell the judge to read the criteria, not its memory`,
      ).toMatch(/not your memory|not against memory|read the criteria/i);
    }
  });

  it('multilingual UI is no longer listed as unbuildable in either table', () => {
    const lib = read(...LIBRARY);
    const tableA = lib.slice(lib.indexOf('### Table A'), lib.indexOf('### Table B'));
    const tableBSection = lib.slice(lib.indexOf('### Table B'));
    const tableB = tableBSection.slice(0, tableBSection.indexOf('\n**Evidence discipline'));
    for (const [name, table] of [
      ['Table A', tableA],
      ['Table B', tableB],
    ] as const) {
      expect(
        table,
        `${name} must not list multilingual app UI — Nova shipped the channel ` +
          `2026-08-16/17 and ACE builds it. A stale row here tells Phase 1 to ` +
          `refuse a capability that now exists.`,
      ).not.toMatch(/multilingual app UI/i);
    }
  });

  it('Phase 1 may promise a translated app but not a reviewed one', () => {
    const pdd = read('skills', 'idea-to-pdd', 'SKILL.md');
    expect(pdd, 'the Working language line stays').toMatch(/\*\*Working language\.\*\*/);
    expect(
      pdd,
      'Phase 1 must no longer be told the app ships English-only',
    ).not.toMatch(/ACE builds every app\s+UI in English only/);
    // The residual honesty obligation: ACE authors the translations, so the
    // PDD must not present them as native-speaker reviewed at delivery.
    expect(
      pdd,
      'Phase 1 must still forbid asserting reviewed/professional translations',
    ).toMatch(/native-speaker reviewed|professionally or\s+native-speaker/i);
  });
});
