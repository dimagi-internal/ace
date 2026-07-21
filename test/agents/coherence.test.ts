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
  description?: string;
  rawSkillsBlocks?: unknown[];
}

function normalizeSkillsList(raw: unknown): SkillEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => (typeof s === 'string' ? { name: s } : (s as SkillEntry)));
}

// Used by the "uniform skills frontmatter shape" assertion below. Returns
// the count of bare-string entries (vs object entries) in a raw skills
// list. We want zero across the repo — every entry should be an object
// `{ name, has_judge, ... }` so the metadata feeds the producer-claim
// coherence checks above. ace-orchestrator's bare-string-shape allowance
// (PR 0c era) was simplification by undefault; the test pulls every agent
// onto one shape.
function countBareStringEntries(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  return raw.filter((s) => typeof s === 'string').length;
}

function rawSkillsBlocks(parsed: Record<string, unknown>): unknown[] {
  return [parsed.skills, parsed.recurring_skills, parsed.manual_skills].filter(
    (b) => b !== undefined,
  );
}

function readFrontmatter(agentFile: string): AgentFrontmatter | null {
  const src = fs.readFileSync(path.join(AGENTS_DIR, agentFile), 'utf-8');
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  // No frontmatter = reference doc, not an agent (e.g. orchestrator-reference.md).
  if (!m) return null;
  const parsed = yaml.parse(m[1]) as Record<string, unknown>;
  // Three claim-lists in current frontmatter (all optional):
  //   `skills:`           — primary per-phase skills
  //   `recurring_skills:` — skills the agent dispatches on a schedule
  //                         post-launch (execution-manager, solicitation-management)
  //   `manual_skills:`    — HITL-gated skills the agent prepares but
  //                         doesn't auto-dispatch (solicitation-management)
  // All three contribute claims for the coherence checks. Entries can be
  // either bare strings (`ocs-tester`) or full `{name, has_judge, ...}` objects.
  const skills: SkillEntry[] = [
    ...normalizeSkillsList(parsed.skills),
    ...normalizeSkillsList(parsed.recurring_skills),
    ...normalizeSkillsList(parsed.manual_skills),
  ];
  return {
    file: agentFile,
    name: parsed.name as string,
    phase: parsed.phase as string | undefined,
    phase_ordinal: parsed.phase_ordinal as number | undefined,
    skills: skills.length > 0 ? skills : undefined,
    description: parsed.description as string | undefined,
    rawSkillsBlocks: rawSkillsBlocks(parsed),
  };
}

function readAgentBody(agentFile: string): string {
  const src = fs.readFileSync(path.join(AGENTS_DIR, agentFile), 'utf-8');
  const m = src.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return m ? m[1] : src;
}

