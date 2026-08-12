/**
 * Skill dispatchability guard.
 *
 * `disable-model-invocation: true` makes a skill UNDISPATCHABLE — the harness
 * refuses `Skill(<name>)` outright:
 *
 *   Skill ace:<name> cannot be used with Skill tool due to disable-model-invocation.
 *   Do not replicate this skill's workflow by other means — it is reserved for
 *   explicit user invocation.
 *
 * `skills/README.md` used to assert the opposite — that the flag removed a skill
 * from the routing catalog "without affecting `Skill(name)` invocation by name".
 * Acting on that guidance flagged 80 of the skills that `agents/*.md` dispatch,
 * which broke `/ace:run`: a phase agent hitting a flagged producer either halts,
 * or replicates the skill inline against the harness's explicit instruction.
 *
 * The replication path is the expensive one, because it fails QUIETLY. Running a
 * producer and its `-eval` judge in one context collapses the two-phase QA/eval
 * pattern into a self-grade, and self-grades run optimistic — so the run still
 * reports healthy verdicts while the independent judging that makes those verdicts
 * mean anything never happened.
 *
 * Caught on hh-poverty-targeting/20260812-1613 Phase 2 (dimagi-internal/ace#1203),
 * where both Phase 2 evals came back self-graded.
 *
 * The invariant: if an agent doc names a skill, that skill must be dispatchable.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Skill dir names under skills/ that have a SKILL.md. */
function listSkills(): string[] {
  const skillsDir = path.join(REPO_ROOT, 'skills');
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

/** True iff SKILL.md's frontmatter sets disable-model-invocation: true. */
function isFlagged(skill: string): boolean {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'skills', skill, 'SKILL.md'), 'utf-8');
  // Frontmatter only — the first --- ... --- block.
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  if (!fm) return false;
  return /^disable-model-invocation:\s*true\s*$/m.test(fm[1]);
}

/** Concatenated text of every agent procedure doc / subagent definition. */
function agentDocs(): { file: string; text: string }[] {
  const agentsDir = path.join(REPO_ROOT, 'agents');
  if (!fs.existsSync(agentsDir)) return [];
  return fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({
      file: `agents/${f}`,
      text: fs.readFileSync(path.join(agentsDir, f), 'utf-8'),
    }));
}

/**
 * Does an agent doc reference this skill by name?
 *
 * Word-boundary match on the kebab-case skill name. Deliberately generous: a
 * false positive just means we keep a skill dispatchable, which costs a routing-
 * catalog slot. A false negative means /ace:run breaks in production.
 */
function referencedBy(skill: string, docs: { file: string; text: string }[]): string[] {
  const re = new RegExp(`(^|[^a-z0-9-])${skill}([^a-z0-9-]|$)`, 'm');
  return docs.filter((d) => re.test(d.text)).map((d) => d.file);
}

describe('skill dispatchability', () => {
  it('every skill referenced by an agent doc is dispatchable via Skill()', () => {
    const docs = agentDocs();
    expect(docs.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const skill of listSkills()) {
      if (!isFlagged(skill)) continue;
      const refs = referencedBy(skill, docs);
      if (refs.length > 0) {
        offenders.push(`  ${skill} — disable-model-invocation: true, but dispatched by ${refs.join(', ')}`);
      }
    }

    expect(
      offenders,
      [
        '',
        'These skills carry `disable-model-invocation: true` but are dispatched by an agent doc.',
        'The harness REFUSES Skill() on them, so the dispatching phase will halt — or, worse,',
        'replicate the skill inline, which collapses producer + judge into one context and turns',
        'the resulting -eval verdict into a self-grade.',
        '',
        ...offenders,
        '',
        'Fix: set `disable-model-invocation: false` in each SKILL.md frontmatter.',
        'See skills/README.md § disable-model-invocation and dimagi-internal/ace#1203.',
        '',
      ].join('\n'),
    ).toEqual([]);
  });

  it('README documents the flag as undispatchable, not catalog-only', () => {
    const readme = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'README.md'), 'utf-8');
    // Guard against the specific false claim regressing back in.
    expect(
      /without\s+affecting\s+`?Skill\(name\)`?\s+invocation/i.test(readme),
      'skills/README.md again claims disable-model-invocation does not affect Skill(name) ' +
        'invocation. It does — the harness refuses the call outright (ace#1203).',
    ).toBe(false);
  });
});
