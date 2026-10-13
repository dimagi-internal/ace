import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * dimagi-internal/ace#2869 — `ocs-agent-setup` § Step 5 indexed
 * `runs/<run-id>/3-commcare/*` verbatim, so the Learn summary's assessment
 * answer keys reached the FLW chatbot's knowledge base. Observed on
 * `smallholder-seasonal/20261012-1549` (Phase 5 stripped the line by hand).
 * Same class as ace#1018 (the deep-QA instrument indexed into the bot it grades).
 *
 * Two halves, both pinned:
 * 1. The recipe names the two app summaries EXPLICITLY. `3-commcare/` also
 *    holds the Nova snapshots (every `qN_score` calculate literal), the
 *    Maestro test cases and journey recipes (which answer the quiz), and the
 *    eval verdicts — a glob indexes all of them.
 * 2. Every downloaded file goes through `scripts/redact-kb-answer-keys.ts`
 *    before upload, on both OCS upload paths.
 */
const ROOT = join(__dirname, '..', '..');
const SCRIPT = 'scripts/redact-kb-answer-keys.ts';
const agentSetup = readFileSync(join(ROOT, 'skills/ocs-agent-setup/SKILL.md'), 'utf8');

function kbRecipeFileList(md: string): string {
  const start = md.indexOf('Files to gather:');
  expect(start).toBeGreaterThan(-1);
  const rest = md.slice(start);
  const end = rest.indexOf('**The generated contacts file');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('ocs-agent-setup KB recipe does not index answer keys (ace#2869)', () => {
  const recipe = kbRecipeFileList(agentSetup);
  // Top-level bullets of the list: the files actually gathered.
  const gathered = recipe.split('\n').filter((l) => /^ {3}- `/.test(l));

  it('ships the redaction script and its pure helper', () => {
    expect(existsSync(join(ROOT, SCRIPT))).toBe(true);
    expect(existsSync(join(ROOT, 'lib/kb-answer-key-redaction.ts'))).toBe(true);
  });

  it('does not glob the whole 3-commcare folder', () => {
    expect(recipe).not.toMatch(/3-commcare\/\*/);
  });

  it('names the two app summaries', () => {
    expect(recipe).toContain('3-commcare/pdd-to-learn-app_summary.md');
    expect(recipe).toContain('3-commcare/pdd-to-deliver-app_summary.md');
  });

  it.each(['_snapshot.json', 'app-test-cases.yaml', 'journey-learn.yaml', '-eval_verdict.yaml'])(
    'does not gather %s',
    (name) => {
      expect(gathered.some((l) => l.includes(name))).toBe(false);
    },
  );

  for (const skill of ['ocs-agent-setup', 'ocs-knowledge-refresh']) {
    it(`${skill} runs the redaction script before upload and cites the issue`, () => {
      const text = readFileSync(join(ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
      expect(text).toContain(SCRIPT);
      expect(text).toMatch(/ace#2869/);
    });
  }
});