// Files allowed to mention `*gate-brief*.md`-shaped paths. Reference doc
// documents the 0.13.116 removal in its `## Per-Phase Folder Lifecycle`
// and `## Pause Points` sections. Procedure-doc agents must NOT carry
// instruction-style mentions — those were removed in the cleanup PR that
// preceded this test.
const GATE_BRIEF_FILENAME_ALLOWLIST = new Set<string>([
  'orchestrator-reference.md',
]);
const GATE_BRIEF_FILENAME_RE = /gate-brief\.md/;

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
  // 2026-05-14: producers below are real skills with no owning agent and
  // none expected — they're genuinely cross-phase / cross-opp utilities.
  //
  // Originally this set had 6 entries; 4 were false positives because the
  // coherence test only read agent frontmatter's `skills:` list and missed
  // claims in `recurring_skills:` (timeline-monitor, flw-data-review,
  // solicitation-monitor) and `manual_skills:` (solicitation-review).
  // Fixed in PR following #292.
  'decisions-render',  // cross-phase utility; renders decisions.yaml -> gdoc.
                       // Invoked directly by ace-orchestrator (which has no
                       // phase_ordinal so no skills: list of its own).
  'eval-calibration',  // produces an opp-level artifact (eval-calibration/
                       // known-issues.md), not a per-run skill any phase
                       // agent dispatches.
  // 2026-07-21 (Plan C convergence): Phase 7 was rewired onto the /ace:demo
  // pipeline (demo-data-setup(ace-run) -> demo-narrative -> canopy DDD), so
  // these former Phase-7 producers are no longer claimed by the phase agent.
  // They stay on disk as a DEPRECATED fallback until the converged path is
  // validated end-to-end in a real /ace:run; deletion + artifact-manifest
  // cleanup is the staged follow-up. See agents/synthetic-data-and-workflows.md
  // § Deprecated skills.
  'synthetic-narrative-plan',
  'synthetic-data-generate',
  'synthetic-workflow-seed',
  'synthetic-workflow-polish',
  'synthetic-walkthrough-spec',
  'synthetic-walkthrough-run',
  'synthetic-summary',
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

  // ---------------------------------------------------------------------
  // Drift preventers added 2026-05-25 (tech-debt lens). Six phase agents
  // had `description:` strings claiming Phase N+1 while their
  // `phase_ordinal:` and H1 heading were correct; the 0.13.116 gate-brief
  // removal left 5 stale "do this" instructions in 3 files; `ocs-tester`
  // used a bare-string `skills:` shape while every other agent used the
  // object form. PR 480 fixed each instance; these assertions lock the
  // classes shut.
  // ---------------------------------------------------------------------

  it('phase agent description text mentions its own phase number consistently', () => {
    // Each phase agent's `description:` may forward-reference other
    // phases (e.g. "Phase 9 is where LLOs first hear from ACE"), so we
    // can't assert the description mentions ONLY its own phase number.
    // What we CAN assert: when the description mentions a phase number
    // in the "Phase N of the ACE lifecycle" opening clause
    // (the agent's claim about itself), that number matches
    // phase_ordinal.
    const drift: string[] = [];
    for (const agent of PHASE_AGENTS) {
      if (!agent.description) continue;
      // Look for the self-introducing phrase. Tolerant of "Phase N of"
      // and "Phase N — " openings; ignores other "Phase N" mentions
      // later in the description (those may legitimately forward-ref).
      const m = agent.description.match(/Phase (\d+)(?: of| —)/);
      if (!m) continue;
      const claimed = Number(m[1]);
      if (claimed !== agent.phase_ordinal) {
        drift.push(
          `${agent.file}: description says "Phase ${claimed}" but phase_ordinal=${agent.phase_ordinal}`,
        );
      }
    }
    expect(drift, 'phase number in description text disagrees with phase_ordinal').toEqual([]);
  });

  it('phase agent H1 heading mentions the same phase number as phase_ordinal', () => {
    // Phase agent bodies open with `# <Name> (Phase N)` or similar.
    // Drift here is the same class as the description case — pre-2026-05
    // renumbering era left H1s out of sync.
    const drift: string[] = [];
    for (const agent of PHASE_AGENTS) {
      const body = readAgentBody(agent.file);
      // First H1 line (the title); match `(Phase N)` if present.
      const h1 = body.split('\n').find((l) => l.startsWith('# '));
      if (!h1) continue;
      const m = h1.match(/\(Phase (\d+)/);
      if (!m) continue;
      const claimed = Number(m[1]);
      if (claimed !== agent.phase_ordinal) {
        drift.push(
          `${agent.file}: H1 says "(Phase ${claimed})" but phase_ordinal=${agent.phase_ordinal}`,
        );
      }
    }
    expect(drift, 'phase number in H1 heading disagrees with phase_ordinal').toEqual([]);
  });

  it('no agent file outside the reference doc carries `*gate-brief*.md` instruction text', () => {
    // The 0.13.116 gate-brief removal documented the change in
    // orchestrator-reference.md but left 5 stale producer-side "do this"
    // instructions in 3 files. They're gone now; this assertion stops
    // the class from regrowing.
    //
    // Approach: match the artifact filename shape (`gate-brief.md` —
    // i.e. a path with `.md` suffix) rather than prose mentions
    // ("gate-briefs/"). Prose explaining the removal is fine; pointing
    // at a path that doesn't exist is not.
    const violations: string[] = [];
    for (const agentFile of fs.readdirSync(AGENTS_DIR)) {
      if (!agentFile.endsWith('.md')) continue;
      if (GATE_BRIEF_FILENAME_ALLOWLIST.has(agentFile)) continue;
      const src = fs.readFileSync(path.join(AGENTS_DIR, agentFile), 'utf-8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (GATE_BRIEF_FILENAME_RE.test(line)) {
          violations.push(`${agentFile}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(violations,
      '*gate-brief*.md path in non-reference agent file — 0.13.116 removed the artifact').toEqual([]);
  });

  it('every agent skills frontmatter block uses object entries (not bare strings)', () => {
    // Object form (`- { name: foo, has_judge: true }`) carries the
    // metadata the producer-claim coherence checks need (has_judge,
    // qa_skill, eval_skill). Bare-string form (`- foo`) silently
    // drops that metadata. Pre-2026-05-25 only ocs-tester used bare
    // strings; PR following this brings it onto the object form.
    const violations: string[] = [];
    for (const agent of ALL_AGENTS) {
      for (const block of agent.rawSkillsBlocks ?? []) {
        const bareCount = countBareStringEntries(block);
        if (bareCount > 0) {
          violations.push(
            `${agent.file}: skills/recurring_skills/manual_skills block has ${bareCount} bare-string entries`,
          );
        }
      }
    }
    expect(violations,
      'skills frontmatter entries must be objects with at least a `name:` key').toEqual([]);
  });
});
