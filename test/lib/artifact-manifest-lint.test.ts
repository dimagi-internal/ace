/**
 * Manifest lint — structural invariants over ARTIFACT_MANIFEST.
 *
 * Catches drift on every PR by asserting the closed-vocabulary contract that
 * Tasks 4–5 of docs/superpowers/plans/2026-05-03-run-folder-readability.md
 * established: every per-run path is `<phase-folder>/<skill>[_<role>].<ext>`,
 * every role is in ROLE_VOCAB, every phase tag matches its phase folder, and
 * every <skill> segment resolves to a real skill (or agent) directory.
 *
 * The opp-level / run-level exempt sets cover the handful of paths that don't
 * fit the per-run shape (opp.yaml lives at ACE/<opp>/, idea.md is the input
 * copy, etc.). Update those sets if a new path legitimately needs to skip the
 * shape check — and add a comment explaining why.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACT_MANIFEST } from '../../lib/artifact-manifest.js';
import { PHASE_FOLDERS, ROLE_VOCAB, baseRole } from '../../lib/artifact-manifest-roles.js';

const SKILLS_DIR = path.resolve(import.meta.dirname, '../../skills');
const AGENTS_DIR = path.resolve(import.meta.dirname, '../../agents');

// Opp-level paths: live at ACE/<opp>/, NOT under runs/<run-id>/.
const OPP_LEVEL_EXEMPT = new Set([
  'inputs/',
  'opp.yaml',
  'open-questions.md',
  'eval-calibration/known-issues.md',
]);

// Run-level paths: live at runs/<run-id>/, but NOT under any phase folder.
const RUN_LEVEL_EXEMPT = new Set([
  'run_state.yaml',
  'inputs-manifest.yaml', // frozen pointer-set captured at run start (orchestrator-emitted)
  'idea.md',              // optional operator free-text seed via --idea FILE|-
  '1-design/idea.md',     // legacy pre-2026-05-05 input-copy path; kept for back-compat
  'decisions.yaml',       // per-run structured decisions log (rows accumulate across all phases)
  'decisions.gdoc',       // prose Google Doc rendering of decisions.yaml (one stable URL per run)
]);

// Structural sub-folders allowed as the SECOND segment under a phase folder
// (in addition to skill names). These group related artifacts that aren't
// individual <skill>[_<role>].<ext> files.
const STRUCTURAL_SUB_FOLDERS = new Set([
  'mobile-recipes',   // 5-qa-and-training/mobile-recipes/{learn,deliver}/manifest.yaml
  'screenshots',      // 5-qa-and-training/screenshots/...
  'walkthroughs',     // 6-synthetic/walkthroughs/<persona>-<timestamp>/slideshow.html
  'timeline-monitor', // 8-execution-manager/timeline-monitor/YYYY-MM-DD.md
  'flw-data-review',  // 8-execution-manager/flw-data-review/YYYY-MM-DD.md
  'opp-eval',         // 9-closeout/opp-eval/...
]);

const phaseFolderSet: Set<string> = new Set(Object.values(PHASE_FOLDERS));

function listDirNames(dir: string): Set<string> {
  return new Set(
    fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name),
  );
}

const knownSkills = listDirNames(SKILLS_DIR);
const knownAgents = new Set(
  fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => d.name.replace(/\.md$/, '')),
);

describe('artifact manifest lint', () => {
  it('every path is opp-level OR run-level exempt OR <phase-folder>/<skill-or-structural>...', () => {
    const errors: string[] = [];
    for (const a of ARTIFACT_MANIFEST) {
      if (OPP_LEVEL_EXEMPT.has(a.path) || RUN_LEVEL_EXEMPT.has(a.path)) continue;
      const segs = a.path.split('/');
      if (segs.length < 2) {
        errors.push(`${a.path}: not enough segments`);
        continue;
      }
      if (!phaseFolderSet.has(segs[0])) {
        errors.push(`${a.path}: first segment '${segs[0]}' is not a phase folder`);
      }
    }
    expect(errors).toEqual([]);
  });

  it('every <skill> in a path exists under skills/ or agents/ (or is a structural sub-folder)', () => {
    // Some manifest entries are produced by agents (e.g. design-review_summary.md,
    // commcare-setup_summary.md, closeout_summary.md). The agent-form filename is
    // valid as long as the agent exists under agents/. Phase 7's
    // execution-manager_summary.md is produced by the execution-manager agent.
    const errors: string[] = [];
    for (const a of ARTIFACT_MANIFEST) {
      if (OPP_LEVEL_EXEMPT.has(a.path) || RUN_LEVEL_EXEMPT.has(a.path)) continue;
      const segs = a.path.split('/');
      if (segs.length < 2) continue; // already errored above
      const second = segs[1];
      if (segs.length === 2) {
        // Leaf form: extract skill (or agent) name from filename.
        const skill = second.split('_')[0].replace(/\.(md|yaml|json)$/, '');
        if (
          !knownSkills.has(skill) &&
          !knownAgents.has(skill) &&
          !STRUCTURAL_SUB_FOLDERS.has(skill)
        ) {
          errors.push(
            `${a.path}: producer '${skill}' not under skills/ or agents/, and not structural`,
          );
        }
      } else {
        // Sub-folder form: second segment must be a skill, agent, structural
        // sub-folder, or a skill_role-shaped folder (e.g.
        // solicitation-monitor_responses/).
        const folderSkill = second.includes('_') ? second.split('_')[0] : second;
        if (
          !knownSkills.has(second) &&
          !knownAgents.has(second) &&
          !STRUCTURAL_SUB_FOLDERS.has(second) &&
          !knownSkills.has(folderSkill) &&
          !knownAgents.has(folderSkill)
        ) {
          errors.push(
            `${a.path}: sub-folder '${second}' is not a skill, agent, or structural sub-folder`,
          );
        }
      }
    }
    expect(errors).toEqual([]);
  });

  it('every role is in ROLE_VOCAB (via baseRole)', () => {
    const errors: string[] = [];
    for (const a of ARTIFACT_MANIFEST) {
      if (!a.role) continue;
      const base = baseRole(a.role);
      if (!ROLE_VOCAB.has(base)) {
        errors.push(`${a.path}: role '${a.role}' (base '${base}') not in ROLE_VOCAB`);
      }
    }
    expect(errors).toEqual([]);
  });

  it('phase tag matches phase folder in path (when applicable)', () => {
    const errors: string[] = [];
    for (const a of ARTIFACT_MANIFEST) {
      if (OPP_LEVEL_EXEMPT.has(a.path) || RUN_LEVEL_EXEMPT.has(a.path)) continue;
      const expectedFolder = PHASE_FOLDERS[a.phase];
      if (!expectedFolder) continue; // shouldn't happen; Phase enum is exhaustive
      if (!a.path.startsWith(expectedFolder + '/')) {
        errors.push(`${a.path} tagged ${a.phase} but path doesn't start with ${expectedFolder}/`);
      }
    }
    expect(errors).toEqual([]);
  });

  it('no duplicate paths', () => {
    const paths = ARTIFACT_MANIFEST.map((a) => a.path);
    const dupes = paths.filter((p, i) => paths.indexOf(p) !== i);
    expect(dupes).toEqual([]);
  });

  it('all nine phases represented', () => {
    const phases = new Set(ARTIFACT_MANIFEST.map((a) => a.phase));
    expect(phases).toEqual(new Set([
      'design',
      'commcare',
      'connect',
      'ocs',
      'qa-and-training',
      'synthetic-data-and-workflows',
      'solicitation-management',
      'execution-management',
      'closeout',
    ]));
  });

  it('every artifact has at least a producedBy', () => {
    for (const a of ARTIFACT_MANIFEST) {
      expect(a.producedBy, `${a.path} missing producedBy`).toBeTruthy();
    }
  });
});
