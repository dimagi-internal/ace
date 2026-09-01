/**
 * dimagi-internal/ace#1783 — a `longitudinal-visits` PDD with no
 * `entity_state_taxonomy` row passed `idea-to-pdd-qa` 9/9 and then hit a
 * `[BLOCKER]` in Phase 3, where `pdd-to-learn-app` / `pdd-to-deliver-app`
 * parse that row with `parseStateTaxonomy` and HALT on `declared: false`.
 *
 * ace#1564 added the Phase-3 halt and the typed row; it did not add the
 * matching Phase-1 requirement, so the halt was reachable on a QA-PASSING
 * PDD — at the most expensive point in the run, after two clean phases, for
 * a gap that is a one-line edit at authoring time.
 *
 * Live case: `bednet-check-2-visit/20260828-0629`.
 *
 * The gate is deliberately ARCHETYPE-CONDITIONAL: it fires exactly where the
 * Phase-3 component fires ("always for `archetype: longitudinal-visits`").
 * An `atomic-visit` PDD has no followed entity to have states, so requiring
 * the row there would be a new false gate — which the `does not fire`
 * describe block below pins.
 */
import { describe, it, expect } from 'vitest';
import {
  CHECKS,
  checkEntityStateTaxonomyForLongitudinal,
} from '../../skills/idea-to-pdd-qa/checks';

const pdd = (archetype: string, rows: string) =>
  `# PDD\n\n**Archetype:** ${archetype}\n\n## Entity Lifecycle\n\n` +
  `Households move through three states: registered at the first visit, ` +
  `followed up at the second, and closed once the second visit verifies.\n\n` +
  `## Program Parameters\n\n| Key | Value |\n|---|---|\n${rows}\n\n## Timeline\n`;

const TAXONOMY =
  '| entity_state_taxonomy | 1=Registered (steps 1-2); 2=Followed up (steps 3-4); 3=Closed (steps 5) |';

// The row set the live run actually shipped — everything but the taxonomy.
const LIVE_ROWS =
  '| learn_passing_score | 80 |\n' +
  '| entity_id_grain | worker username + household id |\n' +
  '| daily_cap_per_flw | 12 |';

describe('the PDD that shipped (bednet-check-2-visit/20260828-0629)', () => {
  const r = checkEntityStateTaxonomyForLongitudinal(pdd('longitudinal-visits', LIVE_ROWS));

  it('fails in Phase 1 rather than reaching the Phase 3 halt', () => {
    expect(r.pass).toBe(false);
  });

  it('names the archetype as the reason the row is required', () => {
    expect(r.detail).toMatch(/longitudinal-visits/);
  });

  it('says Phase 3 halts on exactly this, so the cost of ignoring it is legible', () => {
    expect(r.detail).toMatch(/HALT/);
    expect(r.detail).toMatch(/declared: false/);
  });

  it('remediation names the row, the grammar, and that prose is not a handoff', () => {
    expect(r.auto_fix_hint).toContain('entity_state_taxonomy');
    expect(r.auto_fix_hint).toMatch(/<value>=<label>/);
    expect(r.auto_fix_hint).toMatch(/Prose is not a handoff/i);
    expect(r.auto_fix_hint).toMatch(/Entity Lifecycle/);
  });
});

describe('does not fire where there is no followed entity', () => {
  it.each(['atomic-visit', 'focus-group', 'multi-stage'])(
    '%s with no taxonomy row still passes',
    (archetype) => {
      const r = checkEntityStateTaxonomyForLongitudinal(pdd(archetype, LIVE_ROWS));
      expect(r.pass).toBe(true);
      expect(r.detail).toMatch(/not applicable/);
    },
  );

  it('an undeclared archetype is archetype_declared_and_valid’s failure, not this one', () => {
    const r = checkEntityStateTaxonomyForLongitudinal(
      `# PDD\n\n## Program Parameters\n\n| Key | Value |\n|---|---|\n${LIVE_ROWS}\n`,
    );
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/not applicable/);
  });

  it('defers to program_parameters_coherent when the section is missing entirely', () => {
    const r = checkEntityStateTaxonomyForLongitudinal(
      '# PDD\n\n**Archetype:** longitudinal-visits\n\n## Timeline\n',
    );
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/program_parameters_coherent/);
  });
});

describe('passes on a well-formed declaration', () => {
  it('accepts the taxonomy the live PDD described only in prose', () => {
    const r = checkEntityStateTaxonomyForLongitudinal(
      pdd('longitudinal-visits', `${LIVE_ROWS}\n${TAXONOMY}`),
    );
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/3 state/);
  });

  it('accepts a taxonomy with no step partition — a legitimate shape', () => {
    const r = checkEntityStateTaxonomyForLongitudinal(
      pdd('longitudinal-visits', '| entity_state_taxonomy | 1=Registered; 2=Closed |'),
    );
    expect(r.pass).toBe(true);
  });
});

describe('shares Phase 3’s parser, so the two cannot disagree again', () => {
  // Each of these makes parseStateTaxonomy return declared:false or a
  // non-empty problems list — the two conditions pdd-to-learn-app HALTs on.
  it.each([
    ['an unfilled template placeholder', '| entity_state_taxonomy | [value=label; ...] |'],
    ['an explicit n/a', '| entity_state_taxonomy | n/a |'],
    ['prose instead of the grammar', '| entity_state_taxonomy | see Entity Lifecycle |'],
    ['a duplicate state value', '| entity_state_taxonomy | 1=Registered; 1=Closed |'],
    ['a step owned by two states', '| entity_state_taxonomy | 1=A (steps 1-3); 2=B (steps 3-4) |'],
    ['an inverted step range', '| entity_state_taxonomy | 1=A (steps 4-2); 2=B (steps 5) |'],
  ])('%s fails', (_label, row) => {
    const r = checkEntityStateTaxonomyForLongitudinal(pdd('longitudinal-visits', row));
    expect(r.pass).toBe(false);
  });
});

describe('registration', () => {
  it('is in CHECKS so the runtime QA pass actually runs it', () => {
    expect(CHECKS.map((c) => c.id)).toContain('entity_state_taxonomy_declared_for_longitudinal');
  });

  it('is surfaced in the SKILL.md checks table', async () => {
    const { readFileSync } = await import('node:fs');
    const skill = readFileSync(
      new URL('../../skills/idea-to-pdd-qa/SKILL.md', import.meta.url),
      'utf8',
    );
    expect(skill).toContain('entity_state_taxonomy_declared_for_longitudinal');
  });
});
