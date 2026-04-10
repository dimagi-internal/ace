/**
 * Canonical artifact manifest for ACE opportunities.
 *
 * Every file that an ACE skill reads from or writes to Google Drive under
 * `ACE/<opp-name>/` is listed here. This module is the single source of truth
 * for:
 *   - What artifacts exist at each lifecycle phase
 *   - Which skill produces each artifact
 *   - Which skills consume each artifact
 *   - Whether an artifact is required or optional at phase completion
 *
 * Skills are SKILL.md prompt files and cannot import this module at runtime.
 * The manifest is used by:
 *   - Test fixture validation (does the fixture have the right files?)
 *   - Future ace:doctor checks on live opportunity Drive folders
 *   - Documentation generation
 *
 * To audit: grep -r 'ACE/<opp-name>' skills/ agents/
 */

// ── Types ──────────────────────────────────────────────────────────

export type Phase = 'build' | 'setup' | 'operate' | 'closeout';

export interface ArtifactEntry {
  /** Relative path under ACE/<opp-name>/, e.g. "idd.md" or "apps/learn-app.json" */
  path: string;
  /** Skill that creates this artifact (or "external" for human-provided inputs) */
  producedBy: string;
  /** Skills that read this artifact as input */
  consumedBy: string[];
  /** Lifecycle phase when this artifact is produced */
  phase: Phase;
  /** Must exist when this phase completes (false = conditional/optional) */
  required: boolean;
  /** Human-readable purpose */
  description: string;
}

// ── Phase ordering ─────────────────────────────────────────────────

export const PHASES = ['build', 'setup', 'operate', 'closeout'] as const;

// ── Manifest ───────────────────────────────────────────────────────

