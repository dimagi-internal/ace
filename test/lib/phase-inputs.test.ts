import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PHASE_DEFS, artifactsConsumedBy } from '../../lib/artifact-manifest';
import {
  checkPhasePreconditions,
  crossPhaseInputs,
  parsePhaseAgentSkills,
  phaseSkillsFromRepo,
} from '../../lib/phase-inputs';

const REPO = join(__dirname, '..', '..');
const PIPELINE = PHASE_DEFS.filter((d) => d.ordinal <= 10);

function inputsOf(phase: string, mode?: string): string[] {
  const r = crossPhaseInputs(phase, phaseSkillsFromRepo(phase, REPO), mode);
  if (r.status === 'unable') throw new Error(r.reason);
  return r.inputs.map((i) => i.path);
}

describe('crossPhaseInputs — the resume fence sees cross-phase edges (ace#2134)', () => {
  it('the OLD query (artifactsConsumedBy(<phase key>)) is blind — it matches skill names, not phases', () => {
    // Pins the defect: consumedBy holds SKILL names, so a phase-keyed lookup
    // finds nothing for the phases the fence most needed.
    for (const key of ['commcare', 'connect', 'ocs', 'qa-and-training'] as const) {
      expect(artifactsConsumedBy(key)).toEqual([]);
    }
  });

  it('every pipeline phase after Phase 1 has at least one cross-phase required input', () => {
    for (const d of PIPELINE.filter((p) => p.ordinal >= 2)) {
      expect(inputsOf(d.key).length, `${d.agentName} derived no cross-phase inputs`).toBeGreaterThan(0);
    }
  });

  it('Phase 1 resolves (it is not UNABLE) and has no earlier phase to depend on', () => {
    expect(inputsOf('idea-to-design')).toEqual([]);
  });

  it('carries the edges the issue named, keyed by either phase name form', () => {
    expect(inputsOf('commcare')).toContain('2-scenarios/pdd-to-app-journeys.md');
    expect(inputsOf('connect-setup')).toContain('3-commcare/app-deploy_summary.md');
    expect(inputsOf('ocs')).toContain('2-scenarios/pdd-to-test-prompts.md');
    expect(inputsOf('qa-and-training')).toEqual(
      expect.arrayContaining(['3-commcare/app-test-cases.yaml', '5-ocs/ocs-agent-setup.md']),
    );
  });

  it('never lists a same-phase or later-phase artifact', () => {
    for (const d of PIPELINE) {
      const r = crossPhaseInputs(d.key, phaseSkillsFromRepo(d.key, REPO));
      if (r.status === 'unable') throw new Error(r.reason);
      for (const i of r.inputs) {
        const producer = PHASE_DEFS.find((p) => p.key === i.producerPhase)!;
        expect(producer.ordinal, `${d.agentName} <- ${i.path}`).toBeLessThan(d.ordinal);
      }
    }
  });

  it('NEGATIVE CONTROL: an empty skill list is UNABLE, never "no inputs"', () => {
    const r = crossPhaseInputs('commcare', []);
    expect(r.status).toBe('unable');
  });

  it('NEGATIVE CONTROL: an unknown phase is UNABLE', () => {
    expect(crossPhaseInputs('commcare-setupp', ['app-release']).status).toBe('unable');
  });

  it('app-QA-only mode drops the inputs only the skipped training skills read', () => {
    expect(inputsOf('qa-and-training')).toContain('5-ocs/ocs-setup_widget-handoff.md');
    const qaOnly = inputsOf('qa-and-training', 'app-QA-only');
    expect(qaOnly.some((p) => p.startsWith('5-ocs/'))).toBe(false);
    expect(qaOnly).toContain('3-commcare/app-test-cases.yaml');
  });
});

describe('parsePhaseAgentSkills', () => {
  it('collects skills, recurring and manual skills, and each eval_skill', () => {
    const md = [
      '---',
      'name: x',
      'skills:',
      '  - { name: a, has_judge: true, eval_skill: a-eval }',
      '  - b',
      'recurring_skills:',
      '  - { name: c, has_judge: false }',
      'manual_skills:',
      '  - { name: d, has_judge: true, eval_skill: d-eval }',
      '---',
      '# body',
    ].join('\n');
    expect(parsePhaseAgentSkills(md).sort()).toEqual(['a', 'a-eval', 'b', 'c', 'd', 'd-eval']);
  });

  it('returns [] when there is no frontmatter (the caller turns that into UNABLE)', () => {
    expect(parsePhaseAgentSkills('# no frontmatter')).toEqual([]);
  });

  it('reads every real pipeline agent', () => {
    for (const d of PIPELINE) {
      expect(phaseSkillsFromRepo(d.key, REPO).length, d.agentName).toBeGreaterThan(0);
    }
  });
});

