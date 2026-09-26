/**
 * Phase 7 builds the semantic-layer cascade (ace#2510).
 *
 * Observed on spark-facilitator/20260925-1536: Phase 7's procedure had no step
 * that turned the PDD's success metrics into indicator definitions, and it
 * built bespoke dashboards over one synthetic opportunity — so there was no
 * programme → partner → opportunity → worker → case drill to show anyone. The
 * upgrade is wiring across an agent doc and four skills; this rail keeps the
 * wiring from being edited back out one file at a time.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('Phase 7 cascade wiring (ace#2510)', () => {
  const agent = read('agents/synthetic-data-and-workflows.md');
  const setup = read('skills/demo-data-setup/SKILL.md');

  it('the agent runs the registry author before the data, with its QA gate', () => {
    expect(agent).toMatch(/name: semantic-registry-author,[^\n]*qa_skill: semantic-registry-author-qa/);
    expect(agent).toMatch(/C2 — `semantic-registry-author`/);
    expect(agent).toContain('{provider: ace-run');
  });

  it('the ace-run provider instantiates the labs indicator trio, never a forked copy', () => {
    for (const atom of [
      'indicator_programme_report',
      'indicator_opp_report',
      'benchmarks_create_opp_reports',
      'workflow_rebuild_history',
      'verifyCascadeStoryLanded',
    ]) {
      expect(setup, atom).toContain(atom);
    }
  });

  it('partners are llo_map labels over labs-only opportunities, never real Connect orgs', () => {
    expect(setup).toMatch(/never\*\*\s+touched/);
    expect(setup).toContain('synthetic_create_labs_only');
  });

  it('the narrative walks the drill the cascade was built for', () => {
    const narrative = read('skills/demo-narrative/SKILL.md');
    expect(narrative).toMatch(/cascade scene ladder/i);
    expect(narrative).toContain('programme_par_url');
  });
});