export const ARTIFACT_MANIFEST: readonly ArtifactEntry[] = [
  // ── Build phase ────────────────────────────────────────────────

  {
    path: 'idea.md',
    producedBy: 'external',
    consumedBy: ['idea-to-idd'],
    phase: 'build',
    required: true,
    description: 'Initial opportunity idea or brief',
  },
  {
    path: 'idd.md',
    producedBy: 'idea-to-idd',
    consumedBy: [
      'idd-to-learn-app', 'idd-to-deliver-app', 'app-test',
      'training-materials', 'connect-program-setup', 'connect-opp-setup',
      'llo-invite', 'ocs-agent-setup', 'timeline-monitor', 'flw-data-review',
      'cycle-grade', 'learnings-summary',
    ],
    phase: 'build',
    required: true,
    description: 'Intervention Design Document with archetype, Evidence Model, and stress-test appendix',
  },
  {
    path: 'state.yaml',
    producedBy: 'ace-orchestrator',
    consumedBy: ['timeline-monitor'],
    phase: 'build',
    required: true,
    description: 'Opportunity lifecycle state: phase, step, mode, gate approvals',
  },
  {
    path: 'apps/learn-app.json',
    producedBy: 'idd-to-learn-app',
    consumedBy: ['app-deploy'],
    phase: 'build',
    required: true,
    description: 'Learn app package (JSON or CCZ)',
  },
  {
    path: 'apps/deliver-app.json',
    producedBy: 'idd-to-deliver-app',
    consumedBy: ['app-deploy'],
    phase: 'build',
    required: true,
    description: 'Deliver app package (JSON or CCZ)',
  },
  {
    path: 'app-summaries/learn-app-summary.md',
    producedBy: 'idd-to-learn-app',
    consumedBy: ['app-test', 'training-materials', 'ocs-agent-setup', 'flw-data-review'],
    phase: 'build',
    required: true,
    description: 'Learn app structure summary for downstream skills',
  },
  {
    path: 'app-summaries/deliver-app-summary.md',
    producedBy: 'idd-to-deliver-app',
    consumedBy: ['app-test', 'training-materials', 'ocs-agent-setup', 'flw-data-review'],
    phase: 'build',
    required: true,
    description: 'Deliver app structure summary for downstream skills',
  },
  {
    path: 'deployment-summary.md',
    producedBy: 'app-deploy',
    consumedBy: ['app-test', 'connect-opp-setup', 'llo-uat', 'llo-launch'],
    phase: 'build',
    required: true,
    description: 'App deployment details: IDs, URLs, build status',
  },
  {
    path: 'test-results/test-plan.md',
    producedBy: 'app-test',
    consumedBy: ['learnings-summary', 'cycle-grade'],
    phase: 'build',
    required: true,
    description: 'Full test plan with Evidence Model cross-references',
  },
  {
    path: 'test-results/test-results.md',
    producedBy: 'app-test',
    consumedBy: ['learnings-summary', 'cycle-grade'],
    phase: 'build',
    required: true,
    description: 'Test execution results: pass/fail per test case',
  },
  {
    path: 'test-results/bugs.md',
    producedBy: 'app-test',
    consumedBy: ['learnings-summary', 'cycle-grade'],
    phase: 'build',
    required: true,
    description: 'Bugs found during testing with severity and repro steps',
  },
  {
    path: 'training-materials/llo-manager-guide.md',
    producedBy: 'training-materials',
    consumedBy: ['llo-onboarding', 'ocs-agent-setup'],
    phase: 'build',
    required: true,
    description: 'LLO Manager guide for overseeing FLW deployment',
  },
  {
    path: 'training-materials/flw-training-guide.md',
    producedBy: 'training-materials',
    consumedBy: ['llo-onboarding', 'ocs-agent-setup'],
    phase: 'build',
    required: true,
    description: 'FLW training guide for app usage and protocols',
  },
  {
    path: 'training-materials/quick-reference.md',
    producedBy: 'training-materials',
    consumedBy: ['llo-onboarding', 'ocs-agent-setup'],
    phase: 'build',
    required: true,
    description: 'Quick reference card for FLWs in the field',
  },
  {
    path: 'training-materials/faq.md',
    producedBy: 'training-materials',
    consumedBy: ['llo-onboarding', 'ocs-agent-setup'],
    phase: 'build',
    required: true,
    description: 'Frequently asked questions for LLOs and FLWs',
  },

  // ── Setup phase ────────────────────────────────────────────────

  {
    path: 'connect-setup/program.md',
    producedBy: 'connect-program-setup',
    consumedBy: ['connect-opp-setup'],
    phase: 'setup',
    required: true,
    description: 'Connect Program ID, name, config details',
  },
  {
    path: 'connect-setup/opportunity.md',
    producedBy: 'connect-opp-setup',
    consumedBy: ['llo-invite', 'llo-onboarding', 'llo-uat', 'llo-launch', 'ocs-agent-setup', 'opp-closeout'],
    phase: 'setup',
    required: true,
    description: 'Connect Opportunity ID, verification rules, delivery/payment unit config',
  },
  {
    path: 'connect-setup/invites.md',
    producedBy: 'llo-invite',
    consumedBy: ['llo-onboarding', 'llo-uat', 'llo-launch', 'llo-feedback'],
    phase: 'setup',
    required: true,
    description: 'LLO invite log with contacts, rationale, and status',
  },

  // ── Operate phase ──────────────────────────────────────────────

  {
    path: 'comms-log/onboarding-emails.md',
    producedBy: 'llo-onboarding',
    consumedBy: ['learnings-summary'],
    phase: 'operate',
    required: true,
    description: 'Onboarding email records with recipients, subject, body, timestamp',
  },
  {
    path: 'uat/uat-results.md',
    producedBy: 'llo-uat',
    consumedBy: ['llo-launch'],
    phase: 'operate',
    required: true,
    description: 'Per-LLO sign-off status, issues found, overall UAT verdict',
  },
  {
    path: 'launch/launch-record.md',
    producedBy: 'llo-launch',
    consumedBy: ['timeline-monitor'],
    phase: 'operate',
    required: true,
    description: 'Activation timestamp, LLO notifications, app URLs, outstanding issues',
  },
  {
    path: 'ocs-agent-config.md',
    producedBy: 'ocs-agent-setup',
    consumedBy: ['ocs-chatbot-qa', 'timeline-monitor', 'flw-data-review'],
    phase: 'operate',
    required: true,
    description: 'OCS chatbot config: experiment_id, public_id, embed_key, collection_id',
  },
  {
    path: 'qa-reports/YYYY-MM-DD-ocs-qa.md',
    producedBy: 'ocs-chatbot-qa',
    consumedBy: [],
    phase: 'operate',
    required: false,
    description: 'OCS chatbot quality report from LLM-as-Judge evaluation',
  },
  {
    path: 'monitoring/YYYY-MM-DD-timeline-check.md',
    producedBy: 'timeline-monitor',
    consumedBy: ['learnings-summary', 'cycle-grade'],
    phase: 'operate',
    required: false,
    description: 'Weekly timeline status, progress indicators, prompting email drafts',
  },
  {
    path: 'data-reviews/YYYY-MM-DD-review.md',
    producedBy: 'flw-data-review',
    consumedBy: ['learnings-summary', 'cycle-grade'],
    phase: 'operate',
    required: false,
    description: 'FLW data quality assessment: per-delivery (Layer B) and cross-delivery (Layer C)',
  },

  // ── Closeout phase ─────────────────────────────────────────────

  {
    path: 'closeout/invoices.md',
    producedBy: 'opp-closeout',
    consumedBy: [],
    phase: 'closeout',
    required: true,
    description: 'Invoice details, total payment amount, Jira ticket link',
  },
  {
    path: 'closeout/llo-feedback.md',
    producedBy: 'llo-feedback',
    consumedBy: ['learnings-summary', 'cycle-grade'],
    phase: 'closeout',
    required: true,
    description: 'Per-LLO feedback responses, common themes, improvement suggestions',
  },
  {
    path: 'closeout/learnings.md',
    producedBy: 'learnings-summary',
    consumedBy: ['cycle-grade'],
    phase: 'closeout',
    required: true,
    description: 'Process/content/technical/relationship learnings against original IDD',
  },
  {
    path: 'closeout/new-idd.md',
    producedBy: 'learnings-summary',
    consumedBy: [],
    phase: 'closeout',
    required: false,
    description: 'New IDD incorporating learnings (only if iteration warranted)',
  },
  {
    path: 'closeout/cycle-grade.md',
    producedBy: 'cycle-grade',
    consumedBy: [],
    phase: 'closeout',
    required: true,
    description: '6/7-dimension grades with evidence, recommendations, narrative assessment',
  },
] as const;

