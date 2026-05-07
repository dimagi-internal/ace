/**
 * Canonical artifact manifest for ACE opportunities.
 *
 * Every file that an ACE skill reads from or writes to Google Drive under
 * `ACE/<opp>/runs/<run-id>/` is listed here. A handful of opp-level files
 * (`opp.yaml`, the `inputs/` folder, plus `connect-state.yaml`,
 * `open-questions.md`, and `eval-calibration/known-issues.md`) sit at
 * `ACE/<opp>/` itself, one level above the run folder; they survive
 * across runs and are flagged with `phase: 'design'` for sort order.
 *
 * This module is the single source of truth for:
 *   - What artifacts exist at each lifecycle phase
 *   - Which skill produces each artifact
 *   - Which skills consume each artifact
 *   - Whether an artifact is required or optional at phase completion
 *
 * Skills are SKILL.md prompt files and cannot import this module at runtime.
 * The manifest is used by:
 *   - Test fixture validation (does the fixture have the right files?)
 *   - ace:doctor checks on live opportunity Drive folders
 *   - Documentation generation
 *   - ace-web's structured-layout reader (apps/opps/sync.py)
 *
 * Path convention (0.13.0+): per-run artifacts live under
 * `<N>-<phase>/<skill>[_<role>].<ext>` where `N-phase` matches
 * `PHASE_FOLDERS` in `lib/artifact-manifest-roles.ts` and `<role>` is
 * an entry in `ROLE_VOCAB` (or omitted when one skill emits one file).
 *
 * 0.13.0: Renumbered to 8 phases when 0.12.0 introduced
 * `solicitation-management` (Phase 6). Old `llo-manager` (Phase 6) is
 * now `execution-management` (Phase 7); `closeout` moved 7 → 8.
 *
 * To audit: grep -r 'ACE/<opp>/runs/' skills/ agents/
 */

// ── Types ──────────────────────────────────────────────────────────

export type Phase =
  | 'design'
  | 'commcare'
  | 'connect'
  | 'ocs'
  | 'qa-and-training'
  | 'synthetic-data-and-workflows'
  | 'solicitation-management'
  | 'execution-management'
  | 'closeout';

