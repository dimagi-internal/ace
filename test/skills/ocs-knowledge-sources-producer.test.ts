import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const SKILL = join(ROOT, 'skills', 'ocs-knowledge-refresh', 'SKILL.md');

/**
 * `knowledge_sources` is read by ace-web's public run-summary page
 * (`apps/opps/summary.py :: _knowledge_sources`) to render "It was given <list>."
 *
 * ace-web#740 turned that sentence from a HARD-CODED claim into data,
 * specifically because `ocs-knowledge-refresh` (ace#1715) makes it true for
 * some runs and leaves it false for others. But the consumer shipped with NO
 * producer: on spark-facilitator/20260820-0817 the field was absent from
 * run_state, so the page fell back to saying nothing about what the bot knows
 * even after the training pack was indexed (ace#1755).
 *
 * A missing producer is SILENT on both sides — ace-web renders the fallback,
 * ACE writes nothing, and every check stays green. This test is the tripwire.
 */
describe('ocs-knowledge-refresh produces knowledge_sources', () => {
  const skill = readFileSync(SKILL, 'utf8');

  it('instructs the skill to write knowledge_sources into run_state', () => {
    expect(skill).toMatch(/knowledge_sources/);
  });

  it('names the run_state path the consumer actually reads', () => {
    expect(skill).toMatch(
      /phases\.ocs-setup\.products\.ocs_chatbot|['"]ocs-setup['"]:\s*\{\s*products/,
    );
  });

  it('declares knowledge_sources in its Products section, not only in prose', () => {
    const products = skill.slice(
      skill.indexOf('## Products'),
      skill.indexOf('## Process'),
    );
    expect(products).toMatch(/knowledge_sources/);
  });

  it('tells the author to write readable phrases rather than raw filenames', () => {
    // The strings are rendered into an English sentence for an external
    // reader; "19-training-quick-reference.md" in that sentence is the defect.
    expect(skill).toMatch(/Phrases, not filenames/i);
  });
});