describe('checkPhasePreconditions — the resume fence itself', () => {
  // Captured evidence: the real Drive inventory + run_state of
  // spark-facilitator/20260926-1800 (Phases 1-6 done, 7 partial, 8-10 pending;
  // gathered read-only 2026-10-01 — see the fixture's README.md).
  const FIXTURE = join(REPO, 'test', 'fixtures', 'release-readiness', 'spark-20260926-1800');
  const inventory: string[] = (
    JSON.parse(readFileSync(join(FIXTURE, 'inventory.json'), 'utf8')) as Array<{ path: string }>
  ).map((e) => e.path);
  const runState = parseYaml(readFileSync(join(FIXTURE, 'run_state.yaml'), 'utf8')) as {
    phases: Record<string, { status?: string; mode?: string }>;
  };
  const statuses = Object.fromEntries(Object.entries(runState.phases).map(([k, v]) => [k, v?.status]));
  const skills = phaseSkillsFromRepo('qa-and-training', REPO);

  it('POSITIVE CONTROL: every pipeline phase passes on a real, correctly shaped run', () => {
    for (const d of PIPELINE) {
      const r = checkPhasePreconditions({
        phase: d.key,
        skills: phaseSkillsFromRepo(d.key, REPO),
        presentPaths: inventory,
        phaseStatuses: statuses,
        mode: runState.phases[d.agentName]?.mode,
      });
      expect(r.status, d.agentName).toBe('checked');
      if (r.status === 'checked') expect(r.findings, d.agentName).toEqual([]);
    }
  });

  it('NEGATIVE CONTROL: the poverty-graduation/20260905-1345 shape — Phase 3 `done` but its test cases gone', () => {
    const present = inventory.filter((p) => p !== '3-commcare/app-test-cases.yaml');
    const r = checkPhasePreconditions({ phase: 'qa-and-training', skills, presentPaths: present, phaseStatuses: statuses });
    expect(r.status).toBe('checked');
    if (r.status !== 'checked') return;
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => [f.path, f.producerAgent, f.remedy])).toEqual([
      ['3-commcare/app-test-cases.yaml', 'commcare-setup', 'rerun-producer'],
    ]);
  });

  it('NEGATIVE CONTROL: a skipped producer is a mis-shaped seed (remedy: reshape)', () => {
    const present = inventory.filter((p) => !p.startsWith('2-scenarios/'));
    const r = checkPhasePreconditions({
      phase: 'qa-and-training',
      skills,
      presentPaths: present,
      phaseStatuses: { ...statuses, 'scenarios-and-acceptance': 'skipped' },
    });
    if (r.status !== 'checked') throw new Error('expected checked');
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => [f.path, f.producerStatus, f.remedy])).toContainEqual([
      '2-scenarios/pdd-to-app-journeys.md',
      'skipped',
      'reshape',
    ]);
  });

  it('an input whose producer is still pending is not missing — the earlier phase runs first', () => {
    const present = inventory.filter((p) => !p.startsWith('5-ocs/'));
    const r = checkPhasePreconditions({
      phase: 'qa-and-training',
      skills,
      presentPaths: present,
      phaseStatuses: { ...statuses, 'ocs-setup': 'pending' },
    });
    if (r.status !== 'checked') throw new Error('expected checked');
    expect(r.ok).toBe(true);
  });

  it('UNABLE propagates — an empty skill list is never a pass', () => {
    const r = checkPhasePreconditions({ phase: 'qa-and-training', skills: [], presentPaths: [], phaseStatuses: {} });
    expect(r.status).toBe('unable');
  });
});

describe('the orchestrator resume fence uses the phase-input helper', () => {
  it('names scripts/phase-inputs.ts and no longer routes the fence through artifactsConsumedBy', () => {
    const doc = readFileSync(join(REPO, 'agents', 'ace-orchestrator.md'), 'utf8');
    const fence = doc.slice(doc.indexOf('**Structural precondition check'), doc.indexOf('**Products-presence check'));
    expect(fence).toContain('scripts/phase-inputs.ts');
    expect(fence).not.toMatch(/per\s+`lib\/artifact-manifest\.ts`\s+`artifactsConsumedBy`/);
  });
});