export interface ArtifactEntry {
  /** Relative path under ACE/<opp-name>/, e.g. "1-design/idea-to-pdd.md" */
  path: string;
  /** Skill (or agent) that creates this artifact (or "external" for human-provided inputs) */
  producedBy: string;
  /** Optional role suffix when one skill emits multiple artifacts.
   *  Vocabulary in lib/artifact-manifest-roles.ts.
   */
  role?: string;
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

export const PHASES = [
  'design',
  'commcare',
  'connect',
  'ocs',
  'qa-and-training',
  'synthetic-data-and-workflows',
  'solicitation-management',
  'execution-management',
  'closeout',
] as const;

// ── Manifest ───────────────────────────────────────────────────────

export const ARTIFACT_MANIFEST: readonly ArtifactEntry[] = [
  // ── Opp-level artifacts (NOT under runs/<run-id>/) ─────────────

  {
    path: 'inputs/',
    producedBy: 'external',
    consumedBy: ['ace-orchestrator', 'idea-to-pdd'],
    phase: 'design',
    required: true,
    description: 'Human-curated evidence pack for the opp — any combination of source docs, SOPs, questionnaires, spreadsheets, prior-pass drafts, or notes. No required filename. The orchestrator captures a frozen pointer-set as 1-design/inputs-manifest.yaml at run start; idea-to-pdd reads each manifest entry to synthesize the PDD.',
  },
  {
    path: 'opp.yaml',
    producedBy: 'ace-orchestrator',
    consumedBy: ['ace-orchestrator', 'llo-onboarding', 'solicitation-review'],
    phase: 'design',
    required: false,
    description: 'Opp-level metadata: display_name, slug, last_run_id, tags, created_at, created_by, plus selected_llo (populated by solicitation-review at the Phase 6→7 boundary; read by llo-onboarding to identify the awardee). Created lazily on the first run; updated on every run to bump last_run_id.',
  },
  {
    path: 'connect-state.yaml',
    producedBy: 'connect-opp-setup',
    consumedBy: ['llo-launch', 'llo-uat', 'app-screenshot-capture'],
    phase: 'design',
    required: false,
    description: 'Cross-run Connect state: program UUID, opportunity UUID, ACE-test-user invite URL. Written by connect-opp-setup (Phase 3); read by Phase 5/7 skills that need to drive activation, UAT, or the emulator-driven test-user claim flow without knowing which run created the opp. Opp-level (NOT under runs/<run-id>/) so subsequent runs reuse the same Connect entities.',
  },
  {
    path: 'open-questions.md',
    producedBy: 'idea-to-pdd',
    consumedBy: ['ace-orchestrator'],
    phase: 'design',
    required: false,
    description: 'Per-opp deferred-question doc. Written by idea-to-pdd when stress-test grades partial/fail and a default reasonable-pick is taken; phase agents append unresolved questions here at end-of-run for human review (per the feedback_phase_open_questions user-memory item). Opp-level (NOT under runs/<run-id>/) so questions survive across runs until answered.',
  },
  {
    path: 'eval-calibration/known-issues.md',
    producedBy: 'eval-calibration',
    consumedBy: [
      'app-release-eval', 'connect-program-setup-eval', 'cycle-grade-eval',
      'flw-data-review-eval', 'idea-to-pdd-eval', 'llo-launch-eval',
      'ocs-chatbot-eval', 'ocs-widget-handoff-eval',
      'pdd-to-deliver-app-eval', 'pdd-to-learn-app-eval',
      'solicitation-create-eval', 'solicitation-review-eval',
    ],
    phase: 'design',
    required: false,
    description: 'Per-opp ground-truth catalogue: the deliberately-injected defects each -eval rubric is calibrated to detect. Read by every -eval skill at grade time. Opp-level audit trail — survives across runs.',
  },

  // ── Design phase (Phase 1) ─────────────────────────────────────

  {
    path: 'inputs-manifest.yaml',
    producedBy: 'ace-orchestrator',
    consumedBy: ['idea-to-pdd'],
    phase: 'design',
    required: false,
    description: 'Frozen pointer-set captured at run start: every direct child file under inputs/ as {file_id, name, mime_type}. idea-to-pdd reads each entry to synthesize the PDD. Lives at the run-folder root alongside run_state.yaml — both are run-level metadata, scoped beyond any single phase. Pointing at file_ids (not paths) means a human re-arranging inputs/ mid-run does not shift the source pack out from under Phase 1. NOT YET required: existing fixtures predate the 2026-05-05 evidence-pack refactor; flip to required=true once the next round of fixture updates lands.',
  },
  {
    path: 'idea.md',
    producedBy: 'external',
    consumedBy: ['idea-to-pdd'],
    phase: 'design',
    required: false,
    description: 'Optional operator-supplied free-text seed at the run-folder root. Only present when /ace:run was invoked with --idea FILE|-. Read by idea-to-pdd alongside the inputs-manifest. Most runs do not have this file — the inputs/ evidence pack is sufficient.',
  },
  {
    path: '1-design/idea.md',
    producedBy: 'external',
    consumedBy: ['idea-to-pdd'],
    phase: 'design',
    required: false,
    description: 'Legacy path — pre-2026-05-05 the orchestrator copied inputs/pdd.md into 1-design/idea.md as the seed for idea-to-pdd. New runs do not write this file (the manifest at 1-design/inputs-manifest.yaml replaces it; --idea seeds the run-root idea.md). Kept in the manifest so older fixtures and resumed legacy runs validate cleanly.',
  },
  {
    path: '1-design/idea-to-pdd.md',
    producedBy: 'idea-to-pdd',
    consumedBy: [
      'pdd-to-test-prompts', 'pdd-to-app-journeys',
      'pdd-to-learn-app', 'pdd-to-deliver-app',
      'app-test-cases', 'app-ux-eval',
      'training-llo-guide', 'training-flw-guide', 'training-quick-reference',
      'training-faq', 'training-onboarding-email', 'training-deck-outline',
      'connect-program-setup', 'connect-opp-setup',
      'solicitation-create', 'llo-invite',
      'ocs-agent-setup', 'timeline-monitor', 'flw-data-review',
      'cycle-grade', 'learnings-summary',
    ],
    phase: 'design',
    required: true,
    description: 'Program Design Document with archetype, Evidence Model, Solicitation block, and stress-test appendix (the canonical pdd.md, renamed to match its producer)',
  },
  {
    path: '1-design/pdd-to-test-prompts.md',
    producedBy: 'pdd-to-test-prompts',
    consumedBy: ['ocs-chatbot-qa'],
    phase: 'design',
    required: true,
    description: 'Opp-specific Q&A pairs derived from the PDD; each entry has an expected-answer summary that ocs-chatbot-qa embeds in the transcript and ocs-chatbot-eval grades against',
  },
  {
    path: '1-design/pdd-to-app-journeys.md',
    producedBy: 'pdd-to-app-journeys',
    consumedBy: ['app-test-cases', 'app-ux-eval', 'app-screenshot-capture'],
    phase: 'design',
    required: true,
    description: 'PDD-derived user journeys + UX edge cases. Ground truth for app-test-cases (Phase 2) and app-ux-eval (deep). Each journey carries a goal, happy-path narrative, edge cases phrased as UX outcomes, and pass criteria.',
  },
  {
    path: 'run_state.yaml',
    producedBy: 'ace-orchestrator',
    consumedBy: ['timeline-monitor'],
    phase: 'design',
    required: true,
    description: 'Per-run lifecycle state: phase, step, mode, gate approvals, initiated_by / last_actor / last_actor_at. Lives at `runs/<run-id>/run_state.yaml` (renamed from `state.yaml` in 0.11.3 to make per-run scope explicit).',
  },
  {
    path: '1-design/idea-to-pdd_gate-brief.md',
    producedBy: 'idea-to-pdd',
    role: 'gate-brief',
    consumedBy: ['ace-orchestrator'],
    phase: 'design',
    required: true,
    description: 'Gate brief for the Phase 1→2 gate: checklist + stress-test concerns for the PDD',
  },
  {
    path: '1-design/idea-to-pdd-eval_verdict.yaml',
    producedBy: 'idea-to-pdd-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'design',
    required: false,
    description: 'Per-skill -eval verdict for idea-to-pdd: structural completeness, archetype coherence, concreteness, reviewer-comment fidelity, stress-test agreement. Shape matches skills/README.md § QA vs Eval.',
  },
  {
    path: '1-design/design-review_summary.md',
    producedBy: 'design-review',
    role: 'summary',
    consumedBy: [],
    phase: 'design',
    required: true,
    description: 'Phase 1 (design-review) end-of-phase summary written by the design-review subagent. Captures the agreed PDD highlights and gate disposition handed back to the orchestrator.',
  },

  // ── CommCare phase (Phase 2) ───────────────────────────────────

  {
    path: '2-commcare/pdd-to-learn-app_snapshot.json',
    producedBy: 'pdd-to-learn-app',
    role: 'snapshot',
    consumedBy: [],
    phase: 'commcare',
    required: false,
    description: 'Optional historical snapshot of the Learn app structure (output of `/nova:show <id>`). Not required: Nova is the system of record for the app, and the canonical handle is `nova_app_id` in the summary frontmatter (see 2026-04-27 Nova-plugin migration note).',
  },
  {
    path: '2-commcare/pdd-to-deliver-app_snapshot.json',
    producedBy: 'pdd-to-deliver-app',
    role: 'snapshot',
    consumedBy: [],
    phase: 'commcare',
    required: false,
    description: 'Optional historical snapshot of the Deliver app structure (output of `/nova:show <id>`). Not required — see Learn equivalent above.',
  },
  {
    path: '2-commcare/pdd-to-learn-app_summary.md',
    producedBy: 'pdd-to-learn-app',
    role: 'summary',
    consumedBy: [
      'app-deploy', 'app-test-cases', 'app-ux-eval',
      'training-llo-guide', 'training-flw-guide', 'training-quick-reference',
      'training-faq', 'training-deck-outline',
      'ocs-agent-setup', 'flw-data-review',
    ],
    phase: 'commcare',
    required: true,
    description: 'Learn app structure summary for downstream skills. Required frontmatter: `nova_app_id`, `nova_app_url`, `archetype`. `app-deploy` reads `nova_app_id` from here to feed `/nova:upload_to_hq`.',
  },
  {
    path: '2-commcare/pdd-to-deliver-app_summary.md',
    producedBy: 'pdd-to-deliver-app',
    role: 'summary',
    consumedBy: [
      'app-deploy', 'app-test-cases', 'app-ux-eval',
      'training-llo-guide', 'training-flw-guide', 'training-quick-reference',
      'training-faq', 'training-deck-outline',
      'ocs-agent-setup', 'flw-data-review',
    ],
    phase: 'commcare',
    required: true,
    description: 'Deliver app structure summary for downstream skills. Required frontmatter: `nova_app_id`, `nova_app_url`, `archetype`, `delivery_unit`. `app-deploy` reads `nova_app_id` from here.',
  },
  {
    path: '2-commcare/app-deploy_summary.md',
    producedBy: 'app-deploy',
    role: 'summary',
    consumedBy: ['connect-opp-setup', 'llo-uat', 'llo-launch'],
    phase: 'commcare',
    required: true,
    description: 'App deployment details: IDs, URLs, build status',
  },
  {
    path: '2-commcare/app-test-cases.yaml',
    producedBy: 'app-test-cases',
    consumedBy: ['app-screenshot-capture', 'app-ux-eval'],
    phase: 'commcare',
    required: true,
    description: 'Bindings of pdd-to-app-journeys.md to Phase-2-built app structure: per-journey form/field IDs, Maestro recipe paths, smoke flags, structural pass criteria. Phase 5 shallow uses is_smoke: true entries; /ace:qa-deep uses all entries.',
  },
  {
    path: '2-commcare/app-deploy_gate-brief.md',
    producedBy: 'app-deploy',
    role: 'gate-brief',
    consumedBy: ['ace-orchestrator'],
    phase: 'commcare',
    required: true,
    description: 'Gate brief for the Phase 2→3 gate: build status, Connectify flags, and an HQ-domain-mismatch BLOCKER if Nova is bound to the wrong project space',
  },
  {
    path: '2-commcare/pdd-to-learn-app-eval_verdict.yaml',
    producedBy: 'pdd-to-learn-app-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'commcare',
    required: false,
    description: 'Per-skill -eval verdict for pdd-to-learn-app: module count, order, Connectify Assessment Score wiring, gating thresholds, content coverage match against the PDD.',
  },
  {
    path: '2-commcare/pdd-to-deliver-app-eval_verdict.yaml',
    producedBy: 'pdd-to-deliver-app-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'commcare',
    required: false,
    description: 'Per-skill -eval verdict for pdd-to-deliver-app: field count, ordering, conditional logic, Connectify wiring, required-field rules match against the PDD.',
  },
  {
    path: '2-commcare/app-release-eval_verdict.yaml',
    producedBy: 'app-release-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'commcare',
    required: false,
    description: 'Per-skill -eval verdict for app-release: every uploaded build successfully released, CCZ-marker checks passed, no draft-only apps remain.',
  },
  {
    path: '2-commcare/commcare-setup_summary.md',
    producedBy: 'commcare-setup',
    role: 'summary',
    consumedBy: [],
    phase: 'commcare',
    required: true,
    description: 'Phase 2 (commcare-setup) end-of-phase summary written by the commcare-setup procedure-doc agent. Captures app IDs, deploy/release status, and gate disposition handed back to the orchestrator.',
  },

  // ── Connect phase (Phase 3) ────────────────────────────────────

  {
    path: '3-connect/connect-program-setup.md',
    producedBy: 'connect-program-setup',
    consumedBy: ['connect-opp-setup'],
    phase: 'connect',
    required: true,
    description: 'Connect Program ID, name, config details',
  },
  {
    path: '3-connect/connect-opp-setup.md',
    producedBy: 'connect-opp-setup',
    consumedBy: ['llo-onboarding', 'llo-uat', 'llo-launch', 'ocs-agent-setup', 'opp-closeout'],
    phase: 'connect',
    required: true,
    description: 'Connect Opportunity ID, verification rules, delivery/payment unit config',
  },
  {
    path: '3-connect/connect-program-setup-eval_verdict.yaml',
    producedBy: 'connect-program-setup-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'connect',
    required: false,
    description: 'Per-skill -eval verdict for the Connect program/opportunity setup: program-fit decision (reuse vs create), opportunity verification rules, delivery units, payment units, entity-id wiring against PDD spec.',
  },
  {
    path: '3-connect/connect-setup_summary.md',
    producedBy: 'connect-setup',
    role: 'summary',
    consumedBy: ['app-release-eval', 'connect-program-setup-eval', 'llo-launch-eval'],
    phase: 'connect',
    required: true,
    description: 'Phase 3 (connect-setup) end-of-phase summary written by the connect-setup subagent. Captures program/opp IDs, payment-unit config, and gate disposition. Read by 3 downstream -eval skills as ground truth for grading.',
  },

  // ── OCS phase (Phase 4) ────────────────────────────────────────

  {
    path: '4-ocs/ocs-agent-setup.md',
    producedBy: 'ocs-agent-setup',
    consumedBy: ['ocs-chatbot-qa', 'ocs-chatbot-eval', 'llo-onboarding', 'timeline-monitor', 'flw-data-review'],
    phase: 'ocs',
    required: true,
    description: 'OCS chatbot config: experiment_id, public_id, embed_key, collection_id',
  },
  {
    path: '4-ocs/ocs-setup_widget-handoff.md',
    producedBy: 'ocs-setup',
    role: 'widget-handoff',
    consumedBy: ['llo-onboarding', 'ocs-widget-handoff-eval'],
    phase: 'ocs',
    required: true,
    description: 'Operator-facing handoff doc: creds + paste instructions for the Connect opportunity widget (until update_opportunity API lands)',
  },
  {
    path: '4-ocs/ocs-chatbot-qa_transcript-quick.md',
    producedBy: 'ocs-chatbot-qa',
    role: 'transcript',
    consumedBy: ['ocs-chatbot-eval'],
    phase: 'ocs',
    required: false,
    description: 'Transcript from the --quick suite (3 smoke prompts): each entry has prompt + response + cited_files + expected_answer_summary + structural-pass flag. Input to ocs-chatbot-eval --quick',
  },
  {
    path: '4-ocs/ocs-chatbot-qa_transcript-deep.md',
    producedBy: 'ocs-chatbot-qa',
    role: 'transcript',
    consumedBy: ['ocs-chatbot-eval'],
    phase: 'ocs',
    required: false,
    description: 'Transcript from the --deep suite (Connect-general + ACE-specific + opp-specific + edge cases): structured transcript input to ocs-chatbot-eval --deep. Required to be fresh and passing for go-live; absent if /ace:qa-deep has not been run.',
  },
  {
    path: '4-ocs/ocs-chatbot-eval_verdict-quick.yaml',
    producedBy: 'ocs-chatbot-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'ocs',
    required: false,
    description: 'Machine-readable verdict from --quick LLM-as-Judge grading: overall_score, per-dimension scores, per-prompt verdicts, gate disposition. Shape matches skills/README.md § QA vs Eval',
  },
  {
    path: '4-ocs/ocs-chatbot-eval_verdict-deep.yaml',
    producedBy: 'ocs-chatbot-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'ocs',
    required: false,
    description: 'Machine-readable verdict from --deep LLM-as-Judge grading; read by opp-eval for cross-skill aggregation. Required to be fresh and passing for go-live; absent if /ace:qa-deep has not been run.',
  },
  {
    path: '4-ocs/ocs-chatbot-eval_gate-brief-quick.md',
    producedBy: 'ocs-chatbot-eval',
    role: 'gate-brief',
    consumedBy: ['ace-orchestrator'],
    phase: 'ocs',
    required: true,
    description: 'Gate brief for the Phase 4→5 gate (post-Task-6 shallow gate): scorecard from --quick eval (3 prompts × 1 dim), pass/fail verdict, single auto-surfaced concern if any prompt < 2/3.',
  },
  {
    path: '4-ocs/ocs-chatbot-eval_gate-brief-deep.md',
    producedBy: 'ocs-chatbot-eval',
    role: 'gate-brief',
    consumedBy: ['ace-orchestrator'],
    phase: 'ocs',
    required: false,
    description: 'Gate brief for the deep-eval activation gate: scorecard, failing prompts, dimension weak spots. Required to be fresh and passing for go-live; absent if /ace:qa-deep has not been run.',
  },
  {
    path: '4-ocs/ocs-chatbot-eval_report-deep.md',
    producedBy: 'ocs-chatbot-eval',
    role: 'report',
    consumedBy: [],
    phase: 'ocs',
    required: false,
    description: 'Human-readable eval report from the Phase 4 --deep gate. Complements the machine-readable verdict YAML.',
  },
  {
    path: '4-ocs/ocs-widget-handoff-eval_verdict.yaml',
    producedBy: 'ocs-widget-handoff-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'ocs',
    required: false,
    description: 'Per-skill -eval verdict for ocs-widget-handoff: widget URL correctness, embed key staging, opportunity-binding completeness, HITL operator handoff hygiene. Filename uses the eval skill (ocs-widget-handoff-eval) rather than the agent name (ocs-agent-setup) — see 0.12.0 Option-α naming rule.',
  },
  {
    path: '4-ocs/ocs-agent-setup_dry-run-log.md',
    producedBy: 'ocs-agent-setup',
    role: 'dry-run-log',
    consumedBy: [],
    phase: 'ocs',
    required: false,
    description: 'Log of every MCP atom call ocs-agent-setup would issue when invoked with --dry-run. Companion to ocs-agent-setup.md from real runs; surfaced for operator review before a live run.',
  },
  {
    path: '4-ocs/ocs-setup_summary.md',
    producedBy: 'ocs-setup',
    role: 'summary',
    consumedBy: [],
    phase: 'ocs',
    required: true,
    description: 'Phase 4 (ocs-setup) end-of-phase summary written by the ocs-setup subagent. Captures chatbot config (experiment_id, embed key), publish status, and gate disposition handed back to the orchestrator.',
  },

  // ── QA + Training phase (Phase 5) ──────────────────────────────

  {
    path: '5-qa-and-training/app-screenshot-capture_manifest.yaml',
    producedBy: 'app-screenshot-capture',
    role: 'manifest',
    consumedBy: ['training-flw-guide', 'training-deck-outline', 'app-ux-eval'],
    phase: 'qa-and-training',
    required: false,
    description: 'Manifest of every captured screenshot with step labels and Drive paths.',
  },
  {
    path: '5-qa-and-training/app-screenshot-capture_verdict-shallow.yaml',
    producedBy: 'app-screenshot-capture',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'qa-and-training',
    required: true,
    description: 'Shallow smoke verdict from /ace:run Phase 5 — smoke recipe pass/fail + thin UX judge ≥ 2/3 per app. Always present after a successful /ace:run.',
  },
  {
    path: '5-qa-and-training/app-screenshot-capture_verdict.yaml',
    producedBy: 'app-screenshot-capture',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'qa-and-training',
    required: true,
    description: 'Structural verdict from app-screenshot-capture: smoke recipe pass/fail status + screenshot capture integrity. Always present after a successful Phase 5 run.',
  },
  {
    path: '5-qa-and-training/app-ux-eval_verdict-deep.yaml',
    producedBy: 'app-ux-eval',
    role: 'verdict',
    consumedBy: ['llo-launch', 'opp-eval'],
    phase: 'qa-and-training',
    required: false,
    description: 'Machine-readable verdict from app-ux-eval (deep). Read by llo-launch (Phase 7 activation gate) for freshness check vs. latest released CommCare build, and by opp-eval for cross-skill aggregation. Required to be fresh and passing for go-live; absent if /ace:qa-deep has not been run.',
  },
  {
    path: '5-qa-and-training/training-llo-guide.md',
    producedBy: 'training-llo-guide',
    consumedBy: ['llo-onboarding', 'ocs-agent-setup', 'training-onboarding-email'],
    phase: 'qa-and-training',
    required: true,
    description: 'LLO Manager guide for overseeing FLW deployment',
  },
  {
    path: '5-qa-and-training/training-flw-guide.md',
    producedBy: 'training-flw-guide',
    consumedBy: ['llo-onboarding', 'ocs-agent-setup', 'training-onboarding-email'],
    phase: 'qa-and-training',
    required: true,
    description: 'Step-by-step FLW training guide for app usage and protocols',
  },
  {
    path: '5-qa-and-training/training-quick-reference.md',
    producedBy: 'training-quick-reference',
    consumedBy: ['llo-onboarding', 'ocs-agent-setup', 'training-onboarding-email'],
    phase: 'qa-and-training',
    required: true,
    description: 'One-page laminated pocket card for FLWs in the field',
  },
  {
    path: '5-qa-and-training/training-faq.md',
    producedBy: 'training-faq',
    consumedBy: ['llo-onboarding', 'ocs-agent-setup'],
    phase: 'qa-and-training',
    required: true,
    description: 'Frequently asked questions for LLOs and FLWs',
  },
  {
    path: '5-qa-and-training/training-onboarding-email.md',
    producedBy: 'training-onboarding-email',
    consumedBy: ['llo-onboarding'],
    phase: 'qa-and-training',
    required: true,
    description: 'Phase 7 onboarding email template, with {{LLO_NAME}}/{{LLO_FIRST_NAME}}/{{LLO_ORG}} tokens',
  },
  {
    path: '5-qa-and-training/training-deck-outline.md',
    producedBy: 'training-deck-outline',
    consumedBy: ['training-deck-build'],
    phase: 'qa-and-training',
    required: false,
    description: 'Slide-by-slide markdown outline for the training deck. Format contract is parsed by `lib/training-deck-spec.ts` `parseDeckOutline`. Rendered to a Google Slides deck by `training-deck-build`.',
  },
  {
    path: '5-qa-and-training/training-deck-build_verdict.yaml',
    producedBy: 'training-deck-build',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'qa-and-training',
    required: false,
    description: 'Self-emitted verdict — no separate `training-deck-build-eval` skill exists; rename to `training-deck-build-eval_verdict.yaml` if/when one ships. Filename matches producer per Option β.',
  },
  {
    path: '5-qa-and-training/training-deck-outline_verdict.yaml',
    producedBy: 'training-deck-outline',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'qa-and-training',
    required: false,
    description: 'Self-emitted verdict — no separate `training-deck-outline-eval` skill exists; rename to `training-deck-outline-eval_verdict.yaml` if/when one ships. Filename matches producer per Option β.',
  },
  {
    path: '5-qa-and-training/training-faq_verdict.yaml',
    producedBy: 'training-faq',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'qa-and-training',
    required: false,
    description: 'Self-emitted verdict — no separate `training-faq-eval` skill exists; rename to `training-faq-eval_verdict.yaml` if/when one ships. Filename matches producer per Option β.',
  },
  {
    path: '5-qa-and-training/training-flw-guide_verdict.yaml',
    producedBy: 'training-flw-guide',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'qa-and-training',
    required: false,
    description: 'Self-emitted verdict — no separate `training-flw-guide-eval` skill exists; rename to `training-flw-guide-eval_verdict.yaml` if/when one ships. Filename matches producer per Option β.',
  },
  {
    path: '5-qa-and-training/training-llo-guide_verdict.yaml',
    producedBy: 'training-llo-guide',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'qa-and-training',
    required: false,
    description: 'Self-emitted verdict — no separate `training-llo-guide-eval` skill exists; rename to `training-llo-guide-eval_verdict.yaml` if/when one ships. Filename matches producer per Option β.',
  },
  {
    path: '5-qa-and-training/training-onboarding-email_verdict.yaml',
    producedBy: 'training-onboarding-email',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'qa-and-training',
    required: false,
    description: 'Self-emitted verdict — no separate `training-onboarding-email-eval` skill exists; rename to `training-onboarding-email-eval_verdict.yaml` if/when one ships. Filename matches producer per Option β.',
  },
  {
    path: '5-qa-and-training/training-quick-reference_verdict.yaml',
    producedBy: 'training-quick-reference',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'qa-and-training',
    required: false,
    description: 'Self-emitted verdict — no separate `training-quick-reference-eval` skill exists; rename to `training-quick-reference-eval_verdict.yaml` if/when one ships. Filename matches producer per Option β.',
  },

  // ── Synthetic Data and Workflows phase (Phase 6) ───────────────
  // New in 0.13.x via Plan B Stages 1–4. The connect-labs synthetic
  // generator + SEED workflows + canopy:walkthrough decks light up an
  // opp's data story between training and solicitation.

  {
    path: '6-synthetic/synthetic-narrative-plan.md',
    producedBy: 'synthetic-narrative-plan',
    consumedBy: ['synthetic-data-generate', 'synthetic-walkthrough-spec', 'synthetic-summary', 'synthetic-narrative-plan-eval', 'synthetic-workflow-polish-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'Human-readable narrative explaining the synthetic-data story (cast, anomalies, week-by-week arc). Companion to the manifest YAML.',
  },
  {
    path: '6-synthetic/synthetic-narrative-plan.yaml',
    producedBy: 'synthetic-narrative-plan',
    role: 'manifest',
    consumedBy: ['synthetic-data-generate', 'synthetic-workflow-seed', 'synthetic-walkthrough-spec', 'synthetic-summary', 'synthetic-narrative-plan-eval', 'synthetic-data-generate-eval', 'synthetic-workflow-seed-eval', 'synthetic-workflow-polish-eval', 'synthetic-walkthrough-spec-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'Richer manifest authored from PDD + journeys + connect setup: named FLW personas, deliberate anomalies, coaching arcs, KPI thresholds. Schema identical to synthetic-data-generate_manifest.yaml.',
  },
  {
    path: '6-synthetic/synthetic-data-generate_manifest.yaml',
    producedBy: 'synthetic-data-generate',
    role: 'manifest',
    consumedBy: ['synthetic-summary', 'synthetic-data-generate-eval', 'synthetic-workflow-seed-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'Stage 1 default manifest (5 FLWs, 4-week timeline, no anomalies) — used when `synthetic-narrative-plan.yaml` is absent. Sent verbatim to labs `synthetic_generate_from_manifest`.',
  },
  {
    path: '6-synthetic/synthetic-data-generate.md',
    producedBy: 'synthetic-data-generate',
    consumedBy: ['synthetic-walkthrough-spec', 'synthetic-summary', 'synthetic-data-generate-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'Run summary: labs opp_id, fixture folder URL, record counts, form_schema_questions, payment-unit pre-flight + share-gap warnings, labs URL.',
  },
  {
    path: '6-synthetic/synthetic-workflow-seed.md',
    producedBy: 'synthetic-workflow-seed',
    consumedBy: ['synthetic-workflow-polish', 'synthetic-walkthrough-spec', 'synthetic-summary', 'synthetic-workflow-seed-eval', 'synthetic-workflow-polish-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'Run summary: workflow_ids (llo_weekly_review + program_admin_audit), pipeline_id, KPI count, coaching-task IDs, scaffold_unsuitable flag, saved-runs Week-1/Week-2 run_ids + snapshot timestamps (Stage 3b).',
  },
  {
    path: '6-synthetic/synthetic-workflow-polish.md',
    producedBy: 'synthetic-workflow-polish',
    consumedBy: ['synthetic-summary', 'synthetic-workflow-polish-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'Run summary: per-workflow patches applied (intent label per patch), final render_code_versions, smoke-render result, L2-rewrite flag.',
  },
  {
    path: '6-synthetic/synthetic-walkthrough-spec_<persona>.yaml',
    producedBy: 'synthetic-walkthrough-spec',
    consumedBy: ['synthetic-walkthrough-run', 'synthetic-walkthrough-spec-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'Per-persona canopy:walkthrough spec — ordered scenes (URL hint, show, impressive_because, ai_quality). One file per canned + opp-overlay persona.',
  },
  {
    path: '6-synthetic/walkthroughs/<persona>-<timestamp>/slideshow.html',
    producedBy: 'synthetic-walkthrough-run',
    consumedBy: ['synthetic-summary'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'HTML deck produced by canopy:walkthrough — scored screenshots, narration, AI evaluations. New timestamped folder per persona run; opp.yaml.synthetic.walkthroughs[] tracks history.',
  },
  {
    path: '6-synthetic/walkthroughs/<persona>-<timestamp>/eval.json',
    producedBy: 'synthetic-walkthrough-run',
    consumedBy: ['synthetic-summary'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'canopy:walkthrough sidecar with per-scene scores (5 dimensions per scene from canopy:visual-judge dispatch). Sibling of slideshow.html in the same timestamped persona folder. synthetic-summary aggregates eval scores into the persona row.',
  },
  {
    path: '6-synthetic/synthetic-summary.md',
    producedBy: 'synthetic-summary',
    role: 'summary',
    consumedBy: [],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'One-page reviewer-facing summary a Dimagi staffer forwards to a stakeholder. Labs URL + workflow URLs + per-persona slideshow links + 3-paragraph narrative.',
  },

  // Phase 6 eval verdicts (Stage 4 of Plan B).
  {
    path: '6-synthetic/synthetic-narrative-plan-eval_verdict.yaml',
    producedBy: 'synthetic-narrative-plan-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'LLM-as-Judge verdict on the narrative plan: PDD anchoring, cast realism, anomaly+coaching coherence, manifest schema validity, stakeholder narrative quality.',
  },
  {
    path: '6-synthetic/synthetic-data-generate-eval_verdict.yaml',
    producedBy: 'synthetic-data-generate-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'LLM-as-Judge verdict on the data-generate run: record-count health, form schema coverage, warning honesty, manifest provenance, operator next steps.',
  },
  {
    path: '6-synthetic/synthetic-workflow-seed-eval_verdict.yaml',
    producedBy: 'synthetic-workflow-seed-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'LLM-as-Judge verdict on workflow seeding: workflow wiring, KPI population, coaching-task creation, aggregation-mapping honesty, saved-runs deferral honesty.',
  },
  {
    path: '6-synthetic/synthetic-workflow-polish-eval_verdict.yaml',
    producedBy: 'synthetic-workflow-polish-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'LLM-as-Judge verdict on workflow polish: narrative-data coherence, patch quality, smoke-render success, domain-language fit, mode honesty. Strictest gate (threshold 7.5) — polish is the headline.',
  },
  {
    path: '6-synthetic/synthetic-walkthrough-spec-eval_verdict_<persona>.yaml',
    producedBy: 'synthetic-walkthrough-spec-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'LLM-as-Judge verdict per persona spec: persona-priority coverage, wow_moment specificity, ai_quality falsifiability, anomaly-to-scene mapping, turn-off avoidance.',
  },

  // ── Solicitation Management phase (Phase 7) ────────────────────
  // New in 0.12.0; renumbered + rerooted into 7-solicitation-management/ in 0.13.5x.

  {
    path: '7-solicitation-management/solicitation-create_draft.md',
    producedBy: 'solicitation-create',
    role: 'draft',
    consumedBy: ['solicitation-create-eval'],
    phase: 'solicitation-management',
    required: false,
    description: 'Solicitation payload pre-publish: title, type, scope, criteria, response template, deadline. Audit trail for what solicitation-create proposed before posting to labs.',
  },
  {
    path: '7-solicitation-management/solicitation-create_published.md',
    producedBy: 'solicitation-create',
    role: 'published',
    consumedBy: ['solicitation-monitor', 'solicitation-review', 'solicitation-create-eval', 'llo-invite'],
    phase: 'solicitation-management',
    required: false,
    description: 'Snapshot of the published solicitation: solicitation_id, public_url, manage_url, deadline, criteria. Read by every downstream Phase 6 skill and by llo-invite for the URL to email.',
  },
  {
    path: '7-solicitation-management/llo-invite_invitations.md',
    producedBy: 'llo-invite',
    role: 'invitations',
    consumedBy: ['solicitation-monitor', 'solicitation-review-eval'],
    phase: 'solicitation-management',
    required: false,
    description: 'Per-recipient log: who got emailed the solicitation URL, when, and send status. Empty when PDD has no preferred_llos (long-term solicitation flow).',
  },
  {
    path: '7-solicitation-management/solicitation-monitor_responses/',
    producedBy: 'solicitation-monitor',
    consumedBy: ['solicitation-review'],
    phase: 'solicitation-management',
    required: false,
    description: 'One file per solicitation response, written incrementally as responses arrive. Each file contains the response content plus metadata returned by labs.',
  },
  {
    path: '7-solicitation-management/solicitation-review_scoring-rubric.md',
    producedBy: 'solicitation-review',
    role: 'scoring-rubric',
    consumedBy: ['solicitation-review-eval'],
    phase: 'solicitation-management',
    required: false,
    description: 'Per-response, per-criterion scores produced by solicitation-review.',
  },
  {
    path: '7-solicitation-management/solicitation-review_recommendation.md',
    producedBy: 'solicitation-review',
    role: 'recommendation',
    consumedBy: ['solicitation-review-eval'],
    phase: 'solicitation-management',
    required: false,
    description: 'Ranked candidates + reasoning. Input to the HITL gate before award_response is called.',
  },
  {
    path: '7-solicitation-management/solicitation-review_award-record.md',
    producedBy: 'solicitation-review',
    role: 'award-record',
    consumedBy: ['solicitation-review-eval', 'opp-closeout'],
    phase: 'solicitation-management',
    required: false,
    description: 'Written when award_response is called (success or failure). Includes response_id, awarded_at, awarded_org_slug, and any error envelope on failure.',
  },
  {
    path: '7-solicitation-management/solicitation-create-eval_verdict.yaml',
    producedBy: 'solicitation-create-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'solicitation-management',
    required: false,
    description: 'Per-skill -eval verdict for solicitation-create: PDD-fidelity, criteria coverage, deadline plausibility, response-template clarity.',
  },
  {
    path: '7-solicitation-management/solicitation-review-eval_verdict.yaml',
    producedBy: 'solicitation-review-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'solicitation-management',
    required: false,
    description: 'Per-skill -eval verdict for solicitation-review: scoring rigor, recommendation justification, alignment with award outcome.',
  },
  {
    path: '7-solicitation-management/solicitation-management_summary.md',
    producedBy: 'solicitation-management',
    role: 'summary',
    consumedBy: [],
    phase: 'solicitation-management',
    required: true,
    description: 'Phase 6 (solicitation-management) end-of-phase summary written by the solicitation-management subagent. Captures published solicitation URL, invitation count, and gate disposition handed back to the orchestrator.',
  },

  // ── Execution Management phase (Phase 7) ───────────────────────
  // Renamed from llo-manager (was Phase 6) in 0.12.0; renumbered to Phase 7 in 0.13.0.

  {
    path: '8-execution-manager/llo-onboarding_comms-log.md',
    producedBy: 'llo-onboarding',
    role: 'comms-log',
    consumedBy: ['learnings-summary'],
    phase: 'execution-management',
    required: true,
    description: 'Onboarding email records with recipients, subject, body, timestamp',
  },
  {
    path: '8-execution-manager/llo-uat_results.md',
    producedBy: 'llo-uat',
    role: 'results',
    consumedBy: ['llo-launch'],
    phase: 'execution-management',
    required: true,
    description: 'Per-LLO sign-off status, issues found, overall UAT verdict',
  },
  {
    path: '8-execution-manager/llo-launch_record.md',
    producedBy: 'llo-launch',
    role: 'record',
    consumedBy: ['timeline-monitor'],
    phase: 'execution-management',
    required: true,
    description: 'Activation timestamp, LLO notifications, app URLs, outstanding issues',
  },
  {
    path: '8-execution-manager/llo-launch_gate-brief.md',
    producedBy: 'llo-launch',
    role: 'gate-brief',
    consumedBy: ['ace-orchestrator'],
    phase: 'execution-management',
    required: true,
    description: 'Gate brief for the Phase 7 launch gate: UAT sign-offs, app build status, launch-readiness',
  },
  {
    path: '8-execution-manager/ocs-chatbot-qa_transcript-monitor.md',
    producedBy: 'ocs-chatbot-qa',
    role: 'transcript',
    consumedBy: ['ocs-chatbot-eval'],
    phase: 'execution-management',
    required: false,
    description: 'Transcript from recurring --monitor runs; structured input to ocs-chatbot-eval --monitor',
  },
  {
    path: '8-execution-manager/ocs-chatbot-eval_verdict-monitor.yaml',
    producedBy: 'ocs-chatbot-eval',
    role: 'verdict',
    consumedBy: [],
    phase: 'execution-management',
    required: false,
    description: 'Machine-readable verdict from recurring --monitor runs. Latest-wins file; see 7-execution-manager/ocs-chatbot-eval_trend.md for history',
  },
  {
    path: '8-execution-manager/ocs-chatbot-eval_trend.md',
    producedBy: 'ocs-chatbot-eval',
    consumedBy: [],
    phase: 'execution-management',
    required: false,
    description: 'Rolling trend of OCS eval scores from --monitor runs; one line per run',
  },
  {
    path: '8-execution-manager/timeline-monitor/YYYY-MM-DD.md',
    producedBy: 'timeline-monitor',
    consumedBy: ['learnings-summary', 'cycle-grade'],
    phase: 'execution-management',
    required: false,
    description: 'Weekly timeline status, progress indicators, prompting email drafts',
  },
  {
    path: '8-execution-manager/flw-data-review/YYYY-MM-DD.md',
    producedBy: 'flw-data-review',
    consumedBy: ['learnings-summary', 'cycle-grade', 'flw-data-review-eval'],
    phase: 'execution-management',
    required: false,
    description: 'FLW data quality assessment: per-delivery (Layer B) and cross-delivery (Layer C)',
  },
  {
    path: '8-execution-manager/flw-data-review-eval_verdict-monitor.yaml',
    producedBy: 'flw-data-review-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'execution-management',
    required: false,
    description: 'Per-skill -eval verdict for the recurring --monitor mode of flw-data-review: signal coverage, outlier-detection rigor, recommendation actionability, evidence citation, trajectory awareness.',
  },
  {
    path: '8-execution-manager/llo-launch-eval_verdict.yaml',
    producedBy: 'llo-launch-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'execution-management',
    required: false,
    description: 'Per-skill -eval verdict for llo-launch: UAT sign-off completeness, Connect activation correctness, app-publish status, go-live notification fidelity, pre-launch gate-discipline. The most load-bearing Phase 7 rubric because go-live is the production gate.',
  },
  {
    path: '8-execution-manager/execution-manager_summary.md',
    producedBy: 'execution-manager',
    role: 'summary',
    consumedBy: [],
    phase: 'execution-management',
    required: true,
    description: 'Phase 7 (execution-manager) end-of-phase summary written by the execution-manager subagent. Captures activation status, monitoring config, and gate disposition handed back to the orchestrator.',
  },

  // ── Closeout phase (Phase 8) ───────────────────────────────────

  {
    path: '9-closeout/opp-closeout_invoices.md',
    producedBy: 'opp-closeout',
    role: 'invoices',
    consumedBy: [],
    phase: 'closeout',
    required: true,
    description: 'Invoice details, total payment amount, Jira ticket link',
  },
  {
    path: '9-closeout/llo-feedback.md',
    producedBy: 'llo-feedback',
    consumedBy: ['learnings-summary', 'cycle-grade'],
    phase: 'closeout',
    required: true,
    description: 'Per-LLO feedback responses, common themes, improvement suggestions',
  },
  {
    path: '9-closeout/learnings-summary.md',
    producedBy: 'learnings-summary',
    consumedBy: ['cycle-grade'],
    phase: 'closeout',
    required: true,
    description: 'Process/content/technical/relationship learnings against original PDD',
  },
  {
    path: '9-closeout/learnings-summary_new-pdd.md',
    producedBy: 'learnings-summary',
    role: 'new-pdd',
    consumedBy: [],
    phase: 'closeout',
    required: false,
    description: 'New PDD incorporating learnings (only if iteration warranted)',
  },
  {
    path: '9-closeout/cycle-grade.md',
    producedBy: 'cycle-grade',
    consumedBy: ['cycle-grade-eval'],
    phase: 'closeout',
    required: true,
    description: '6/7-dimension grades with evidence, recommendations, narrative assessment',
  },
  {
    path: '9-closeout/cycle-grade-eval_verdict.yaml',
    producedBy: 'cycle-grade-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'closeout',
    required: false,
    description: 'Per-skill -eval verdict for cycle-grade: independent re-grade detecting self-eval inflation, missing learnings, recommendation vagueness.',
  },
  {
    path: '9-closeout/closeout_summary.md',
    producedBy: 'closeout',
    role: 'summary',
    consumedBy: [],
    phase: 'closeout',
    required: true,
    description: 'Phase 8 (closeout) summary written by the closeout subagent at lifecycle completion. The canonical "what shipped, how it landed, what to do next" doc for the opp.',
  },

  // ── Umbrella eval (opp-eval) — ad-hoc, opt-in; not part of the default 8-phase pipeline ──

  {
    path: '9-closeout/opp-eval/opp-eval_scorecard-quick.md',
    producedBy: 'opp-eval',
    role: 'scorecard',
    consumedBy: [],
    phase: 'closeout',
    required: false,
    description: 'Human-readable quick scorecard from opp-eval --quick (structural artifact check only, no LLM cost)',
  },
  {
    path: '9-closeout/opp-eval/opp-eval_scorecard-deep.md',
    producedBy: 'opp-eval',
    role: 'scorecard',
    consumedBy: [],
    phase: 'closeout',
    required: false,
    description: 'Human-readable run-level scorecard from opp-eval --deep: category breakdown, per-skill results, improvement recommendations',
  },
  {
    path: '9-closeout/opp-eval/opp-eval_scorecard-monitor.md',
    producedBy: 'opp-eval',
    role: 'scorecard',
    consumedBy: [],
    phase: 'closeout',
    required: false,
    description: 'Human-readable scorecard from opp-eval --monitor runs; same shape as --deep plus a trend-file append',
  },
  {
    path: '9-closeout/opp-eval/trend.md',
    producedBy: 'opp-eval',
    consumedBy: [],
    phase: 'closeout',
    required: false,
    description: 'Rolling trend of run-level opp-eval scores from --monitor runs; one line per run with date, overall, and category breakdown',
  },
  {
    path: '9-closeout/opp-eval/opp-eval_verdict-deep.yaml',
    producedBy: 'opp-eval',
    role: 'verdict',
    consumedBy: [],
    phase: 'closeout',
    required: false,
    description: 'Machine-readable run-level verdict from opp-eval --deep: 7-category aggregation of every per-skill verdict found under <phase>/...-eval_verdict.yaml, plus improvement recommendations. Shape matches skills/README.md § QA vs Eval',
  },
  {
    path: '9-closeout/opp-eval/opp-eval_verdict-monitor.yaml',
    producedBy: 'opp-eval',
    role: 'verdict',
    consumedBy: [],
    phase: 'closeout',
    required: false,
    description: 'Machine-readable run-level verdict from opp-eval --monitor runs; latest-wins file (history lives in 8-closeout/opp-eval/trend.md)',
  },
  {
    path: '9-closeout/opp-eval/opp-eval_gate-brief-deep.md',
    producedBy: 'opp-eval',
    role: 'gate-brief',
    consumedBy: [],
    phase: 'closeout',
    required: false,
    description: 'Advisory brief from opp-eval --deep / --monitor. Written for contract uniformity with the 5 real gate briefs; does NOT gate any phase today (opp-eval is ad-hoc, not part of --mode review auto-pause flow)',
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
  // Directory entries (trailing slash) cover any file under that prefix.
  const knownDirPrefixes = [...knownPaths].filter((p) => p.endsWith('/'));

  const present: string[] = [];
  const unexpected: string[] = [];
  // Track which directory entries have been satisfied by at least one file.
  const satisfiedDirs = new Set<string>();

  for (const fp of filePaths) {
    if (exempt.includes(fp)) continue;
    if (knownPaths.has(fp)) {
      present.push(fp);
    } else {
      const matchingDir = knownDirPrefixes.find((d) => fp.startsWith(d));
      if (matchingDir) {
        satisfiedDirs.add(matchingDir);
        // Files under a known directory prefix are "known" — not unexpected.
      } else {
        unexpected.push(fp);
      }
    }
  }

  // Directory entries are present if at least one file matched their prefix.
  for (const dir of satisfiedDirs) {
    present.push(dir);
  }

  const presentSet = new Set(present);
  const missing = requiredPaths.filter((p) => !presentSet.has(p));

  return { present, missing, unexpected };
}
