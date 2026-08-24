/**
 * ace#1564 — the entity-state fix must stay DERIVE-OR-HALT, never a shipped
 * vocabulary.
 *
 * The reported defect was an architect inventing a partner's own process
 * vocabulary because the Deliver brief carried none. There are two ways to
 * close that, and only one of them is right:
 *
 *   (a) hard-code a canonical state taxonomy into the brief. Tempting, and the
 *       mirror image of the defect — it imposes ACE's words on every partner,
 *       systematically rather than per run.
 *   (b) require the taxonomy to be DERIVED from the PDD (or the source document
 *       the PDD names, read out of the run's frozen `inputs/`) and HALT when it
 *       is absent, so upstream thinness surfaces as a finding a human can fill
 *       rather than as a plausible fabrication.
 *
 * ACE chose (b). This file is the ratchet that keeps it (b): a later edit that
 * quietly adds a default state set to the brief paragraph, or drops the halt,
 * fails CI. Prose saying "don't invent" is not self-enforcing — that is the
 * whole lesson of `no-inferred-backstory`.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const LIBRARY = read('skills/_app-component-library.md');
const DELIVER = read('skills/pdd-to-deliver-app/SKILL.md');
const LEARN = read('skills/pdd-to-learn-app/SKILL.md');
const EVAL = read('skills/pdd-to-deliver-app-eval/SKILL.md');
const PDD_TEMPLATE = read('templates/pdd-template.md');
const HELPER = read('lib/entity-state-taxonomy.ts');

/** The `### entity-state-taxonomy` section, up to the next heading. */
function componentSection(): string {
  const start = LIBRARY.indexOf('### entity-state-taxonomy');
  expect(start, 'skills/_app-component-library.md has no ### entity-state-taxonomy section').
    toBeGreaterThan(-1);
  const rest = LIBRARY.slice(start + 3);
  const next = rest.search(/^#{2,3} /m);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Only the blockquote the architect actually receives. */
function briefParagraph(): string {
  const section = componentSection();
  const marker = section.indexOf('**Brief paragraph (verbatim):**');
  expect(marker, 'entity-state-taxonomy has no verbatim brief paragraph').toBeGreaterThan(-1);
  const after = section.slice(marker);
  // Unwrap: the blockquote is hard-wrapped, so a phrase can straddle a `> `
  // prefix and a naive match on the raw text silently misses it.
  return after
    .split('\n')
    .filter((l) => l.trimStart().startsWith('>'))
    .map((l) => l.trimStart().replace(/^>\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('entity-state-taxonomy component (ace#1564)', () => {
  it('is registered in the component index with its build + eval enforcement', () => {
    const row = LIBRARY.split('\n').find(
      (l) => l.startsWith('| [`entity-state-taxonomy`]') && l.includes('|'),
    );
    expect(row, 'entity-state-taxonomy is missing from the component index table').toBeTruthy();
    // Every component pairs 1:1 with the gate that hard-fails a build omitting
    // it — that symmetry is what makes the library safe.
    expect(row).toContain('entity_state_fidelity');
    expect(row).toMatch(/longitudinal-visits/);
  });

  it('tells the architect to use the partner vocabulary verbatim and to STOP rather than invent', () => {
    const brief = briefParagraph();
    expect(brief).toMatch(/\bSTOP\b/);
    expect(brief).toMatch(/EXACTLY as given|verbatim/i);
    // The specific edits the spark-facilitator build made, each named.
    expect(brief).toMatch(/no renaming/i);
    expect(brief).toMatch(/merging or splitting/i);
    expect(brief).toMatch(/worse than a gap/i);
  });

  // The ratchet. A default vocabulary in the brief is option (a) creeping back
  // in, and it would be worse than the defect it replaced.
  it('ships NO canonical state vocabulary in the brief paragraph', () => {
    const brief = briefParagraph().toLowerCase();
    const generic = [
      'enrolled',
      'lapsed',
      'graduated',
      'dormant',
      'onboarding',
      'in progress',
      'not started',
      'active',
      'inactive',
      'completed',
    ];
    const hits = generic.filter((w) => new RegExp(`\\b${w}\\b`).test(brief));
    expect(
      hits,
      `The brief paragraph names generic lifecycle states (${hits.join(', ')}). ` +
        'A supplied vocabulary is the mirror image of ace#1564 and systematic: ' +
        'the taxonomy must be DERIVED from the PDD, never offered as a default.',
    ).toEqual([]);
  });

  it('routes an absent declaration to a HALT, not to a default', () => {
    const section = componentSection();
    expect(section).toMatch(/declared: false/);
    expect(section).toMatch(/HALT/);
    expect(
      section,
      'The component must say explicitly that a missing taxonomy is a Phase-1 gap ' +
        'to surface, not a gap to fill.',
    ).toMatch(/never substitute|do not substitute/i);
    // Where the PDD names the authoritative document, read THAT document out of
    // the run's own frozen inputs — the canonical register was one file away.
    expect(section).toMatch(/inputs-manifest\.yaml/);
  });
});

describe('the derive-or-halt contract is wired into the build surface', () => {
  it('pdd-to-deliver-app emits the component and halts before briefing', () => {
    expect(DELIVER).toContain('entity-state-taxonomy');
    expect(DELIVER).toContain('parseStateTaxonomy');
    expect(DELIVER).toContain('program_parameters.entity_state_taxonomy');
  });

  it('pdd-to-deliver-app has a Step-4 block diffing the built option set', () => {
    const start = DELIVER.search(/^4l\.\s+\*\*/m);
    expect(start, 'no Step 4l block — the taxonomy rule would be architect prose only').
      toBeGreaterThan(-1);
    const rest = DELIVER.slice(start + 1);
    const next = rest.search(/^(?:4[a-z]|\d+)\.\s+\*\*/m);
    const body = next < 0 ? rest : rest.slice(0, next);

    // The helper must be IMPORTED, not a restated rule — a prose mention in the
    // component library is exactly the prose this check backstops.
    expect(body).toContain('lib/entity-state-taxonomy');
    expect(body).toContain('diffStateTaxonomy');
    for (const finding of ['extraInBuild', 'missingInBuild', 'relabelled', 'repartitioned']) {
      expect(body, `Step 4l never handles \`${finding}\``).toContain(finding);
    }
    // And it must HALT. A warn on an invented vocabulary is worthless: the app
    // is internally consistent with its own invention, so nothing later has a
    // symptom to act on.
    expect(body).toContain('HALT');
    expect(body, 'Step 4l must say explicitly that a finding is a HALT and not a warn.').toMatch(
      /not a warn/i,
    );
  });

  it('pdd-to-learn-app teaches the same declared taxonomy', () => {
    // Learn/Deliver agreement is transitive only if BOTH derive from the one
    // declaration. A Learn app briefed from anything else recreates the defect.
    expect(LEARN).toContain('entity-state-taxonomy');
    expect(LEARN).toContain('program_parameters.entity_state_taxonomy');
  });

  it('the PDD template carries the typed handoff', () => {
    const row = PDD_TEMPLATE.split('\n').find((l) => l.startsWith('| entity_state_taxonomy |'));
    expect(
      row,
      'templates/pdd-template.md § Program Parameters has no entity_state_taxonomy row. ' +
        'Prose in § Entity Lifecycle is not a handoff — that is where ace#1564 got lost.',
    ).toBeTruthy();
    expect(row).toMatch(/source:/);
  });

  it('the eval carries the paired hard gate', () => {
    expect(EVAL).toContain('entity_state_fidelity');
    expect(EVAL).toContain('parseStateTaxonomy');
    expect(EVAL).toContain('diffStateTaxonomy');
  });

  it('the helper itself ships no vocabulary', () => {
    // No canonical/default state table anywhere in the module.
    expect(HELPER).not.toMatch(/DEFAULT_STATES|CANONICAL_STATES|FALLBACK_STATES/);
    expect(HELPER).toMatch(/ships \*\*no canonical vocabulary\*\*|no canonical vocabulary/i);
  });
});
