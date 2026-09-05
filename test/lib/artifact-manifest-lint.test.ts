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
 * fit the per-run shape (opp.yaml lives at ACE/<opp>/, run_state.yaml lives at
 * the run root, etc.). Update those sets if a new path legitimately needs to
 * skip the shape check — and add a comment explaining why.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACT_MANIFEST, PHASE_DEFS } from '../../lib/artifact-manifest.js';
import { PHASE_FOLDERS, ROLE_VOCAB, baseRole } from '../../lib/artifact-manifest-roles.js';

const SKILLS_DIR = path.resolve(import.meta.dirname, '../../skills');
const AGENTS_DIR = path.resolve(import.meta.dirname, '../../agents');

// Opp-level paths: live at ACE/<opp>/ (Connect-opp) or
// ACE/partnerships/<slug>/ (partnership-video), NOT under runs/<run-id>/.
const OPP_LEVEL_EXEMPT = new Set([
  // Connect-opp pipeline
  'inputs/',
  'opp.yaml',
  'open-questions.md',
  'eval-calibration/known-issues.md',
  // Partnership-video pipeline (prospect-level, live across runs)
  'prospect.yaml',
  'research/deep-research.md',
  'research/connect-fit.md',
]);

// Run-level paths: live at runs/<run-id>/, but NOT under any phase folder.
const RUN_LEVEL_EXEMPT = new Set([
  // Connect-opp pipeline
  'run_state.yaml',
  'inputs-manifest.yaml', // frozen pointer-set captured at run start (orchestrator-emitted)
  'decisions.yaml',       // per-run structured decisions log (rows accumulate across all phases)
  'decisions.gdoc',       // prose Google Doc rendering of decisions.yaml (one stable URL per run)
  // Partnership-video pipeline (run-root artifacts, not under a phase folder)
  'angles.yaml',          // three grounded narrative angles — propose-phase terminal artifact
  'video_spec.yaml',      // filled ace-web spec as POSTed
  'deck_spec.yaml',       // filled TrainingDeckSpec YAML
  'package.yaml',         // final output URL bundle (video + deck + publish)
  'micro-demo/',          // micro-demo clip bundle (directory; provenance.yaml + clip files)
]);

