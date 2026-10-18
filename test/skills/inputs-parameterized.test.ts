import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A skill's `## Inputs` must describe parameters a caller can pass, not only
 * the run files the pipeline happens to leave lying around.
 *
 * ## The failure class
 *
 * ACE now maintains live programs as well as building new ones. Most of that
 * maintenance work is the same platform action applied to an object that
 * already exists: re-release an app, refresh a bot's knowledge, read a
 * solicitation's responses. The 2026-10-18 build-vs-maintain audit found
 * about 30 skills whose action is general but whose ONLY route to the object
 * is a run artifact, such as `5-ocs/ocs-agent-setup.md` or
 * `run_state.phases.*`. For example, `ocs-knowledge-refresh`'s description
 * says "Needs the bot and the training docs", yet it cannot be handed a bot.
 * The cause was the author contract itself: `skills/README.md § Inputs`
 * defined an input as "the source phase, the path". Tracked as ace#3148.
 *
 * The contract now asks for parameters with a Resolver column
 * (§ Mechanics vs pipeline). A skill that really is pipeline-only, like
 * grading a Phase 3 summary, says so with a `Pipeline-only: <why>` line.
 *
 * ## The rule this test enforces
 *
 * A skill whose `## Inputs` section cites a run artifact (`run_state`,
 * `runs/`, `<run-id>`, `phases.`, a `<N>-<phase>/` path, or `Phase N`) must
 * also carry at least one marker that it can be driven by explicit input:
 *
 * - a `Resolver` column
 * - the word `explicit`, `argument` or `parameter`
 * - a `--flag`
 * - a `Pipeline-only:` declaration
 *
 * ## Why a ratchet
 *
 * 80 skills predated the rule. Failing them all at once would produce a test
 * nobody can land. So they are pinned in `LEDGER`, and only NEW offenders
 * fail. The ledger is a debt list, not an approval. When a skill is fixed it
 * must leave the ledger (the second test), so the gain locks in.
 */

const RUN_ARTIFACT =
  /run_state|runs\/|<run-id>|<run_id>|phases\.|\b\d{1,2}-[a-z][a-z-]+\/|\bPhase \d/;
const PARAM_MARKER =
  /Resolver|explicit|--[a-z][a-z-]+|\bargument|\bparameter|\bcaller[- ]supplied|\bpassed in|\bpipeline-only/i;

/** Skills whose `## Inputs` were run-only when the rule landed (2026-10-18). */
const LEDGER = new Set<string>([
  'app-connect-coverage', 'app-deploy', 'app-release', 'app-release-qa',
  'app-screenshot-capture', 'app-test-cases', 'app-ux-eval', 'build-targeting-model',
  'connect-opp-setup', 'connect-opp-setup-eval', 'connect-program-setup-eval',
  'decisions-render', 'decisions-sync', 'demo-data-setup-qa', 'demo-fidelity-check',
  'feedback-ledger', 'idea-to-pdd', 'idea-to-pdd-eval', 'learnings-summary-eval',
  'llo-invite', 'llo-uat-eval', 'ocs-agent-setup', 'ocs-knowledge-refresh',
  'ocs-widget-handoff-eval', 'partnership-angles', 'partnership-angles-eval',
  'partnership-deck-build', 'partnership-deck-build-eval', 'partnership-microdemo',
  'partnership-microdemo-eval', 'partnership-research-eval', 'partnership-research-qa',
  'partnership-video-build', 'partnership-video-build-eval', 'pdd-to-app-journeys',
  'pdd-to-app-journeys-eval', 'pdd-to-deliver-app-eval', 'pdd-to-learn-app',
  'pdd-to-learn-app-eval', 'pdd-to-test-prompts', 'pdd-to-test-prompts-eval',
  'pdd-to-test-prompts-qa', 'pdd-to-work-order-eval', 'pdd-to-work-order-qa',
  'semantic-registry-author', 'share-run-access', 'solicitation-create',
  'solicitation-create-eval', 'solicitation-monitor', 'solicitation-review',
  'solicitation-review-eval', 'solicitation-review-qa', 'synthetic-data-generate-eval',
  'synthetic-narrative-plan-eval', 'synthetic-narrative-plan-qa', 'synthetic-summary',
  'synthetic-summary-eval', 'synthetic-walkthrough-spec', 'synthetic-walkthrough-spec-eval',
  'synthetic-walkthrough-spec-qa', 'synthetic-workflow-polish-eval', 'synthetic-workflow-seed',
  'synthetic-workflow-seed-eval', 'target-geographies', 'training-deck-generate',
  'training-deck-generate-eval', 'training-deck-render', 'training-deck-render-eval',
  'training-faq', 'training-faq-eval', 'training-flw-guide', 'training-flw-guide-eval',
  'training-llo-guide', 'training-llo-guide-eval', 'training-onboarding-email',
  'training-onboarding-email-eval', 'training-quick-reference',
  'training-quick-reference-eval', 'video-spec-eval', 'video-spec-qa',
]);

