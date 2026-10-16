/**
 * dimagi-internal/ace#2851 — a skill that names the subagent dispatching it
 * must name one that actually does.
 *
 * Both Phase 2 eval skills (`pdd-to-test-prompts-eval`,
 * `pdd-to-app-journeys-eval`) said they were "invoked from the
 * `idea-to-design` subagent" and quoted that parent's step numbers for the
 * inputs already in context. `idea-to-design` never mentions either skill;
 * `scenarios-and-acceptance` (Phase 2) dispatches both, at different step
 * numbers. Seen while running Phase 2 of
 * turmeric-market-study-ghana/20261012-1749. A sibling of the same drift
 * pointed `idea-to-pdd-eval` at `agents/design-review.md`, a file that does
 * not exist.
 *
 * The mapping is already declared — every phase agent's frontmatter lists
 * `skills: [{ name, qa_skill, eval_skill }]` — so the check is a lookup, not a
 * heuristic. It pins three things:
 *   1. the named agent's frontmatter lists this skill;
 *   2. every "parent's Step X" the paragraph cites is a `### Step X:` heading
 *      in that agent;
 *   3. every `agents/<file>.md` the skill cites exists.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../..');
const SKILLS = join(ROOT, 'skills');
const AGENTS = join(ROOT, 'agents');

const DISPATCHER = /invoked from the `([a-z0-9-]+)` subagent/g;
const PARENT_STEPS = /parent's (Step [\d.]+(?: \/ Step [\d.]+)*)/g;

/** Skill names an agent's frontmatter declares (name, qa_skill, eval_skill). */
function declaredSkills(agentMd: string): Set<string> {
  const fm = /^---\n([\s\S]*?)\n---/.exec(agentMd)?.[1] ?? '';
  const out = new Set<string>();
  for (const m of fm.matchAll(/\b(?:name|qa_skill|eval_skill):\s*([a-z0-9-]+)/g)) out.add(m[1]);
  return out;
}

/** Problems with one skill's dispatcher claims; empty when consistent. */
function dispatcherProblems(skill: string, skillMd: string, readAgent: (n: string) => string | null): string[] {
  const problems: string[] = [];
  for (const m of skillMd.matchAll(DISPATCHER)) {
    const agent = m[1];
    const md = readAgent(agent);
    if (md === null) {
      problems.push(`${skill}: names \`${agent}\` as its dispatcher, but agents/${agent}.md does not exist`);
      continue;
    }
    if (!declaredSkills(md).has(skill)) {
      problems.push(`${skill}: names \`${agent}\` as its dispatcher, but that agent's frontmatter does not list it`);
      continue;
    }
    // Step numbers cited in the same paragraph (up to the next blank line).
    const para = skillMd.slice(m.index!).split(/\n\s*\n/)[0];
    for (const s of para.matchAll(PARENT_STEPS)) {
      for (const step of s[1].split(' / ')) {
        const n = step.replace('Step ', '');
        if (!new RegExp(`^### Step ${n.replace(/\./g, '\\.')}:`, 'm').test(md)) {
          problems.push(`${skill}: cites the parent's ${step}, but agents/${agent}.md has no "### ${step}:" heading`);
        }
      }
    }
  }
  for (const m of skillMd.matchAll(/`agents\/([a-z0-9-]+)\.md`/g)) {
    if (readAgent(m[1]) === null) problems.push(`${skill}: cites agents/${m[1]}.md, which does not exist`);
  }
  return problems;
}

const readAgent = (n: string): string | null => {
  const p = join(AGENTS, `${n}.md`);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};

describe('a skill that names its dispatching subagent names the right one (#2851)', () => {
  it('every dispatcher claim in skills/ matches the agent frontmatter and its step headings', () => {
    const problems: string[] = [];
    let claims = 0;
    for (const dir of readdirSync(SKILLS)) {
      const p = join(SKILLS, dir, 'SKILL.md');
      if (!existsSync(p)) continue;
      const md = readFileSync(p, 'utf8');
      claims += [...md.matchAll(DISPATCHER)].length;
      problems.push(...dispatcherProblems(dir, md, readAgent));
    }
    // The scan must actually see the claims it polices.
    expect(claims).toBeGreaterThanOrEqual(3);
    expect(problems).toEqual([]);
  });

  it('NEGATIVE CONTROL: the pre-fix pdd-to-test-prompts-eval paragraph is caught', () => {
    const before =
      '1. **Use inputs already in context (preferred) or read from Drive.**\n' +
      '   When invoked from the `idea-to-design` subagent (the common\n' +
      "   `/ace:run` path), the test-prompts artifact and PDD are already\n" +
      "   loaded by the parent's Step 2 / Step 1 — do NOT re-issue\n";
    expect(dispatcherProblems('pdd-to-test-prompts-eval', before, readAgent)).toEqual([
      "pdd-to-test-prompts-eval: names `idea-to-design` as its dispatcher, but that agent's frontmatter does not list it",
    ]);
  });

  it('NEGATIVE CONTROL: the right agent with a wrong step number is caught', () => {
    const wrongStep =
      '   When invoked from the `scenarios-and-acceptance` subagent (the common\n' +
      "   `/ace:run` path), the journeys artifact and PDD are already loaded\n" +
      "   by the parent's Step 3 / Step 0.5 — do NOT re-issue\n";
    expect(dispatcherProblems('pdd-to-app-journeys-eval', wrongStep, readAgent)).toEqual([
      "pdd-to-app-journeys-eval: cites the parent's Step 3, but agents/scenarios-and-acceptance.md has no \"### Step 3:\" heading",
    ]);
  });

  it('NEGATIVE CONTROL: a cited agents/ file that does not exist is caught', () => {
    expect(dispatcherProblems('idea-to-pdd-eval', 'See `agents/design-review.md` § Performance conventions', readAgent)).toEqual([
      'idea-to-pdd-eval: cites agents/design-review.md, which does not exist',
    ]);
  });
});