// ── Helpers ────────────────────────────────────────────────────────

/** Return artifacts produced in (or before) the given phase. */
export function artifactsForPhase(phase: Phase): ArtifactEntry[] {
  const idx = PHASES.indexOf(phase);
  return ARTIFACT_MANIFEST.filter((a) => PHASES.indexOf(a.phase) <= idx);
}

/** Return artifacts a specific skill writes. */
export function artifactsProducedBy(skill: string): ArtifactEntry[] {
  return ARTIFACT_MANIFEST.filter((a) => a.producedBy === skill);
}

/** Return artifacts a specific skill reads. */
export function artifactsConsumedBy(skill: string): ArtifactEntry[] {
  return ARTIFACT_MANIFEST.filter((a) => a.consumedBy.includes(skill));
}

/**
 * Validate a set of file paths against the manifest up to a given phase.
 *
 * @param filePaths - actual file paths relative to the opp root (e.g. from listing a fixture or Drive folder)
 * @param upToPhase - include artifacts from phases up to and including this one
 * @param exempt - paths to ignore (e.g. "README.md")
 * @returns present, missing (required but absent), and unexpected (not in manifest) paths
 */
export function validateFixture(
  filePaths: string[],
  upToPhase: Phase,
  exempt: string[] = [],
): { present: string[]; missing: string[]; unexpected: string[] } {
  const expected = artifactsForPhase(upToPhase);
  // Only check required, non-dated artifacts (YYYY-MM-DD patterns are recurring/optional)
  const requiredPaths = expected
    .filter((a) => a.required && !a.path.includes('YYYY-MM-DD'))
    .map((a) => a.path);

  const knownPaths = new Set(
    expected.map((a) => a.path),
  );

  const present: string[] = [];
  const unexpected: string[] = [];

  for (const fp of filePaths) {
    if (exempt.includes(fp)) continue;
    if (knownPaths.has(fp)) {
      present.push(fp);
    } else {
      unexpected.push(fp);
    }
  }

  const presentSet = new Set(present);
  const missing = requiredPaths.filter((p) => !presentSet.has(p));

  return { present, missing, unexpected };
}
