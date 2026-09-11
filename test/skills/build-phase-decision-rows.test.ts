/**
 * The build phases' calls reach the decisions register, and the boundary
 * fence fails a build that kept them only in prose (dimagi-internal/ace#2384,
 * a regression of #399).
 *
 * `poverty-graduation/20260905-1345` and `20260908-0510` carried 61 and 66
 * decision rows, none from Phase 3, while the Deliver summary listed four
 * `[ACE]` latitudes in its build memo. Three things let that happen, and
 * each is pinned here:
 *
 *   1. `pdd-to-learn-app` had no Decisions Log section at all, and
 *      `pdd-to-deliver-app`'s was a catalogue "not a required set" — so no
 *      producer was told its memo entries ARE decisions.
 *   2. The phase agents' per-step Output bullets (the procedural authority,
 *      per #399) enumerated only optional catalogue rows.
 *   3. The fence's Decisions log clause gated on a "calibration set" with
 *      required rows that Phase 3 does not have, and had no implementation.
 *
 * The behaviour of the check itself is `test/lib/build-phase-decisions.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** From `marker` to the next occurrence of `next` after it ('' if absent). */
function slice(doc: string, marker: string, next: string): string {
  const start = doc.indexOf(marker);
  if (start < 0) return '';
  const end = doc.indexOf(next, start + marker.length);
  return doc.slice(start, end < 0 ? undefined : end);
}

const PRODUCERS = [
  { skill: 'pdd-to-learn-app', tag: '3-commcare', fencePhase: 'commcare', prefix: 'learn' },
  { skill: 'pdd-to-deliver-app', tag: '3-commcare', fencePhase: 'commcare', prefix: 'deliver' },
  { skill: 'connect-opp-setup', tag: '4-connect', fencePhase: 'connect', prefix: 'connect' },
] as const;

describe('each build-memo producer derives decision rows from its memo entries', () => {
  for (const { skill, tag, fencePhase, prefix } of PRODUCERS) {
    const doc = read(`skills/${skill}/SKILL.md`);
    const log = slice(doc, '## Decisions Log', '\n## Change');

    it(`${skill} has a Decisions Log section`, () => {
      expect(log, `skills/${skill}/SKILL.md has no ## Decisions Log section`).not.toBe('');
    });

    it(`${skill}: memo entries are REQUIRED rows, from one source`, () => {
      expect(log).toContain('### Every build-memo entry is also a decision row (REQUIRED)');
      expect(log).toContain('**One source, two renderings.**');
    });

    it(`${skill}: latitude → inferred, ambiguity → conflicting, spot-check in reasoning`, () => {
      expect(log).toMatch(/`\[ACE\]` latitude → `inferred`/);
      expect(log).toMatch(/`\[FIXED\]` ambiguity → `conflicting`/);
      expect(log).toContain('`conflict_signals`');
      expect(log).toContain('Spot-check:');
      // ace-web drops keys outside its fixed set, so a new field would never
      // reach the reviewer — the doc must say why the location is in prose.
      expect(log).toContain('apps/opps/summary.py');
    });

    it(`${skill}: rows carry its own phase and skill tag, via the atom`, () => {
      expect(log).toContain('decisions_append_rows');
      expect(log).toContain(`phase: "${tag}"`);
      expect(log).toContain(`skill: "${skill}"`);
      expect(log).toContain(`\`${prefix}-latitude-<slug>\``);
    });

    it(`${skill}: names the fence that fails a silent build`, () => {
      expect(log).toContain('lib/build-phase-decisions.ts');
      expect(log).toContain(`verify_phase_artifacts(phase='${fencePhase}')`);
    });
  }

  it('the memo-writing steps point at the rows', () => {
    const learn7a = slice(read('skills/pdd-to-learn-app/SKILL.md'), '7a. **Write the build memo**', '8. **Notify admin group**');
    expect(learn7a).toContain('ALSO a decision row');
    const deliver7 = slice(read('skills/pdd-to-deliver-app/SKILL.md'), '7. **Write the summary**', '8. **Notify admin group**');
    expect(deliver7).toContain('ALSO a decision row');
    const opp8 = slice(read('skills/connect-opp-setup/SKILL.md'), '8. **Write config summary**', '9. **Capture the ConnectProd');
    expect(opp8).toContain('ALSO a decision row');
  });

  it('connect-opp-setup turns each verification rule into a row with a closed Where-applied vocabulary', () => {
    const log = slice(read('skills/connect-opp-setup/SKILL.md'), '## Decisions Log', '\n## Change');
    expect(log).toContain('`connect-rule-<slug>`');
    expect(log).toContain('`Not configurable on Connect — not applied`');
  });
});

describe('the phase agents enumerate the rows (#399: the agent file is the checklist)', () => {
  it('commcare-setup Step 1 Output requires one row per memo entry from BOTH app builds', () => {
    const agent = read('agents/commcare-setup.md');
    const step1 = slice(agent, '### Step 1: PDD to Apps', '### Step 1.5');
    expect(step1).toMatch(/From `pdd-to-learn-app` AND `pdd-to-deliver-app`/);
    expect(step1).toContain("verify_phase_artifacts(phase='commcare').decisions");
    expect(step1).not.toMatch(/the list is a working catalog, not a required set\)\.\s*$/m);
  });

  it('connect-setup Step 2 Output requires one row per Step 8 memo entry', () => {
    const agent = read('agents/connect-setup.md');
    const step2 = slice(agent, '### Step 2: Opportunity Setup', '### Step 3');
    expect(step2).toContain("verify_phase_artifacts(phase='connect').decisions");
  });
});

describe('the fence', () => {
  it('the Decisions log clause names its implementation instead of a catalogue condition', () => {
    const ref = read('agents/orchestrator-reference.md');
    const clause = slice(ref, '**Decisions log clause', '**Run-init ingest');
    expect(clause).not.toBe('');
    // The old gate, quoted in the history sentence, must no longer be the RULE.
    expect(clause).not.toMatch(/writes\. The orchestrator stub-fills/);
    expect(clause).toContain('lib/build-phase-decisions.ts');
    expect(clause).toContain("verify_phase_artifacts(phase='commcare'|'connect')");
  });

  it('Turn N+2 branches on verify.decisions and never heals by re-dispatching the producer', () => {
    const orch = read('agents/ace-orchestrator.md');
    const fence = slice(orch, '## Phase boundary fence', '### Self-heal sweep');
    expect(fence).toMatch(/AND verify\.decisions\.ok is not\s+false/);
    expect(fence).toContain('verify.decisions.ok=false');
    expect(fence).toContain('do NOT re-dispatch the producer');
    expect(fence).toContain('decisions_append_rows');
  });

  it('verify_phase_artifacts runs the check and reports it outside missing[]', () => {
    const src = read('mcp/google-drive-server.ts');
    const atom = slice(src, "'verify_phase_artifacts',", '\n);\n');
    expect(atom).toContain('verifyBuildPhaseDecisions(');
    expect(atom).toContain('unreadableBuildPhaseDecisions(');
    expect(atom).toMatch(/\.\.\.\(decisions \? \{ decisions \} : \{\}\)/);
  });
});