// Structural sub-folders allowed as the SECOND segment under a phase folder
// (in addition to skill names). These group related artifacts that aren't
// individual <skill>[_<role>].<ext> files.
const STRUCTURAL_SUB_FOLDERS = new Set([
  'recipes',          // 3-commcare/recipes/journey-{learn,deliver}.yaml (app-test-cases smoke recipes, ace#892)
  'mobile-recipes',   // 6-qa-and-training/mobile-recipes/{learn,deliver}/manifest.yaml
  'screenshots',      // 6-qa-and-training/screenshots/...
  'walkthroughs',     // 7-synthetic/walkthroughs/<persona>-<timestamp>/slideshow.html
  'timeline-monitor', // 9-execution-manager/timeline-monitor/YYYY-MM-DD.md
  'flw-data-review',  // 9-execution-manager/flw-data-review/YYYY-MM-DD.md
  'opp-eval',         // 10-closeout/opp-eval/...
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
    // Some manifest entries are produced by agents (e.g. idea-to-design_summary.md,
    // commcare-setup_summary.md, closeout_summary.md). The agent-form filename is
    // valid as long as the agent exists under agents/. Phase 8's
    // execution-manager_summary.md is produced by the execution-manager agent.
    const errors: string[] = [];
    for (const a of ARTIFACT_MANIFEST) {
      if (OPP_LEVEL_EXEMPT.has(a.path) || RUN_LEVEL_EXEMPT.has(a.path)) continue;
      const segs = a.path.split('/');
      if (segs.length < 2) continue; // already errored above
      const second = segs[1];
      if (segs.length === 2) {
        // Leaf form: extract skill (or agent) name from filename.
        const skill = second.split('_')[0].replace(/\.(md|yaml|json|gdoc)$/, '');
        if (
          !knownSkills.has(skill) &&
          !knownAgents.has(skill) &&
          !STRUCTURAL_SUB_FOLDERS.has(skill) &&
          !knownSkills.has(a.producedBy) &&
          !knownAgents.has(a.producedBy)
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
      // PHASE_FOLDERS is a partial map over Phase: some phases (e.g.
      // partnership-publish) write only run-root artifacts and have no phase
      // folder, so the lookup can legitimately return undefined.
      const expectedFolder = (PHASE_FOLDERS as Record<string, string | undefined>)[a.phase];
      if (!expectedFolder) continue;
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

  it('all expected phases represented', () => {
    const phases = new Set(ARTIFACT_MANIFEST.map((a) => a.phase));
    // The 10 ACE Connect-opp pipeline phases must all be present.
    const corePhases = [
      'design',
      'scenarios-and-acceptance',
      'commcare',
      'connect',
      'ocs',
      'qa-and-training',
      'synthetic-data-and-workflows',
      'solicitation-management',
      'execution-management',
      'closeout',
    ];
    for (const p of corePhases) {
      expect(phases, `missing core phase '${p}'`).toContain(p);
    }
    // The partnership-video pipeline phases that produce registered artifacts
    // must all be present. partnership-publish is intentionally absent: it only
    // writes to existing run-root files (package.yaml) and run_state.yaml — no
    // new artifact unique to that phase.
    const partnershipPhases = [
      'partnership-research',
      'partnership-angles',
      'partnership-microdemo',
      'partnership-video-build',
      'partnership-deck-build',
    ];
    for (const p of partnershipPhases) {
      expect(phases, `missing partnership phase '${p}'`).toContain(p);
    }
  });

  /**
   * Phase ordinals inside `description` must agree with the entry's own
   * path and with PHASE_DEFS.
   *
   * These strings are not decoration: `verify_phase_artifacts` returns
   * `description` (alongside `producedBy`) in every `missing[]` entry, so
   * this is the text an orchestrator or a phase subagent reads while
   * healing a fence miss — at exactly the moment it is deciding what to
   * write and where. A stale ordinal actively misdirects.
   *
   * Three summary descriptions carried pre-renumber ordinals for months
   * (the Phase 8 solicitation summary described itself as "Phase 7"),
   * observed live on `spark-facilitator/20260813-2126` and fixed with
   * this test (dimagi-internal/ace#1308). Renumbers have happened before
   * (0.13.0 and 0.13.x both shifted the tail of the pipeline) and the
   * prose is the thing that does not get updated, so the invariant is
   * mechanical rather than remembered.
   */
  it('a description that leads with "Phase N" matches its own path ordinal', () => {
    const errors: string[] = [];
    for (const a of ARTIFACT_MANIFEST) {
      const claimed = /^Phase (\d+)\b/.exec(a.description ?? '');
      if (!claimed) continue;
      const own = /^(\d+)-/.exec(a.path);
      if (!own) {
        errors.push(`${a.path}: description leads with "Phase ${claimed[1]}" but the path has no ordinal prefix`);
        continue;
      }
      if (claimed[1] !== own[1]) {
        errors.push(`${a.path}: description says "Phase ${claimed[1]}", path says phase ${own[1]}`);
      }
    }
    expect(errors).toEqual([]);
  });

  it('every "Phase N (<phase>)" in a description uses that phase\'s real ordinal', () => {
    // Ordinal lookup accepts BOTH key-spaces (`execution-management` and
    // `execution-manager`), since descriptions use the agent name.
    const ordinalOf = new Map<string, number>();
    for (const d of PHASE_DEFS) {
      ordinalOf.set(d.key, d.ordinal);
      ordinalOf.set(d.agentName, d.ordinal);
    }
    // The partnership-video pipeline numbers its phases locally (1..6) while
    // PHASE_DEFS continues the global sequence at 11..16, so its folder
    // ordinals and PHASE_DEFS ordinals legitimately disagree. Only the
    // Connect-opp pipeline (ordinals 1..10) is checked here.
    const errors: string[] = [];
    for (const a of ARTIFACT_MANIFEST) {
      for (const m of (a.description ?? '').matchAll(/Phase (\d+) \(([a-z0-9-]+)\)/g)) {
        const real = ordinalOf.get(m[2]);
        if (real === undefined || real > 10) continue; // not a phase name, or partnership pipeline
        if (Number(m[1]) !== real) {
          errors.push(`${a.path}: description says "Phase ${m[1]} (${m[2]})" but ${m[2]} is phase ${real}`);
        }
      }
    }
    expect(errors).toEqual([]);
  });

  it('every artifact has at least a producedBy', () => {
    for (const a of ARTIFACT_MANIFEST) {
      expect(a.producedBy, `${a.path} missing producedBy`).toBeTruthy();
    }
  });
});

/**
 * Phase 7 converged onto the /ace:demo pipeline (Plan C, 2026-07-21):
 * `demo-data-setup` → `demo-narrative` → canopy DDD. The manifest's REQUIRED
 * set went on declaring the retired Plan B chain's eval verdicts, so
 * `verify_phase_artifacts` reported `0/4 required artifacts found` against a
 * Phase 7 that had produced everything the converged pipeline produces —
 * live dashboards, a validated narrative, and a rendered walkthrough.
 * (hh-poverty-targeting/20260728-0705.)
 *
 * The retired entries stay declared (the deprecated skills are still on disk
 * as a fallback) but must never be REQUIRED again, or the gate goes back to
 * failing every converged run.
 */
describe('phase 7 required set tracks the converged pipeline', () => {
  const PHASE = 'synthetic-data-and-workflows';

  // Skills the converged pipeline does NOT run. Anything they produce is, by
  // definition, not required for a Phase 7 to be complete.
  const RETIRED_PRODUCERS = new Set([
    'synthetic-narrative-plan',
    'synthetic-narrative-plan-qa',
    'synthetic-narrative-plan-eval',
    'synthetic-data-generate',
    'synthetic-data-generate-eval',
    'synthetic-workflow-seed',
    'synthetic-workflow-seed-eval',
    'synthetic-workflow-polish',
    'synthetic-workflow-polish-eval',
    'synthetic-walkthrough-spec',
    'synthetic-walkthrough-spec-qa',
    'synthetic-walkthrough-spec-eval',
    'synthetic-walkthrough-run',
    'synthetic-summary',
    'synthetic-summary-eval',
  ]);

  const phase7 = ARTIFACT_MANIFEST.filter((a) => a.phase === PHASE);
  const required = phase7.filter((a) => a.required);

  it('requires nothing produced by a retired Plan B skill', () => {
    const offenders = required
      .filter((a) => RETIRED_PRODUCERS.has(a.producedBy))
      .map((a) => `${a.path} (producedBy: ${a.producedBy})`);
    expect(offenders).toEqual([]);
  });

  it('requires the converged pipeline handoff, gate, narrative and summary', () => {
    const requiredPaths = new Set(required.map((a) => a.path));
    for (const p of [
      '7-synthetic/realized.json',
      '7-synthetic/demo-data-setup_manifest.yaml',
      '7-synthetic/demo-data-setup-qa_result.yaml',
      '7-synthetic/why_brief.yaml',
      '7-synthetic/synthetic-data-and-workflows_summary.md',
    ]) {
      expect(requiredPaths, `${p} must be required for phase 7`).toContain(p);
    }
  });

  it('never marks a placeholder path required — diffArtifacts matches exactly', () => {
    // A path carrying a `<placeholder>` segment can never satisfy an exact
    // match, so requiring one guarantees a permanently-failing gate.
    const offenders = required.filter((a) => a.path.includes('<')).map((a) => a.path);
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1308 — three manifest descriptions still carried the OLD
// phase ordinals from before the pipeline renumber (solicitation-management
// described as "Phase 7", execution-manager as "Phase 8", closeout as
// "Phase 9").
//
// Not cosmetic: these description strings are the payload
// `verify_phase_artifacts` returns in each `missing[]` entry, alongside
// `producedBy`. That is exactly the text an orchestrator — or a phase subagent
// healing its own fence miss — reads at the moment it is deciding what to
// write and where. The fence was telling a Phase 8 agent it was Phase 7.
//
// PHASE_DEFS is the single source of truth for the (key ↔ agentName ↔ ordinal)
// relationship, so any ordinal restated in prose is derived data and must be
// checked against it rather than maintained by hand.
// ---------------------------------------------------------------------------

describe('manifest descriptions cite the current phase ordinal (#1308)', () => {
  it('no description contradicts PHASE_DEFS', () => {
    // Keyed as plain strings: the captured group is a `string`, and `key` is
    // the narrower `Phase` union, so an inferred Map<Phase, number> would not
    // accept the lookup.
    const byAgent = new Map<string, number>(PHASE_DEFS.map((p) => [p.agentName, p.ordinal]));
    const byKey = new Map<string, number>(PHASE_DEFS.map((p) => [p.key as string, p.ordinal]));
    const stale: string[] = [];

    for (const entry of ARTIFACT_MANIFEST) {
      // Matches the "Phase N (<agent-or-key>)" convention these descriptions
      // use; anything not naming a phase in that shape is out of scope.
      for (const m of (entry.description ?? '').matchAll(/Phase (\d+) \(([a-z-]+)\)/g)) {
        const expected = byAgent.get(m[2]) ?? byKey.get(m[2]);
        if (expected === undefined) continue; // not a phase name — leave it alone
        if (Number(m[1]) !== expected) {
          stale.push(`${entry.path}: "${m[0]}" should be Phase ${expected}`);
        }
      }
    }

    expect(
      stale,
      'these manifest descriptions cite a stale phase ordinal. They are returned ' +
        'verbatim by verify_phase_artifacts in missing[] entries, so a healing agent ' +
        `reads them while deciding what to write (ace#1308):\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });
});

/**
 * dimagi-internal/ace#1865 — a REQUIRED artifact must not depend on an OPTIONAL one.
 *
 * `solicitation-create_published.md` was `required: false` while being `consumedBy` four
 * skills, one of which (`solicitation-create-eval`) produces a `required: true` artifact
 * of its own. The Phase 8 boundary fence therefore returned ok on a run that published a
 * live solicitation to labs but never wrote the local snapshot carrying the rubric — and
 * the miss would only surface days later at the human-gated `/ace:step
 * solicitation-review`, with responses already in hand.
 *
 * The class: if a REQUIRED artifact's producer reads some other artifact, the fence can
 * pass while that required artifact's own input is silently absent.
 *
 * THIS IS A RATCHET, not a clean invariant. The 20 entries below already had this shape
 * when the rule was written and are NOT asserted to be correct — each is either
 * legitimately optional (opp-level state, recurring per-date files, deep-eval verdicts
 * that only exist after an out-of-band `/ace:qa-deep`, records that exist only after an
 * award) or a latent ace#1865-class defect that nobody has triaged yet. The rule's job is
 * to stop NEW ones being added. When you review one, either flip it to `required: true`
 * or delete it from this ledger with a one-line note saying why it is genuinely optional.
 */
const KNOWN_OPTIONAL_INPUTS_TO_REQUIRED = new Set([
  // Exists ONLY on the componentized path — written when the input set declares
  // components (`Component: <n> of …`), absent on every single-PDD opp ACE has
  // ever run. `required: true` would fail all of them. The manifest carries one
  // boolean and cannot express "required iff componentized", so the condition
  // lives in lib/component-products.ts instead: buildComponentProducts throws
  // rather than emit `mode: componentized` with no components, which is the
  // failure this lint is really guarding against.
  '1-design/component-set.yaml',
  // Same shape, one phase later: the componentized Learn build memo exists only
  // when Phase 1 took the ingest path, so `required: true` would fail every
  // single-PDD opp. The condition it really carries — "name the gaps, and say
  // so when the inventory is unavailable rather than reporting none" — is
  // enforced in lib/learn-module-plan.ts, not by this boolean.
  '3-commcare/pdd-to-learn-app_build-memo.md',
  'opp.yaml',
  'decisions.yaml',
  'decisions.gdoc',
  'inputs-manifest.yaml',
  'open-questions.md',
  'eval-calibration/known-issues.md',
  '1-design/idea-to-pdd-qa_result.yaml',
  '1-design/pdd-to-work-order-qa_result.yaml',
  '1-design/pdd-to-work-order.gdoc',
  '2-research/partnership-research-qa_result.yaml',
  '2-scenarios/pdd-to-test-prompts-qa_result.yaml',
  '3-commcare/recipes/journey-deliver.yaml',
  '6-qa-and-training/app-screenshot-capture_manifest.yaml',
  '6-qa-and-training/app-ux-eval_verdict-deep.yaml',
  '7-synthetic/<narrative-slug>.yaml',
  '7-synthetic/branch-scrub_report.yaml',
  '8-solicitation-management/solicitation-create_draft.md',
  '8-solicitation-management/solicitation-review_award-record.md',
  '9-execution-manager/flw-data-review/YYYY-MM-DD.md',
  '9-execution-manager/timeline-monitor/YYYY-MM-DD.md',
]);

describe('required artifacts do not depend on optional ones (ace#1865)', () => {
  const producersOfRequired = new Set(
    ARTIFACT_MANIFEST.filter((a) => a.required).map((a) => a.producedBy),
  );

  const offenders = ARTIFACT_MANIFEST.filter(
    (a) => !a.required && (a.consumedBy ?? []).some((c) => producersOfRequired.has(c)),
  );

  it('introduces no NEW optional artifact feeding a required one', () => {
    const added = offenders
      .filter((a) => !KNOWN_OPTIONAL_INPUTS_TO_REQUIRED.has(a.path))
      .map((a) => {
        const via = (a.consumedBy ?? []).filter((c) => producersOfRequired.has(c));
        return `${a.path} is required:false but feeds required artifact(s) via ${via.join(', ')}`;
      });

    expect(
      added,
      `New ace#1865-class entries. Either mark the artifact required:true, or add it to ` +
        `KNOWN_OPTIONAL_INPUTS_TO_REQUIRED with a note on why it is genuinely optional:\n` +
        added.join('\n'),
    ).toEqual([]);
  });

  it('keeps the grandfathered ledger honest — no stale entries', () => {
    const offenderPaths = new Set(offenders.map((a) => a.path));
    const stale = [...KNOWN_OPTIONAL_INPUTS_TO_REQUIRED].filter((p) => !offenderPaths.has(p));

    expect(
      stale,
      `These are listed as grandfathered but no longer have the ace#1865 shape ` +
        `(fixed, or the artifact was removed). Delete them from the ledger:\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('the Phase 8 published-solicitation snapshot is required (the ace#1865 instance)', () => {
    const published = ARTIFACT_MANIFEST.find(
      (a) => a.path === '8-solicitation-management/solicitation-create_published.md',
    );
    expect(published, 'manifest entry missing').toBeDefined();
    expect(published!.required).toBe(true);
  });
});