const repoRoot = new URL('../..', import.meta.url).pathname;
const skillsDir = join(repoRoot, 'skills');

/** The body of `## Inputs` (up to the next h2), or null when absent. */
export function inputsSection(markdown: string): string | null {
  const m = markdown.match(/^## Inputs[^\n]*\n([\s\S]*?)(?=^## )/m);
  return m ? m[1] : null;
}

/** True when the section is run-coupled with no way to drive it explicitly. */
export function isRunOnly(section: string): boolean {
  return RUN_ARTIFACT.test(section) && !PARAM_MARKER.test(section);
}

function runOnlySkills(): string[] {
  const out: string[] = [];
  for (const name of readdirSync(skillsDir).sort()) {
    const file = join(skillsDir, name, 'SKILL.md');
    if (!existsSync(file)) continue;
    const section = inputsSection(readFileSync(file, 'utf8'));
    if (section !== null && isRunOnly(section)) out.push(name);
  }
  return out;
}

describe('skill Inputs are parameterized (build-vs-maintain contract)', () => {
  it('negative control: a run-path-only Inputs table is flagged', () => {
    const bad = [
      '| Source | Artifact | Used for |',
      '|---|---|---|',
      '| Phase 5 | `5-ocs/ocs-agent-setup.md` | experiment_id |',
      '| Phase 3 | read from run_state `phases.commcare-setup` | app ids |',
    ].join('\n');
    expect(isRunOnly(bad)).toBe(true);
  });

  it('positive controls: a Resolver column or a Pipeline-only line passes', () => {
    const withResolver = [
      '| Parameter | Used for | Resolver |',
      '|---|---|---|',
      '| `experiment_id` | the bot | explicit arg; default: `5-ocs/ocs-agent-setup.md` |',
    ].join('\n');
    const pipelineOnly =
      'Pipeline-only: grades the run Phase 3 summary.\n\n| Phase 3 | `3-commcare/x.md` | y |';
    expect(isRunOnly(withResolver)).toBe(false);
    expect(isRunOnly(pipelineOnly)).toBe(false);
  });

  it('no NEW skill has run-only Inputs', () => {
    const offenders = runOnlySkills().filter((s) => !LEDGER.has(s));
    expect(
      offenders.join('\n'),
      'These skills\' `## Inputs` cite only run artifacts. Per skills/README.md ' +
        '§ Mechanics vs pipeline, list parameters with a Resolver column so the ' +
        'skill can run on an existing object with explicit ids, or add a ' +
        '`Pipeline-only: <why>` line if it genuinely cannot.\n',
    ).toBe('');
  });

  it('the ledger is a debt to pay down: fixed skills must leave it', () => {
    const current = new Set(runOnlySkills());
    const stale = [...LEDGER].filter((s) => !current.has(s));
    expect(
      stale.join('\n'),
      'These ledgered skills now comply (or were removed): delete them from LEDGER.',
    ).toBe('');
  });
});
