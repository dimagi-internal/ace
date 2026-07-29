/**
 * Seam test for dimagi-internal/ace#1018.
 *
 * `ocs-agent-setup` § Step 5 used to index
 * `2-scenarios/pdd-to-test-prompts.md` into the per-opp bot's own RAG
 * collection, justified as "always-include is the simpler rule". That file is
 * the DEEP-QA INSTRUMENT: each entry is a question plus an
 * `expected_answer_summary` that `ocs-chatbot-eval --deep` reads as ground
 * truth. Indexing it makes the pipeline "plant the answer key in the corpus →
 * ask those questions → grade against the key the bot can retrieve", and the
 * Phase 9 `llo-launch` gate then passes on evidence it should not.
 *
 * The invariant: `ocs-agent-setup`'s documented KB recipe must not name any
 * artifact that an `-eval` skill declares as a ground-truth input. This is a
 * static cross-read of the two SKILL.md `## Inputs` contracts, so the class
 * cannot silently return by someone re-adding the file to the recipe.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SKILLS = fileURLToPath(new URL('../../skills/', import.meta.url));

const agentSetup = readFileSync(`${SKILLS}ocs-agent-setup/SKILL.md`, 'utf8');
const chatbotEval = readFileSync(`${SKILLS}ocs-chatbot-eval/SKILL.md`, 'utf8');

/**
 * Artifact paths named in the ROWS of a skill's `## Inputs` table, as
 * `<dir>/<file>.md`. Rows only — prose under the heading (e.g. the
 * instrument-independence invariant) cross-references other artifacts and is
 * not a declared input.
 */
function inputArtifacts(md: string): string[] {
  const start = md.indexOf('## Inputs');
  if (start === -1) return [];
  const rest = md.slice(start + '## Inputs'.length);
  const end = rest.search(/\n#{2,3} /);
  const section = end === -1 ? rest : rest.slice(0, end);
  const rows = section.split('\n').filter((l) => l.trim().startsWith('|'));
  return [...rows.join('\n').matchAll(/`([\w.-]+\/[\w./<>-]+\.(?:md|yaml))`/g)].map((m) => m[1]);
}

/**
 * The Step-5 KB recipe: the "Files to gather" list `ocs-agent-setup` uploads
 * into the bot's collection. Deliberately narrow — the prohibition prose
 * elsewhere in Step 5 names the excluded file on purpose, and matching the
 * whole step would read that mention as an inclusion.
 */
function kbRecipeFileList(md: string): string {
  const start = md.indexOf('Files to gather:');
  expect(start, 'ocs-agent-setup Step 5 must still carry a "Files to gather:" list').toBeGreaterThan(
    -1,
  );
  const rest = md.slice(start);
  const end = rest.indexOf('For each file, base64-encode');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('ocs-agent-setup KB recipe ↔ eval ground truth (ace#1018)', () => {
  const groundTruth = inputArtifacts(chatbotEval);
  const recipe = kbRecipeFileList(agentSetup);

  it('ocs-chatbot-eval still declares the test-prompts instrument as a ground-truth input', () => {
    // Guards the test itself: if the eval stops reading the instrument, this
    // test would vacuously pass and we should notice.
    expect(groundTruth.some((a) => a.includes('pdd-to-test-prompts'))).toBe(true);
  });

  it.each(
    inputArtifacts(chatbotEval)
      // The transcript under judgment is produced BY the QA pass; it is not a
      // ground-truth answer key and never lands in a collection.
      .filter((a) => !a.includes('ocs-chatbot-qa_transcript'))
      .map((a) => [a] as const),
  )('the KB recipe does not index %s', (artifact) => {
    const basename = artifact.split('/').pop()!;
    expect(
      recipe.includes(basename),
      `ocs-agent-setup's "Files to gather" list names ${basename}, which ` +
        `ocs-chatbot-eval declares as GROUND TRUTH. Indexing an eval's answer ` +
        `key into the bot it grades makes the deep verdict measure retrieval ` +
        `rather than knowledge — and the Phase 9 llo-launch gate depends on ` +
        `that verdict.`,
    ).toBe(false);
  });

  it('ocs-agent-setup states the exclusion explicitly, not just by omission', () => {
    // Omission is fragile — the next author re-adds the file for the same
    // "it is cheap and might help" reason. The prohibition has to be written
    // down with its rationale.
    expect(agentSetup).toMatch(/NEVER INDEX THE DEEP-QA INSTRUMENT/);
    expect(agentSetup).toMatch(/pdd-to-test-prompts\.md/);
  });

  it('ocs-chatbot-eval carries the matching instrument-independence invariant', () => {
    expect(chatbotEval).toMatch(/Instrument-independence invariant/);
    expect(chatbotEval).toMatch(/MUST NOT appear in the graded bot's RAG collection/);
  });
});
