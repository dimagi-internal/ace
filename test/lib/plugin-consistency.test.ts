/**
 * Structural-consistency tests for the ACE plugin.
 *
 * Catches the class of bug where a SKILL.md, agent.md, or
 * artifact-manifest entry references a skill name that no longer
 * exists (e.g., after a rename or deletion). Without this guard, the
 * plugin loads cleanly but breaks at run-time when a skill is
 * dispatched by name.
 *
 * Added 0.10.87 after the per-artifact training split surfaced this
 * class of risk: deleting `training-materials` could leave orphan
 * references in the agent / opp-eval / artifact-manifest that nothing
 * type-checks.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACT_MANIFEST } from '../../lib/artifact-manifest.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const SKILLS_DIR = path.join(ROOT, 'skills');
const AGENTS_DIR = path.join(ROOT, 'agents');

function listSkillNames(): Set<string> {
  // Skill directory name == skill `name` field (ACE convention enforced
  // separately by skills/README.md). Use the directory name as the
  // canonical identifier.
  return new Set(
    fs
      .readdirSync(SKILLS_DIR)
      .filter((d) => {
        const skillFile = path.join(SKILLS_DIR, d, 'SKILL.md');
        return fs.statSync(path.join(SKILLS_DIR, d)).isDirectory() && fs.existsSync(skillFile);
      }),
  );
}

function parseAgentSkillsList(agentMd: string): string[] {
  // Frontmatter `skills:` block:
  //   skills:
  //     - { name: foo,  has_judge: true }
  //     - { name: bar,  has_judge: false }
  // Returns the names in order.
  const m = agentMd.match(/^skills:\s*\n((?:\s*-\s*\{[^}]*\}\s*\n?)+)/m);
  if (!m) return [];
  const block = m[1];
  const names: string[] = [];
  for (const line of block.split('\n')) {
    const nm = line.match(/name:\s*([a-z][a-z0-9-]*)/);
    if (nm) names.push(nm[1]);
  }
  return names;
}

describe('plugin consistency', () => {
  const skills = listSkillNames();

  it('every skill directory has a SKILL.md with a matching `name:` frontmatter field', () => {
    for (const skill of skills) {
      const skillFile = path.join(SKILLS_DIR, skill, 'SKILL.md');
      const content = fs.readFileSync(skillFile, 'utf8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      expect(fmMatch, `${skill}/SKILL.md missing YAML frontmatter`).toBeTruthy();
      const nameMatch = fmMatch![1].match(/^name:\s*(\S+)/m);
      expect(nameMatch, `${skill}/SKILL.md missing name: field`).toBeTruthy();
      expect(nameMatch![1], `${skill}/SKILL.md name: field doesn't match directory`).toBe(skill);
    }
  });

  // Non-skill producers/consumers in the manifest:
  //   - `external` — sentinel for user-supplied artifacts (e.g. idea.md)
  //   - agent names — phase agents (procedure docs OR subagents) that
  //     own composite multi-skill outputs (e.g. ocs-setup writes
  //     widget-handoff.md collaboratively across multiple sub-skills + HITL)
  const validNonSkillProducers = new Set<string>([
    'external',
    ...fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')),
  ]);

  it('every artifact-manifest producedBy points at an existing skill or agent', () => {
    const orphans: string[] = [];
    for (const entry of ARTIFACT_MANIFEST) {
      if (validNonSkillProducers.has(entry.producedBy)) continue;
      if (!skills.has(entry.producedBy)) {
        orphans.push(`${entry.path} producedBy=${entry.producedBy}`);
      }
    }
    expect(orphans, `artifact-manifest references non-existent skills/agents: ${orphans.join(', ')}`).toEqual([]);
  });

  it('every artifact-manifest consumedBy entry points at an existing skill or agent', () => {
    const orphans: string[] = [];
    for (const entry of ARTIFACT_MANIFEST) {
      for (const consumer of entry.consumedBy) {
        if (validNonSkillProducers.has(consumer)) continue;
        if (!skills.has(consumer)) {
          orphans.push(`${entry.path} consumedBy=${consumer}`);
        }
      }
    }
    expect(orphans, `artifact-manifest references non-existent skill consumers: ${orphans.join(', ')}`).toEqual([]);
  });

  it('every skill listed in an agent.md skills: block exists', () => {
    const agents = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'));
    const orphans: string[] = [];
    for (const agentFile of agents) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, agentFile), 'utf8');
      const skillsList = parseAgentSkillsList(content);
      for (const skill of skillsList) {
        if (!skills.has(skill)) {
          orphans.push(`${agentFile} → ${skill}`);
        }
      }
    }
    expect(orphans, `agent skills: blocks reference non-existent skills: ${orphans.join(', ')}`).toEqual([]);
  });
});
