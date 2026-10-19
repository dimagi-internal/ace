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

  /**
   * The budget half — two classes, two rules.
   *
   * Every dispatchable skill's `description:` sits in the skill listing of every
   * session in every repo with ACE installed. Claude Code caps that listing itself:
   * 1% of the model's context window, shared by ALL installed plugins; on overflow
   * it keeps every skill NAME and drops descriptions starting with the least-invoked
   * skills (https://code.claude.com/docs/en/skills § "Skill descriptions are cut
   * short", checked 2026-10-18). So a description is worth its chars only when the
   * skill must be FOUND from what a person asks for.
   *
   * - **Internal steps** (description starts with `Internal`) are dispatched by exact
   *   name from an agent doc, command or turn; a description buys them nothing. Each
   *   is held to a one-line per-entry cap and none count against the shared budget.
   * - **Discoverable skills** (everything else dispatchable) must be routed to by
   *   intent ("change the live app", "extend the solicitation"). They share
   *   DISCOVERABLE_BUDGET_CHARS, which protects ACE's share of the harness listing
   *   for exactly the skills that need it.
   *
   * Hiding a skill with `disable-model-invocation: true` is NOT a third option for
   * anything ACE dispatches — it blocks Skill() by name (ace#1203, test above).
   *
   * Chars are measured on the whitespace-normalized description (what the listing
   * shows) plus the skill name.
   */
  // Measured 2026-10-18 (this PR): before the split one 21,650 budget covered both
  // classes (main measured 21,358 across 165 skills: 15 internal = 1,873, 150 other =
  // 19,485). After converting 50 `Pipeline-only:` skills to internal lines and
  // restoring the discoverable descriptions trimmed to fit: 65 internal = 6,265
  // (longest 135, synthetic-walkthrough-spec), 100 discoverable = 15,944.
  // Cap = longest + headroom; budget = measured + ~10%. Raise either only with a
  // measured reason, and say what you measured.
  const INTERNAL_ENTRY_CAP_CHARS = 140;
  const DISCOVERABLE_BUDGET_CHARS = 17_550;

  /**
   * `Pipeline-only:` skills (skills/README.md § Mechanics vs pipeline) that keep a
   * discoverable description anyway, each with the reason. Keep this list small.
   */
  const PIPELINE_ONLY_DISCOVERABLE: Record<string, string> = {
    'fork-run':
      'operator tool: skills/common-screenshot-capture tells a person to run /ace:fork-run, and people ask to fork a run',
    'share-run-access':
      'backs the human /ace:share-run-access command; reached from "let the thread review this run" requests',
  };

  type Entry = { skill: string; chars: number; internal: boolean; pipelineOnly: boolean };

  function catalog(): Entry[] {
    const entries: Entry[] = [];
    for (const skill of listSkills()) {
      if (isFlagged(skill)) continue; // flagged skills cost nothing — not in the index
      const src = fs.readFileSync(path.join(REPO_ROOT, 'skills', skill, 'SKILL.md'), 'utf-8');
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
      if (!fm) continue;
      const d = /^description:\s*(?:>[-]?\s*\r?\n((?:[ \t]+.*\r?\n?)+)|(.*))/m.exec(fm[1]);
      const desc = ((d?.[1] ?? d?.[2] ?? '') as string).replace(/\s+/g, ' ').trim();
      entries.push({
        skill,
        chars: desc.length + skill.length,
        internal: desc.startsWith('Internal'),
        pipelineOnly: src.includes('Pipeline-only:'),
      });
    }
    return entries;
  }

  it('each internal-step entry stays a one-liner', () => {
    const over = catalog().filter((e) => e.internal && e.chars > INTERNAL_ENTRY_CAP_CHARS);
    expect(
      over.map((e) => `  ${e.chars.toString().padStart(4)}  ${e.skill}`),
      [
        '',
        `These internal-step entries (name + description) exceed ${INTERNAL_ENTRY_CAP_CHARS} chars.`,
        'An internal step is dispatched by exact name, so its description only has to say what',
        'it does in one short clause: `Internal /ace:run step — <what it does>`.',
        '',
      ].join('\n'),
    ).toEqual([]);
  });

  it('the discoverable catalog stays inside its char budget', () => {
    const disc = catalog().filter((e) => !e.internal);
    const total = disc.reduce((a, e) => a + e.chars, 0);
    const worst = [...disc].sort((a, b) => b.chars - a.chars).slice(0, 8);
    expect(
      total,
      [
        '',
        `Discoverable skill catalog is ${total.toLocaleString()} chars across ${disc.length} skills,`,
        `over the ${DISCOVERABLE_BUDGET_CHARS.toLocaleString()}-char budget.`,
        '',
        'FIRST: is any of these a pipeline step only ever reached by name from an agent doc,',
        'command or turn? Convert it to an internal line (`Internal /ace:run step — …`,',
        '`user-invocable: false`) — that frees its whole description. Only then trim a',
        'discoverable description, and keep the words a person would actually use. Longest now:',
        ...worst.map((w) => `  ${w.chars.toString().padStart(4)}  ${w.skill}`),
        '',
        'See skills/README.md § description.',
        '',
      ].join('\n'),
    ).toBeLessThanOrEqual(DISCOVERABLE_BUDGET_CHARS);
  });

  it('a Pipeline-only skill uses the internal-step description form', () => {
    const offenders = catalog().filter(
      (e) => e.pipelineOnly && !e.internal && !(e.skill in PIPELINE_ONLY_DISCOVERABLE),
    );
    expect(
      offenders.map((e) => `  ${e.skill}`),
      [
        '',
        'These skills declare `Pipeline-only:` in `## Inputs` but spend discoverable budget on a',
        'full description. A pipeline-only skill is reached by name, so give it',
        '`description: Internal /ace:run step — <what it does>` and `user-invocable: false`.',
        'If it genuinely must be found by intent, add it to PIPELINE_ONLY_DISCOVERABLE with the reason.',
        '',
      ].join('\n'),
    ).toEqual([]);
  });

  it('the Pipeline-only allowlist names only real, still-discoverable Pipeline-only skills', () => {
    const byName = new Map(catalog().map((e) => [e.skill, e]));
    const stale = Object.keys(PIPELINE_ONLY_DISCOVERABLE).filter((s) => {
      const e = byName.get(s);
      return !e || !e.pipelineOnly || e.internal;
    });
    expect(stale, 'Remove these from PIPELINE_ONLY_DISCOVERABLE — the exemption no longer applies.').toEqual([]);
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
