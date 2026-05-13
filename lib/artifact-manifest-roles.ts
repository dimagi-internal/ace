/**
 * Phase folder name lookup and the closed role-suffix vocabulary used by
 * the (0.13.0) phase-prefixed _role artifact filename convention.
 *
 * Lives in its own module so:
 *   - the manifest itself can import the types without a circular dep,
 *   - lint tests have a single source of truth for the closed vocabulary,
 *   - downstream tooling (the migrator, the doctor's [Drive layout]
 *     section's future expansion, the orchestrator's per-phase folder
 *     creation) all reference one place.
 *
 * See docs/superpowers/specs/2026-05-03-run-folder-readability-design.md
 * § Naming rule (one convention everywhere) for the why.
 *
 * 0.13.0: Renumbered to 8 phases when 0.12.0 introduced
 * `solicitation-management` at Phase 7. Old `llo-manager` (was
 * Phase 7) was renamed to `execution-management` and `closeout` moved
 * from Phase 7 to Phase 8.
 *
 * 0.13.x: Phase 1 (design-review) split into idea-to-design
 * (Phase 1) and scenarios-and-acceptance (Phase 2). All downstream
 * ordinals shifted +1 (commcare 2→3 ... closeout 9→10). Folder
 * prefixes follow: `1-design` stayed; new `2-scenarios` added;
 * `2-commcare` → `3-commcare`, etc.
 */

/** Phase enum → folder slug used in Drive paths under runs/<run-id>/. */
export const PHASE_FOLDERS = {
  'design': '1-design',
  'scenarios-and-acceptance': '2-scenarios',
  'commcare': '3-commcare',
  'connect': '4-connect',
  'ocs': '5-ocs',
  'qa-and-training': '6-qa-and-training',
  'synthetic-data-and-workflows': '7-synthetic',
  'solicitation-management': '8-solicitation-management',
  'execution-management': '9-execution-manager',
  'closeout': '10-closeout',
} as const;

export type PhaseFolder = typeof PHASE_FOLDERS[keyof typeof PHASE_FOLDERS];

/**
 * Closed vocabulary for the optional `_<role>` slot in artifact filenames.
 * Variants append a hyphenated qualifier (e.g. `verdict-deep`, `verdict-quick`,
 * `transcript-monitor`); only the base role needs to be in this set.
 *
 * Add a new role here when the manifest declares an artifact whose role
 * isn't covered. The lint test in test/lib/artifact-manifest-lint.test.ts
 * enforces that every manifest `role` resolves to a base in this set.
 */
export const ROLE_VOCAB = new Set<string>([
  'summary',
  // 'gate-brief' role retired in 0.13.116; per-skill QA + eval verdicts replace it.
  // Kept as a multi-word base below to keep historical migrator tests passing.
  'verdict',
  'qa-result',  // for <producer>-qa_result.yaml — binary structural QA output (PR #146 / 0.13.88)
  'report',
  'transcript',
  'scorecard',
  'manifest',
  'list',
  'record',
  'comms-log',
  'results',
  'new-pdd',
  'invoices',
  'widget-handoff',
  'learn',     // for app-connect-coverage_learn.md
  'deliver',   // for app-connect-coverage_deliver.md
  'snapshot',  // for pdd-to-{learn,deliver}-app_snapshot.json (Nova-app structure snapshots)
  'dry-run-log',         // for ocs-agent-setup_dry-run-log.md
  'screenshot-manifest', // (legacy, qa-plan retired in 0.11.10) — kept for migrator
  'test-matrix',         // (legacy, qa-plan retired in 0.11.10) — kept for migrator
  'uat-checklist',       // (legacy, qa-plan retired in 0.11.10) — kept for migrator
  'draft',               // for solicitation-create_draft.md
  'published',           // for solicitation-create_published.md
  'invitations',         // for llo-invite_invitations.md
  'responses',           // for solicitation-monitor_responses.md (folder-as-role placeholder)
  'scoring-rubric',      // for solicitation-review_scoring-rubric.md
  'recommendation',      // for solicitation-review_recommendation.md
  'award-record',        // for solicitation-review_award-record.md
  'expected-journeys',   // for pdd-to-app-journeys_expected-journeys.md
  'app-test-cases',      // for app-test-cases.yaml
]);

/**
 * Multi-word base roles (kebab-case) that must be matched intact rather
 * than truncated at the first hyphen. Listed here so `baseRole()` doesn't
 * mis-extract `gate` from `gate-brief-deep` (real base: `gate-brief`).
 */
const MULTI_WORD_BASES = new Set([
  'gate-brief',
  'qa-result',
  'comms-log',
  'new-pdd',
  'widget-handoff',
  'dry-run-log',
  'screenshot-manifest',
  'test-matrix',
  'uat-checklist',
  'scoring-rubric',
  'award-record',
  'expected-journeys',
  'app-test-cases',
]);

/**
 * Extract the base role from `<role>[-<qualifier>]`.
 * Examples: `summary` → `summary`, `verdict-deep` → `verdict`,
 * `gate-brief` → `gate-brief`, `gate-brief-deep` → `gate-brief`.
 */
export function baseRole(role: string): string {
  for (const base of MULTI_WORD_BASES) {
    if (role === base || role.startsWith(base + '-')) return base;
  }
  return role.split('-')[0];
}
