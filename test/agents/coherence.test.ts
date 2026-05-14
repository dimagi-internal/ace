/**
 * Agent-coherence tests — the deterministic substrate under agent routing.
 *
 * Agents in ACE are markdown procedural documents executed by Claude Code.
 * Their LLM-driven routing decisions are not unit-testable, but the
 * **scaffold** those decisions consult is. Each phase agent's frontmatter
 * declares:
 *
 *   - `phase` (slug) and `phase_ordinal` (1..N) — its slot in `/ace:run`
 *   - `skills: [{ name, has_judge, qa_skill?, eval_skill? }]` — which
 *     skills the agent dispatches
 *
 * And `lib/artifact-manifest.ts` declares `producedBy: <skill>` and
 * `phase: <phase>` for every artifact in the run.
 *
 * This test asserts cross-source coherence. It catches:
 *   - Phase ordinal collisions or gaps (would make `/ace:run` sequencing
 *     ambiguous)
 *   - Skill names referenced in an agent's `skills:` list that don't have
 *     a `skills/<name>/SKILL.md` (orchestrator would route to nothing)
 *   - `qa_skill` / `eval_skill` references that point to skills which
 *     have been renamed or removed
 *   - Producers in the manifest that no phase agent claims (would never
 *     run during `/ace:run`)
 *   - `phase:` values in the manifest that don't match any agent's
 *     frontmatter (orphaned artifact, no phase home)
 *
 * Companion to `test/lib/artifact-manifest-lint.test.ts` (manifest-side)
 * and `test/lib/registries-coverage.test.ts` (QA/eval registry side).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

import { ARTIFACT_MANIFEST } from '../../lib/artifact-manifest.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');
const SKILLS_DIR = path.join(REPO_ROOT, 'skills');

interface SkillEntry {
  name: string;
  has_judge?: boolean;
  qa_skill?: string;
  eval_skill?: string;
}

interface AgentFrontmatter {
  file: string;
  name: string;
  phase?: string;
  phase_ordinal?: number;
  skills?: SkillEntry[];
}

function readFrontmatter(agentFile: string): AgentFrontmatter | null {
  const src = fs.readFileSync(path.join(AGENTS_DIR, agentFile), 'utf-8');
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  // No frontmatter = reference doc, not an agent (e.g. orchestrator-reference.md).
  if (!m) return null;
  const parsed = yaml.parse(m[1]) as Record<string, unknown>;
  // skills: can be either `['name-a', 'name-b']` (ocs-tester) or
  // `[{ name, has_judge, qa_skill, eval_skill }]` (phase agents). Normalize.
  const rawSkills = parsed.skills as unknown;
  const skills: SkillEntry[] | undefined = Array.isArray(rawSkills)
    ? rawSkills.map((s) => (typeof s === 'string' ? { name: s } : (s as SkillEntry)))
    : undefined;
  return {
    file: agentFile,
    name: parsed.name as string,
    phase: parsed.phase as string | undefined,
    phase_ordinal: parsed.phase_ordinal as number | undefined,
    skills,
  };
}

const ALL_AGENTS: AgentFrontmatter[] = fs
  .readdirSync(AGENTS_DIR)
  .filter((f) => f.endsWith('.md'))
  .map(readFrontmatter)
  .filter((a): a is AgentFrontmatter => a !== null);

const PHASE_AGENTS = ALL_AGENTS.filter(
  (a) => typeof a.phase_ordinal === 'number',
);

// Producers in artifact-manifest that legitimately don't appear in any
// phase agent's `skills:` list:
//   - 'external': placeholder for external-system writes (inputs).
//   - 'ace-orchestrator': top-level orchestrator output (e.g. inputs-manifest).
//   - Phase agent names themselves: agents emit phase-summary artifacts
//     under their own name (e.g. 'commcare-setup' produces a phase summary).
//   - '-qa' and '-eval' suffixed skills: companion skills dispatched by
//     producers, not first-class producers in their own right. They're
//     tracked in skills/_qa-decisions.md and skills/_eval-decisions.md.
const AGENT_NAMES = new Set(ALL_AGENTS.map((a) => a.name));
function isExemptProducer(name: string): boolean {
  if (name === 'external' || name === 'ace-orchestrator') return true;
  if (AGENT_NAMES.has(name)) return true;
  if (name.endsWith('-qa') || name.endsWith('-eval')) return true;
  return false;
}

// Characterization baseline — producers in the manifest that currently
// have no phase-agent owner. Each entry is a real skill that runs during
// `/ace:run` but is invoked outside any phase agent's `skills:` list.
// They're either cross-phase utilities or skills whose owning agent
// hasn't been updated to claim them.
//
// This test asserts the set stays EXACTLY this — locking current state as
// a baseline. When you add a new producer, either:
//   - Add it to the right agent's `skills:` list (the test will pass), OR
//   - Add it here with a comment explaining why it's cross-phase
//
// When you fix one of the entries below by claiming it on an agent,
// remove it from this list (the test will tell you it's no longer
// unclaimed). That celebrates progress on closing this drift.
const UNCLAIMED_BASELINE = new Set<string>([
  // 2026-05-14: producers below are real skills with no owning agent.
  // Tracked in https://github.com/jjackson/ace (follow-up to PR #289).
  'decisions-render',     // utility; renders decisions.yaml as gdoc cross-phase
  'eval-calibration',     // phase-1 calibration; arguably idea-to-design owns this
  'flw-data-review',      // phase-9 execution-management?
  'solicitation-monitor', // phase-8 monitoring during solicitation
  'solicitation-review',  // phase-8 HITL review
  'timeline-monitor',     // cross-phase monitoring utility
]);

function skillExists(name: string): boolean {
  return fs.existsSync(path.join(SKILLS_DIR, name, 'SKILL.md'));
}

describe('agent coherence', () => {
  it('has at least one phase agent', () => {
    expect(PHASE_AGENTS.length).toBeGreaterThan(0);
  });

  it('phase_ordinal values are unique', () => {
    const ordinals = PHASE_AGENTS.map((a) => a.phase_ordinal!);
    const dupes = ordinals.filter((o, i) => ordinals.indexOf(o) !== i);
    expect(dupes, 'duplicate phase_ordinal values across phase agents').toEqual([]);
  });

  it('phase_ordinal values are contiguous from 1 with no gaps', () => {
    const sorted = [...PHASE_AGENTS.map((a) => a.phase_ordinal!)].sort((a, b) => a - b);
    const expected = Array.from({ length: sorted.length }, (_, i) => i + 1);
    expect(sorted, 'phase ordinals are not 1..N contiguous').toEqual(expected);
  });

  it('phase slugs are unique', () => {
    const slugs = PHASE_AGENTS.map((a) => a.phase!);
    const dupes = slugs.filter((s, i) => slugs.indexOf(s) !== i);
    expect(dupes, 'duplicate phase slugs').toEqual([]);
  });

  it('every skill in every agent skills: list has a SKILL.md', () => {
    const missing: string[] = [];
    for (const agent of ALL_AGENTS) {
      for (const skill of agent.skills ?? []) {
        if (!skillExists(skill.name)) {
          missing.push(`${agent.file}: skills[].name='${skill.name}' has no skills/${skill.name}/SKILL.md`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('every qa_skill / eval_skill reference points to a real skill', () => {
    const missing: string[] = [];
    for (const agent of ALL_AGENTS) {
      for (const skill of agent.skills ?? []) {
        if (skill.qa_skill && !skillExists(skill.qa_skill)) {
          missing.push(`${agent.file}: '${skill.name}' references qa_skill='${skill.qa_skill}' which does not exist`);
        }
        if (skill.eval_skill && !skillExists(skill.eval_skill)) {
          missing.push(`${agent.file}: '${skill.name}' references eval_skill='${skill.eval_skill}' which does not exist`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('non-exempt producers are either claimed by an agent or in the UNCLAIMED_BASELINE', () => {
    const claimedBy = new Map<string, string[]>();
    for (const agent of ALL_AGENTS) {
      for (const skill of agent.skills ?? []) {
        const cur = claimedBy.get(skill.name) ?? [];
        cur.push(agent.file);
        claimedBy.set(skill.name, cur);
      }
    }
    const unclaimed = new Set<string>();
    const overclaimed: string[] = [];
    const producers = new Set(ARTIFACT_MANIFEST.map((a) => a.producedBy));
    for (const p of producers) {
      if (isExemptProducer(p)) continue;
      const claimers = claimedBy.get(p) ?? [];
      if (claimers.length === 0) {
        unclaimed.add(p);
      } else if (claimers.length > 1) {
        overclaimed.push(`'${p}' claimed by: ${claimers.join(', ')}`);
      }
    }
    expect(overclaimed,
      'producers claimed by multiple phase agents (must be exactly one)').toEqual([]);
    // Characterization: unclaimed set must equal the baseline exactly.
    // - New unclaimed producer? Add it to an agent's skills: list (preferred)
    //   or to UNCLAIMED_BASELINE with a comment explaining why.
    // - Resolved an unclaimed producer? Remove it from UNCLAIMED_BASELINE
    //   below to celebrate the progress.
    expect([...unclaimed].sort(),
      'unclaimed producers drifted from baseline; update UNCLAIMED_BASELINE')
      .toEqual([...UNCLAIMED_BASELINE].sort());
  });
});
