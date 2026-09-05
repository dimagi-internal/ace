/**
 * Canonical artifact manifest for ACE opportunities.
 *
 * Every file that an ACE skill reads from or writes to Google Drive under
 * `ACE/<opp>/runs/<run-id>/` is listed here. A handful of opp-level files
 * (`opp.yaml`, the `inputs/` folder, plus `open-questions.md` and
 * `eval-calibration/known-issues.md`) sit at `ACE/<opp>/` itself, one
 * level above the run folder; they survive across runs and are flagged
 * with `phase: 'design'` for sort order.
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
 * `solicitation-management` at Phase 7. Old `llo-manager` (Phase 7)
 * was renamed `execution-management`; `closeout` moved from 7 to 8.
 *
 * 0.13.x: Phase 1 (design-review) was split into idea-to-design
 * (Phase 1 — PDD only) and scenarios-and-acceptance (Phase 2 —
 * test prompts + app journeys derived from the PDD). All downstream
 * phases shifted ordinal +1 (commcare 2→3, connect 3→4, ...,
 * closeout 9→10). Phase 1 still uses `1-design/`; the new Phase 2
 * uses `2-scenarios/`.
 *
 * To audit: grep -r 'ACE/<opp>/runs/' skills/ agents/
 */

// ── Types ──────────────────────────────────────────────────────────

export type Phase =
  // ── ACE Connect-opp pipeline (Phases 1–10) ──────────────────────────────
  | 'design'
  | 'scenarios-and-acceptance'
  | 'commcare'
  | 'connect'
  | 'ocs'
  | 'qa-and-training'
  | 'synthetic-data-and-workflows'
  | 'solicitation-management'
  | 'execution-management'
  | 'closeout'
  // ── Partnership-video pipeline (separate root: ACE/partnerships/<slug>/) ─
  | 'partnership-research'
  | 'partnership-angles'
  | 'partnership-microdemo'
  | 'partnership-video-build'
  | 'partnership-deck-build'
  | 'partnership-publish';

/**
 * Phase-run MODES that legitimately drop part of a phase's declared output.
 *
 * A mode is not a failure and not a skip: the phase ran, produced real passing
 * artifacts, and could never have produced the rest given the run's shape. It
 * is recorded on the phase block (`phases.<phase>.mode`) by the phase agent.
 *
 * `app-QA-only` — `agents/qa-and-training.md § Mode: app-QA-only`. When Phase 5
 * (OCS) is skipped, Phase 6 runs Step 1 only and marks the seven Step-2
 * training skills `skipped`, because every one of them consumes an OCS chatbot
 * URL that does not exist. Before this vocabulary existed the manifest declared
 * all 11 training artifacts unconditionally required, so the boundary fence
 * reported 11 "healable" misses that re-dispatching Phase 6 could never produce
 * (dimagi-internal/ace#1069, live on bednet-spot-check/20260729-1239).
 *
 * Adding a mode is deliberately two edits — this list, plus the entries it
 * exempts — so an exemption cannot be introduced by a typo'd string alone.
 */
export const PHASE_MODES = ['app-QA-only'] as const;
export type PhaseMode = (typeof PHASE_MODES)[number];

/**
 * Is `value` a mode this plugin recognizes? Unrecognized strings are ignored
 * (the full requirement set applies), so a misspelled mode can never silently
 * relax a fence — it just fails the way an undeclared mode does.
 */
export function isPhaseMode(value: unknown): value is PhaseMode {
  return typeof value === 'string' && (PHASE_MODES as readonly string[]).includes(value);
}

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
  /**
   * Modes in which this REQUIRED artifact is not expected, because the mode's
   * run shape means its producer never runs (ace#1069). Empty/absent = always
   * required. Only meaningful together with `required: true`.
   */
  notRequiredInModes?: readonly PhaseMode[];
  /**
   * True when this artifact is PROSE A HUMAN READS — a PDD, a training guide,
   * a work order, an email body — as opposed to a machine-parsed file
   * (run_state.yaml, a verdict, a manifest, a spec).
   *
   * Load-bearing, not documentation: a `rendered` artifact must be written
   * with `drive_create_doc_from_markdown`, which lets Drive convert the
   * markdown into native headings / bold / links / tables. `drive_create_file`
   * uploads the body as `text/plain`, so the reviewer opens the doc and sees
   * literal `##`, `**`, `|` and `---`. The failure is SILENT — every content
   * check still passes — and it has shipped twice: once on the PDD
   * (dimagi-internal/ace#1061) and once across all five training guides
   * (ace#1338, caught by a partner, not by ACE).
   *
   * Enforced by `test/lib/rendered-artifacts.test.ts`: every entry with
   * `rendered: true` must have a producer whose SKILL.md references
   * `drive_create_doc_from_markdown`. It is a RATCHET — machine-parsed
   * artifacts simply omit the flag and are never checked — so adding a
   * human-facing artifact without the renderer fails CI, while YAML/verdict
   * artifacts stay on `drive_create_file` untouched.
   *
   * Nothing machine-readable is lost by rendering: a properly formatted doc
   * exports back to clean markdown via `drive_read_file(exportAs:
   * 'text/markdown')`. A `text/plain` upload of markdown exports ESCAPED
   * (`\---`, `run\_id`) — the worst of both worlds.
   */
  rendered?: true;
  /**
   * True when this artifact's VALUE IS PARTLY THE PICTURES — a step-by-step
   * guide whose steps are shown, not merely described. Implies `rendered`.
   *
   * The sibling of `rendered`, and the same shape of silent failure one level
   * up. `rendered` catches "the reader sees literal `##`". This catches "the
   * reader sees every word and not one screenshot", which is strictly harder
   * to notice: the prose is intact, so word counts, section checks and all
   * five per-artifact content evals pass. It has now shipped twice on the same
   * two documents — first as `![alt](drive:<id>)`, which Drive's importer
   * drops silently (ace#1338), then as `[alt](https://…/file/d/<id>/view)`,
   * which restored the words as 44 clickable links and none of the pictures
   * (ace#1418). A functionally-literate CBF reading the guide mid-visit
   * cannot use either.
   *
   * Load-bearing: an illustrated artifact is a TWO-STEP write —
   * `drive_create_doc_from_markdown` to convert the prose, then
   * `scripts/embed-doc-screenshots.ts` (Docs API `insertInlineImage` via
   * `docs_batch_update`) to insert the frames the prose already cites. The
   * markdown importer will in fact fetch a real https image src, but it takes
   * the image's natural size — a 1080x2400 phone screenshot lands 9.4 inches
   * wide and a page and a half tall — so the two-step write is what produces a
   * document a human can read. See `lib/doc-image-embed.ts`.
   *
   * Enforced by `test/lib/illustrated-artifacts.test.ts` (producer must name
   * the embed step) and, on the published surface, by
   * `DOC-SCREENSHOTS-ABSENT` in `lib/run-surface-audit.ts`.
   *
   * NOT for every human-facing doc. `training-quick-reference.md` is a printed
   * pocket card whose skill says "No screenshots — graphics blow the page
   * budget"; flagging it would be a false positive. Flag only artifacts whose
   * own contract says the reader is shown the screens.
   */
  illustrated?: true;
  /**
   * A deliverable a RECIPIENT opens by link — an LLO, an FLW, a funder — as
   * opposed to an internal artifact a signed-in operator reads.
   *
   * ace#902. Its producer must share it anyone-with-link at creation. A
   * private Google Doc opens only for accounts explicitly shared on it, so a
   * recipient following the run-summary link hits "You need access" — while
   * every check upstream reads green, because the doc exists, has the right
   * words, and returns a perfectly respectable 401.
   *
   * The detect half of this now exists: `LINK-PRIVATE-DELIVERABLE` in
   * `lib/run-surface-audit.ts` classifies it correctly. This is the PREVENT
   * half — the audit runs after the fact and needs someone to act on it, and
   * on hh-poverty-targeting/20260722-1341 all six training links were private
   * and had to be shared by hand.
   *
   * NOT for internal artifacts. A verdict YAML, a manifest, a spec file and a
   * transcript are read by operators and skills, never handed to a
   * counterpart; publishing those anyone-with-link widens exposure for no one's
   * benefit. Flag only what is meant to leave the building.
   *
   * Enforced by `test/lib/recipient-facing-artifacts.test.ts` (producer must
   * name the share step).
   */
  recipientFacing?: true;
  /**
   * The Drive role a `recipientFacing` artifact is shared with.
   *
   * Visibility is NOT a boolean, and getting the role wrong is its own defect
   * class: a Drive **reader cannot comment**, and `skills/feedback-ledger`'s
   * `channel: gdoc-comments` — the entire feedback → ledger → next-run loop —
   * assumes the reviewer can leave an ANCHORED comment on the document.
   * Sharing the PDD `reader` produces a link that opens and a review that is
   * structurally impossible.
   *
   * `'commenter'` is therefore the default for anything a counterpart is asked
   * to REVIEW (the PDD, the Work Order, the open-questions ledger, the five
   * training deliverables). `'reader'` is for material a recipient only
   * consumes.
   *
   * Absence of `recipientFacing` means INTERNAL, and that is a deliberate,
   * legitimate state — not a gap to be filled. `5-ocs/ocs-setup_widget-handoff.md`
   * carries an `embed_key` and is correctly private now that ace#1811
   * established the public chatbot URL as the LLO route. A guard that flagged
   * every unshared artifact would fire on it forever (ace#1026).
   *
   * Enforced by `test/lib/recipient-facing-artifacts.test.ts`.
   */
  shareRole?: 'reader' | 'commenter';
  /**
   * True when this artifact's producer must ALSO persist the markdown it
   * composed, as a sibling `<name>.source.md` (see `sourceMarkdownPathFor`).
   *
   * Implies `rendered` — and that is the whole point. `drive_create_doc_from_markdown`
   * CONSUMES its input: what lands in Drive is a native Google Doc, and the
   * markdown that produced it exists nowhere afterwards. The `.md` on
   * `training-faq.md` is part of the display NAME, not a separate file. Verified
   * live on `hh-poverty-targeting/20260824-1404`, where `drive_list_folder` over
   * `6-qa-and-training/` returns all five training documents as
   * `application/vnd.google-apps.document` and no sibling markdown of any kind.
   *
   * Load-bearing, not bookkeeping: `DOC-FIDELITY-UNVERIFIED` in
   * `lib/run-surface-audit.ts` compares what was PUBLISHED against what was
   * WRITTEN, and it is the only check that can catch the regression it was
   * built for — a guide that lost 44 screenshots and 224 words with every
   * other check green (ace#1418). Its remediation is to pass `--doc-source`
   * mapping each url to its source markdown. With nothing persisted there is
   * no such artifact to point at, so a BLOCKING finding is permanently
   * unresolvable and the regression it guards stays unguarded (ace#1687,
   * half 2).
   *
   * **The source file must be written with `drive_create_file` at
   * `mimeType: 'text/markdown'` — NEVER `drive_create_doc_from_markdown`.**
   * Rendering the source copy would convert it to a Doc too and destroy the
   * exact bytes the comparison needs, which is the defect rather than the fix.
   * Both writes take the SAME string: render it for humans, store it verbatim
   * for the auditor.
   *
   * NOT for every rendered artifact. Two deliberate exclusions, for different
   * reasons — read them before "fixing" either:
   *
   *   - `open-questions.md` is an opp-level LIVING document that reviewers
   *     hand-edit in place across runs. Published-vs-source divergence there
   *     is expected and correct, so a fidelity diff would report legitimate
   *     human edits as defects.
   *   - `1-design/pdd-to-work-order.gdoc` has **no composed markdown to
   *     persist, and no importer that could drop anything.** It is built by
   *     `docs_copy_template`, which is `drive.files.copy` of a Google Doc
   *     template plus a `replaceAllText` batch (`mcp/google-drive-server.ts`)
   *     — Doc to Doc, start to finish. The regression `DOC-FIDELITY-UNVERIFIED`
   *     exists to catch is the markdown IMPORTER silently dropping content;
   *     with no import step that class cannot occur, and the drift that CAN
   *     occur there (template tokens the skill never replaced) already has its
   *     own preventer — the surviving-`{{` scan in
   *     `skills/pdd-to-work-order/SKILL.md` step 5. Writing it a `.source.md`
   *     would hand the auditor a file to diff that the document was never
   *     produced from: a green comparison that means nothing. If the audit
   *     should report this doc as NOT-APPLICABLE rather than UNVERIFIED, that
   *     belongs in the auditor, not here (ace#1687 half 1).
   *
   * Flag only ACE-authored deliverables composed AS MARKDOWN, published once
   * per run through the importer, and not expected to be edited afterwards.
   *
   * Enforced by `test/lib/source-persisted-artifacts.test.ts`: the flagged set
   * is pinned, every flagged entry is `rendered`, every producer names the
   * persist step and the plain-file atom, and the registered `.source.md`
   * companion entries match the flagged set exactly (so the flag and the
   * registry cannot drift). Companions are `required: false` by contract —
   * making them required would retroactively fail every run that completed
   * before this shipped.
   */
  sourcePersisted?: true;
  /** Human-readable purpose */
  description: string;
}

/**
 * The sibling path a `sourcePersisted` artifact's composed markdown is stored
 * at: the published document's path with its extension replaced by
 * `.source.md`.
 *
 * Single source of truth for the convention, so the manifest entries, the
 * ratchet test, and any tooling that builds a `--doc-source` map all derive it
 * rather than re-spelling it.
 */
export function sourceMarkdownPathFor(publishedPath: string): string {
  return publishedPath.replace(/\.[^./]+$/, '') + '.source.md';
}

// ── Phase identity (single source of truth) ────────────────────────

/**
 * One canonical definition per lifecycle phase. Everything that needs a
 * phase's *other* names derives from here instead of re-encoding the
 * relationship:
 *
 *   - `key`       — the internal short key (the value of every
 *                   `ArtifactEntry.phase`, and the `verify_phase_artifacts`
 *                   enum). e.g. `design`, `commcare`.
 *   - `agentName` — the phase-agent dispatch / file name and the public
 *                   key-space the `render_run_readme` atom + the
 *                   orchestrator doc use. e.g. `idea-to-design`,
 *                   `commcare-setup`, `execution-manager`. DIFFERS from
 *                   `key` for 5 of the 10 phases.
 *   - `ordinal`   — 1-based lifecycle position.
 *   - `folder`    — the run-folder subfolder prefix where the phase's
 *                   artifacts live. NOT derivable from `key` (`design` →
 *                   `1-design`, `synthetic-data-and-workflows` →
 *                   `7-synthetic`), so it must be declared.
 *
 * Before this existed the (agentName ↔ key ↔ folder) relationship was
 * hand-re-encoded in ≥4 places (the orchestrator doc's "Manifest-key
 * map" table, `render_run_readme`'s private alias map, the
 * `verify_phase_artifacts` enum, the manifest path prefixes) and they
 * drifted — `render_run_readme` silently no-op'd the 5 phases where
 * `agentName != key` (jjackson/ace#637). Add a phase here and the
 * derived exports + helpers below pick it up.
 */
export interface PhaseDef {
  key: Phase;
  agentName: string;
  ordinal: number;
  folder: string;
}

export const PHASE_DEFS: readonly PhaseDef[] = [
  // ── ACE Connect-opp pipeline (Phases 1–10) ──────────────────────────────
  { key: 'design',                       agentName: 'idea-to-design',               ordinal: 1,  folder: '1-design' },
  { key: 'scenarios-and-acceptance',     agentName: 'scenarios-and-acceptance',     ordinal: 2,  folder: '2-scenarios' },
  { key: 'commcare',                     agentName: 'commcare-setup',               ordinal: 3,  folder: '3-commcare' },
  { key: 'connect',                      agentName: 'connect-setup',                ordinal: 4,  folder: '4-connect' },
  { key: 'ocs',                          agentName: 'ocs-setup',                    ordinal: 5,  folder: '5-ocs' },
  { key: 'qa-and-training',              agentName: 'qa-and-training',              ordinal: 6,  folder: '6-qa-and-training' },
  { key: 'synthetic-data-and-workflows', agentName: 'synthetic-data-and-workflows', ordinal: 7,  folder: '7-synthetic' },
  { key: 'solicitation-management',      agentName: 'solicitation-management',      ordinal: 8,  folder: '8-solicitation-management' },
  { key: 'execution-management',         agentName: 'execution-manager',            ordinal: 9,  folder: '9-execution-manager' },
  { key: 'closeout',                     agentName: 'closeout',                     ordinal: 10, folder: '10-closeout' },
  // ── Partnership-video pipeline (separate root: ACE/partnerships/<slug>/) ─
  // Ordinals 11–16 continue the contiguous sequence so the phase-defs test
  // (ordinals are 1..N) still passes. The partnership-video.md agent has no
  // phase_ordinal so it is never a PHASE_AGENT in the coherence tests (those
  // check agent frontmatter, not PHASE_DEFS). agentName = key here (each phase
  // is its own canonical identifier) so the uniqueness + normalizePhaseKey
  // tests pass unchanged, and the "5 phases where agentName != key" set stays
  // exactly the historical 5 ACE-opp phases.
  // partnership-research and partnership-angles share folder '2-research/'.
  // partnership-publish has only run-root writes so its folder is vestigial.
  { key: 'partnership-research',    agentName: 'partnership-research',    ordinal: 11, folder: '2-research' },
  { key: 'partnership-angles',      agentName: 'partnership-angles',      ordinal: 12, folder: '2-research' },
  { key: 'partnership-microdemo',   agentName: 'partnership-microdemo',   ordinal: 13, folder: '7-microdemo' },
  { key: 'partnership-video-build', agentName: 'partnership-video-build', ordinal: 14, folder: '8-video-build' },
  { key: 'partnership-deck-build',  agentName: 'partnership-deck-build',  ordinal: 15, folder: '8-deck-build' },
  { key: 'partnership-publish',     agentName: 'partnership-publish',     ordinal: 16, folder: '9-publish' },
] as const;

// ── Phase ordering (derived — do not hand-edit; edit PHASE_DEFS) ─────

export const PHASES: readonly Phase[] = PHASE_DEFS.map((p) => p.key);

// ── Phase identity helpers (all derived from PHASE_DEFS) ─────────────

const PHASE_BY_KEY: Record<string, PhaseDef> = Object.fromEntries(
  PHASE_DEFS.map((p) => [p.key, p]),
);
const PHASE_BY_AGENT_NAME: Record<string, PhaseDef> = Object.fromEntries(
  PHASE_DEFS.map((p) => [p.agentName, p]),
);

/** True iff `s` is a valid internal short `Phase` key. */
export function isPhaseKey(s: string): s is Phase {
  return s in PHASE_BY_KEY;
}

/**
 * Normalize a phase identifier from EITHER key-space — an internal short
 * `Phase` key OR a long phase-agent-file name — to its short `Phase`
 * key. Returns `undefined` for a string that matches neither space.
 * Canonical replacement for ad-hoc per-file alias maps.
 */
export function normalizePhaseKey(s: string): Phase | undefined {
  if (s in PHASE_BY_KEY) return s as Phase;
  return PHASE_BY_AGENT_NAME[s]?.key;
}

/** The run-folder subfolder prefix for a phase (e.g. `design` → `1-design`). */
export function phaseFolder(key: Phase): string {
  return PHASE_BY_KEY[key].folder;
}

/** The phase-agent dispatch / file name for a phase (e.g. `design` → `idea-to-design`). */
export function phaseAgentName(key: Phase): string {
  return PHASE_BY_KEY[key].agentName;
}

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
    description: 'Opp-level identity (display_name, slug, tags, created_at, created_by) PLUS the durable Connect program reference at `connect.program.{id, url, connect_int_id}` — written by connect-program-setup on first create; reused across every run of the opp. Every other piece of evolving state (Connect opportunity, OCS chatbot, solicitation, selected_llo, synthetic) is per-run and lives only in the producing run\'s run_state.yaml.phases.<phase>.products.*. Each run is independent — no run reads from or writes to another run\'s run_state.yaml. Older opps may still carry stale `solicitation`/`selected_llo`/`synthetic`/`connect.opportunity`/`ocs_chatbot` blocks here from earlier dual-write iterations — no longer read or written; operator-cleaned-up when picking a release-candidate run. (Earlier shapes also carried `last_run_id` and a `runs:` array; both were dropped because no consumer reads them — ace-web enumerates runs by listing the filesystem under runs/.)',
  },
  {
    path: '1-design/component-set.yaml',
    producedBy: 'idea-to-pdd',
    consumedBy: ['ace-orchestrator', 'pdd-to-learn-app', 'pdd-to-deliver-app'],
    phase: 'design',
    required: false,
    description: 'Machine-readable component handoff for a COMPONENTIZED programme — written only when the input set declares components (`Component: <n> of …` on a PDD\'s metadata line), never on the single-PDD path. Carries each component\'s id, declared title and OWN pdd file id, the program-level PDDs (Learn), the obligations the programme overview must answer, and cross-component references this programme does not carry. Shape and guards: lib/component-products.ts (`buildComponentProducts` refuses `mode: componentized` with zero components); classification: lib/component-set.ts; obligations: lib/programme-overview.ts; design: docs/superpowers/specs/2026-09-05-multi-component-programmes.md. `products.pdd` stays populated alongside it and points at the programme OVERVIEW — 17 places read it directly, so a componentized run does not null it.',
  },
  {
    path: 'open-questions.md',
    producedBy: 'idea-to-pdd',
    consumedBy: ['ace-orchestrator'],
    phase: 'design',
    required: false,
    rendered: true,
    // 401 anonymously on all three ace#1843 runs. `commenter` so a reviewer can
    // ANSWER a question on the row that asks it, rather than in a side channel.
    recipientFacing: true,
    shareRole: 'commenter',
    description: 'Per-opp deferred-question doc. Written by idea-to-pdd when stress-test grades partial/fail and a default reasonable-pick is taken; phase agents append unresolved questions here at end-of-run for human review (per the feedback_phase_open_questions user-memory item). Opp-level (NOT under runs/<run-id>/) so questions survive across runs until answered. NOT append-only: it carries exactly two sections, `## Open` (the live list — the only section ever read back or inlined at Phase 1 handoff) and `## Archive` (closed history, never read back and never inlined). Resolving a question MOVES its row from `## Open` to `## Archive` with resolved_at / resolved_by / resolution_note — it is never annotated in place, which is what let the ledger grow to 26,577 chars and leak inherited framing into a fixture opp\'s PDD (dimagi-internal/ace#1487). The read side is bounded by lib/open-questions-inline.ts: fixture opps (an iterate-state.yaml at the opp root) skip the inline entirely; everyone else gets `## Open` capped at OPEN_QUESTIONS_INLINE_CAP_CHARS. Shape contract: skills/idea-to-pdd/SKILL.md § The durable open-questions doc.',
  },
  {
    path: 'eval-calibration/known-issues.md',
    producedBy: 'eval-calibration',
    consumedBy: [
      'app-release-eval', 'connect-program-setup-eval', 'cycle-grade-eval',
      'flw-data-review-eval', 'idea-to-pdd-eval', 'llo-launch-eval',
      'ocs-chatbot-eval', 'ocs-widget-handoff-eval',
      'pdd-to-app-journeys-eval',
      'pdd-to-deliver-app-eval', 'pdd-to-learn-app-eval',
      'pdd-to-test-prompts-eval',
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
    consumedBy: ['idea-to-pdd', 'pdd-to-deliver-app', 'pdd-to-deliver-app-eval'],
    phase: 'design',
    required: false,
    description: 'Frozen pointer-set captured at run start: every direct child file under inputs/ as {file_id, name, mime_type}. idea-to-pdd reads each entry to synthesize the PDD; pdd-to-deliver-app Step 4k (and its eval) resolve the published source file of a [FIXED] instrument through it, so a wrong scoring constant is caught against the document rather than against the model-authored brief (ace#1527). Lives at the run-folder root alongside run_state.yaml — both are run-level metadata, scoped beyond any single phase. Pointing at file_ids (not paths) means a human re-arranging inputs/ mid-run does not shift the source pack out from under Phase 1. NOT YET required: existing fixtures predate the 2026-05-05 evidence-pack refactor; flip to required=true once the next round of fixture updates lands.',
  },
  {
    path: '1-design/idea-to-pdd.md',
    producedBy: 'idea-to-pdd',
    consumedBy: [
      'idea-to-pdd-qa',
      'pdd-to-test-prompts', 'pdd-to-app-journeys',
      'pdd-to-learn-app', 'pdd-to-deliver-app',
      'app-test-cases', 'app-ux-eval',
      'training-llo-guide', 'training-flw-guide', 'training-quick-reference',
      'training-faq', 'training-onboarding-email', 'training-deck-generate',
      'connect-program-setup', 'connect-opp-setup',
      'solicitation-create', 'llo-invite',
      'ocs-agent-setup', 'timeline-monitor', 'flw-data-review',
      'cycle-grade', 'learnings-summary',
    ],
    phase: 'design',
    required: true,
    rendered: true,
    sourcePersisted: true,
    // The single most-shared artifact ACE produces, and it reached the end of
    // three complete runs readable by nobody (ace#1843: hh-poverty-targeting/
    // 20260828-0702, bednet-check-2-visit/20260828-0629, spark-facilitator/
    // 20260828-0703 — all 401 anonymously). `commenter`, not `reader`: the
    // run-summary page's own ask is "review the decisions", and the
    // feedback → ledger loop starts with anchored comments on this document.
    recipientFacing: true,
    shareRole: 'commenter',
    description: 'Program Design Document with archetype, Evidence Model, Solicitation block, and stress-test appendix (the canonical pdd.md, renamed to match its producer)',
  },
  {
    path: '1-design/idea-to-pdd.source.md',
    producedBy: 'idea-to-pdd',
    consumedBy: ['run-surface-audit'],
    phase: 'design',
    // Never required: making it so would retroactively fail every run that
    // completed before ace#1687 shipped. verify_phase_artifacts counts it
    // under optional_present_count.
    required: false,
    description: 'Verbatim markdown `idea-to-pdd.md` was composed from, stored as a plain text/markdown file so `run-surface-audit`\'s DOC-FIDELITY-UNVERIFIED check has a real source to diff the published Doc against (ace#1687). Optional by contract: runs that completed before this shipped have none.',
  },
  {
    path: '1-design/idea-to-pdd-qa_result.yaml',
    producedBy: 'idea-to-pdd-qa',
    role: 'qa-result',
    consumedBy: ['ace-orchestrator', 'idea-to-pdd-eval'],
    phase: 'design',
    required: false,
    description: 'Structural QA verdict on idea-to-pdd.md (binary pass/fail per lib/qa-types.ts schema). Gates idea-to-pdd-eval — eval is skipped (verdict: incomplete) if QA fails irrecoverably. Produced by the new idea-to-pdd-qa skill; first migration of the QA/Eval split principle (PR #146).',
  },
  {
    path: '1-design/pdd-to-work-order.gdoc',
    producedBy: 'pdd-to-work-order',
    consumedBy: [
      'pdd-to-work-order-qa',
      'pdd-to-work-order-eval',
    ],
    phase: 'design',
    required: false,
    rendered: true,
    // The other half of the `DESIGN` section a partner is sent (ace#1843).
    // `commenter` for the same reason as the PDD — this is the document a
    // counterpart is most likely to mark up.
    recipientFacing: true,
    shareRole: 'commenter',
    description: 'Contractual Work Order draft derived from the PDD and decisions.yaml. Generic by default — Partner identity is a placeholder unless an LLO was supplied. Re-runs create pdd-to-work-order-2.gdoc, pdd-to-work-order-3.gdoc, etc.; products.work_order in run_state.yaml points at the latest. Parallel to Phase 8 solicitation, not a replacement. Spec: docs/superpowers/specs/2026-05-21-work-order-skill-design.md',
  },
  {
    path: '1-design/pdd-to-work-order-qa_result.yaml',
    producedBy: 'pdd-to-work-order-qa',
    role: 'qa-result',
    consumedBy: ['ace-orchestrator', 'pdd-to-work-order-eval'],
    phase: 'design',
    required: false,
    description: 'QA verdict for pdd-to-work-order: structural pass/fail across the 8 checks defined in skills/pdd-to-work-order-qa/checks.ts.',
  },
  {
    path: '1-design/pdd-to-work-order-eval_verdict.yaml',
    producedBy: 'pdd-to-work-order-eval',
    role: 'verdict',
    consumedBy: ['ace-orchestrator', 'opp-eval'],
    phase: 'design',
    required: true,
    description: 'Per-skill -eval verdict for pdd-to-work-order: contractual clarity, PDD alignment, decisions traceability, verification realism, archetype fit. Shape matches skills/README.md § QA vs Eval.',
  },
  {
    path: '2-scenarios/pdd-to-test-prompts.md',
    producedBy: 'pdd-to-test-prompts',
    consumedBy: [
      'pdd-to-test-prompts-qa', 'pdd-to-test-prompts-eval',
      'ocs-chatbot-qa',
    ],
    phase: 'scenarios-and-acceptance',
    required: true,
    description: 'Opp-specific Q&A pairs derived from the PDD; each entry has an expected-answer summary that ocs-chatbot-qa embeds in the transcript and ocs-chatbot-eval grades against. AI-derived from the AI-authored PDD — treated as expected scenarios, not ground truth.',
  },
  {
    path: '2-scenarios/pdd-to-test-prompts-qa_result.yaml',
    producedBy: 'pdd-to-test-prompts-qa',
    role: 'qa-result',
    consumedBy: ['ace-orchestrator', 'pdd-to-test-prompts-eval'],
    phase: 'scenarios-and-acceptance',
    required: false,
    description: 'Structural QA verdict on pdd-to-test-prompts.md. Gates pdd-to-test-prompts-eval — eval is skipped if QA fails irrecoverably.',
  },
  {
    path: '2-scenarios/pdd-to-test-prompts-eval_verdict.yaml',
    producedBy: 'pdd-to-test-prompts-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'scenarios-and-acceptance',
    required: true,
    description: 'Quality eval on pdd-to-test-prompts.md across 6 dimensions: expected-answer specificity, adversarial-prompt quality, archetype coverage, prompt phrasing realism, expected-tag correctness, escalation-prompt quality.',
  },
  {
    path: '2-scenarios/pdd-to-app-journeys.md',
    producedBy: 'pdd-to-app-journeys',
    consumedBy: [
      'pdd-to-app-journeys-eval',
      'app-test-cases', 'app-ux-eval', 'app-screenshot-capture',
    ],
    phase: 'scenarios-and-acceptance',
    required: true,
    description: 'PDD-derived user journeys + UX edge cases. Used by app-test-cases (Phase 3) and app-ux-eval (deep) as the UX-intent expectations to grade against. Each journey carries a goal, happy-path narrative, edge cases phrased as UX outcomes, and pass criteria. AI-derived from the AI-authored PDD — treated as expected scenarios, not ground truth.',
  },
  {
    path: '2-scenarios/pdd-to-app-journeys-eval_verdict.yaml',
    producedBy: 'pdd-to-app-journeys-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'scenarios-and-acceptance',
    required: true,
    description: 'Quality eval on pdd-to-app-journeys.md across 6 dimensions: persona specificity, archetype alignment, coverage completeness, happy-path narrative voice, edge-case recoverability, pass-criteria measurability.',
  },
  {
    path: '2-scenarios/scenarios-and-acceptance_summary.md',
    producedBy: 'scenarios-and-acceptance',
    role: 'summary',
    consumedBy: [],
    phase: 'scenarios-and-acceptance',
    required: true,
    description: 'Phase 2 (scenarios-and-acceptance) end-of-phase summary written by the scenarios-and-acceptance subagent. Captures test-prompts + app-journeys highlights and gate disposition handed back to the orchestrator.',
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
    path: 'decisions.yaml',
    producedBy: 'idea-to-pdd',
    consumedBy: ['decisions-render', 'idea-to-pdd'],
    phase: 'design',
    required: false,
    description: 'Per-run structured log of load-bearing defaults applied across the lifecycle. Phase 1 (idea-to-pdd) writes its rows when authoring the PDD; subsequent phases append rows as they apply load-bearing defaults (Phase 3-10 writes ship in the next PR of the decisions-log series). Schema enforced via lib/decisions-schema.ts. Re-runs honor status: overridden rows from prior runs as authoritative inputs. Lives at the run-folder root alongside run_state.yaml — both are run-level metadata.',
  },
  {
    path: 'decisions.gdoc',
    producedBy: 'decisions-render',
    consumedBy: ['ace-orchestrator'],
    phase: 'design',
    required: false,
    description: 'Prose Google Doc rendering of decisions.yaml at one stable URL per run. Find-or-update semantics; existing content cleared and replaced on every invocation. Re-rendered by the orchestrator at end of every phase via skills/decisions-render. Humans review and iterate on this gdoc rather than the YAML; the gdoc URL appears in each gate brief as the Decisions Log: line.',
  },
  // 0.13.116: gate-brief artifacts removed across all phases. The
  // orchestrator composes pause-time summaries from per-skill QA + eval
  // verdicts on the fly at Pause Points (see agents/ace-orchestrator.md
  // § Pause Points).
  {
    path: '1-design/idea-to-pdd-eval_verdict.yaml',
    producedBy: 'idea-to-pdd-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'design',
    required: true,
    description: 'Per-skill -eval verdict for idea-to-pdd: structural completeness, archetype coherence, concreteness, reviewer-comment fidelity, stress-test agreement. Shape matches skills/README.md § QA vs Eval.',
  },
  {
    path: '1-design/idea-to-design_summary.md',
    producedBy: 'idea-to-design',
    role: 'summary',
    consumedBy: [],
    phase: 'design',
    required: true,
    description: 'Phase 1 (idea-to-design) end-of-phase summary written by the idea-to-design subagent. Captures the agreed PDD highlights and gate disposition handed back to the orchestrator.',
  },

  // ── CommCare phase (Phase 3) ───────────────────────────────────

  {
    path: '3-commcare/pdd-to-learn-app_snapshot.json',
    producedBy: 'pdd-to-learn-app',
    role: 'snapshot',
    consumedBy: [],
    phase: 'commcare',
    required: false,
    description: 'Optional historical snapshot of the Learn app structure (output of `/nova:show <id>`). Not required: Nova is the system of record for the app, and the canonical handle is `nova_app_id` in the summary frontmatter (see 2026-04-27 Nova-plugin migration note).',
  },
  {
    path: '3-commcare/pdd-to-deliver-app_snapshot.json',
    producedBy: 'pdd-to-deliver-app',
    role: 'snapshot',
    consumedBy: [],
    phase: 'commcare',
    required: false,
    description: 'Optional historical snapshot of the Deliver app structure (output of `/nova:show <id>`). Not required — see Learn equivalent above.',
  },
  {
    path: '3-commcare/pdd-to-learn-app_summary.md',
    producedBy: 'pdd-to-learn-app',
    role: 'summary',
    consumedBy: [
      'app-deploy', 'app-test-cases', 'app-ux-eval',
      'training-llo-guide', 'training-flw-guide', 'training-quick-reference',
      'training-faq', 'training-deck-generate',
      'ocs-agent-setup', 'flw-data-review',
    ],
    phase: 'commcare',
    required: true,
    description: 'Learn app structure summary for downstream skills. Required frontmatter: `nova_app_id`, `nova_app_url`, `archetype`. `app-deploy` reads `nova_app_id` from here to feed `/nova:upload_to_hq`.',
  },
  {
    path: '3-commcare/pdd-to-deliver-app_summary.md',
    producedBy: 'pdd-to-deliver-app',
    role: 'summary',
    consumedBy: [
      'app-deploy', 'app-test-cases', 'app-ux-eval',
      'training-llo-guide', 'training-flw-guide', 'training-quick-reference',
      'training-faq', 'training-deck-generate',
      'ocs-agent-setup', 'flw-data-review',
    ],
    phase: 'commcare',
    required: true,
    description: 'Deliver app structure summary for downstream skills. Required frontmatter: `nova_app_id`, `nova_app_url`, `archetype`, `delivery_unit`. `app-deploy` reads `nova_app_id` from here.',
  },
  {
    path: '3-commcare/app-deploy_summary.md',
    producedBy: 'app-deploy',
    role: 'summary',
    consumedBy: ['connect-opp-setup', 'llo-uat', 'llo-launch'],
    phase: 'commcare',
    required: true,
    description: 'App deployment details: IDs, URLs, build status',
  },
  {
    path: '3-commcare/app-test-cases.yaml',
    producedBy: 'app-test-cases',
    consumedBy: ['app-screenshot-capture', 'app-ux-eval'],
    phase: 'commcare',
    required: true,
    description: 'Bindings of pdd-to-app-journeys.md to Phase-3-built app structure: per-journey form/field IDs, Maestro recipe paths, smoke flags, structural pass criteria. Phase 6 shallow uses is_smoke: true entries; /ace:qa-deep uses all entries.',
  },
  {
    path: '3-commcare/recipes/journey-learn.yaml',
    producedBy: 'app-test-cases',
    consumedBy: ['app-screenshot-capture'],
    phase: 'commcare',
    required: true,
    description: "Learn-app smoke Maestro recipe (the is_smoke: true Learn journey). Phase 6's pre-flight hard-halts without it — Learn capture is the floor — so its absence must fail the Phase 3 fence, not surface first at Phase 6 (ace#892).",
  },
  {
    path: '3-commcare/recipes/journey-deliver.yaml',
    producedBy: 'app-test-cases',
    consumedBy: ['app-screenshot-capture'],
    phase: 'commcare',
    required: false,
    description: "Deliver-app smoke Maestro recipe (the is_smoke: true Deliver journey). Phase 6 degrades without it (Learn leg still captures; Deliver leg records incomplete), so optional at the fence — but expected on every two-app opp.",
  },
  {
    path: '3-commcare/pdd-to-learn-app-eval_verdict.yaml',
    producedBy: 'pdd-to-learn-app-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'commcare',
    required: true,
    description: 'Per-skill -eval verdict for pdd-to-learn-app: module count, order, Connectify Assessment Score wiring, gating thresholds, content coverage match against the PDD.',
  },
  {
    path: '3-commcare/pdd-to-deliver-app-eval_verdict.yaml',
    producedBy: 'pdd-to-deliver-app-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'commcare',
    required: true,
    description: 'Per-skill -eval verdict for pdd-to-deliver-app: field count, ordering, conditional logic, Connectify wiring, required-field rules match against the PDD.',
  },
  {
    path: '3-commcare/app-release-eval_verdict.yaml',
    producedBy: 'app-release-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'commcare',
    required: true,
    description: 'Per-skill -eval verdict for app-release: every uploaded build successfully released, CCZ-marker checks passed, no draft-only apps remain.',
  },
  {
    path: '3-commcare/app-connect-coverage_learn.md',
    producedBy: 'app-connect-coverage',
    role: 'learn',
    consumedBy: ['app-release'],
    phase: 'commcare',
    required: false,
    description: 'Per-form Connect-marker coverage report for the Learn app. Frontmatter carries `status: clean | blocked | partial`; `app-release` gates on `status: clean` before build+release.',
  },
  {
    path: '3-commcare/app-connect-coverage_deliver.md',
    producedBy: 'app-connect-coverage',
    role: 'deliver',
    consumedBy: ['app-release'],
    phase: 'commcare',
    required: false,
    description: 'Per-form Connect-marker coverage report for the Deliver app. Frontmatter carries `status: clean | blocked | partial`; `app-release` gates on `status: clean` before build+release.',
  },
  {
    path: '3-commcare/commcare-setup_summary.md',
    producedBy: 'commcare-setup',
    role: 'summary',
    consumedBy: [],
    phase: 'commcare',
    required: true,
    description: 'Phase 3 (commcare-setup) end-of-phase summary written by the commcare-setup procedure-doc agent. Captures app IDs, deploy/release status, and gate disposition handed back to the orchestrator.',
  },

  // ── Connect phase (Phase 4) ────────────────────────────────────

  {
    path: '4-connect/connect-program-setup.md',
    producedBy: 'connect-program-setup',
    consumedBy: ['connect-opp-setup'],
    phase: 'connect',
    required: true,
    description: 'Connect Program ID, name, config details',
  },
  {
    path: '4-connect/connect-opp-setup.md',
    producedBy: 'connect-opp-setup',
    consumedBy: ['llo-onboarding', 'llo-uat', 'llo-launch', 'ocs-agent-setup', 'opp-closeout'],
    phase: 'connect',
    required: true,
    description: 'Connect Opportunity ID, verification rules, delivery/payment unit config',
  },
  {
    path: '4-connect/connect-program-setup-eval_verdict.yaml',
    producedBy: 'connect-program-setup-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'connect',
    required: true,
    description: 'Per-skill -eval verdict for the Connect program/opportunity setup: program-fit decision (reuse vs create), opportunity verification rules, delivery units, payment units, entity-id wiring against PDD spec.',
  },
  {
    path: '4-connect/connect-opp-setup-eval_verdict.yaml',
    producedBy: 'connect-opp-setup-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'connect',
    required: false,
    description: 'Per-skill -eval verdict for the Connect opportunity configuration: verification flag fidelity (Layer A rules from PDD Evidence Model), payment unit fit, deliver unit wiring, active window, archetype config coherence. Live-state drift via connect_get_opportunity / list_payment_units / list_deliver_units when MCP reachable.',
  },
  {
    path: '4-connect/connect-setup_summary.md',
    producedBy: 'connect-setup',
    role: 'summary',
    consumedBy: ['app-release-eval', 'connect-program-setup-eval', 'llo-launch-eval'],
    phase: 'connect',
    required: true,
    description: 'Phase 4 (connect-setup) end-of-phase summary written by the connect-setup subagent. Captures program/opp IDs, payment-unit config, and gate disposition. Read by 3 downstream -eval skills as ground truth for grading.',
  },

  // ── OCS phase (Phase 5) ────────────────────────────────────────

  {
    path: '5-ocs/ocs-agent-setup.md',
    producedBy: 'ocs-agent-setup',
    consumedBy: [
      'ocs-chatbot-qa',
      'ocs-chatbot-eval',
      'llo-onboarding',
      'timeline-monitor',
      'flw-data-review',
      // Phase 6's `ocs-knowledge-refresh` reads experiment_id / collection_id /
      // pipeline_id from here — its own Inputs table says so, and Step 0 halts
      // without them. The edge was missing from 0.13.1028 (the ocs-agent-setup
      // split) until 0.13.1037: the same undeclared-dependency class that
      // 0.13.1026 had just fixed three edges of, reintroduced by the fix.
      // Declaring it is safe — it is a forward 5→6 edge, not the other half of
      // a cycle. The cycle the split removed was `qa-and-training -> ocs`, and
      // no `ocs`-phase producer consumes a Phase 6 artifact any more.
      'ocs-knowledge-refresh',
    ],
    phase: 'ocs',
    required: true,
    description: 'OCS chatbot config: experiment_id, public_id, embed_key, collection_id',
  },
  {
    path: '5-ocs/ocs-setup_widget-handoff.md',
    producedBy: 'ocs-setup',
    role: 'widget-handoff',
    consumedBy: [
      'llo-onboarding',
      'ocs-widget-handoff-eval',
      // Phase 6 reads widget_url for the "where to ask questions" link. These
      // three edges were missing until 0.13.1026, which mattered: without them
      // the declared graph showed only qa-and-training -> ocs (the training docs
      // feeding the RAG collection), so the OCS/training relationship read as a
      // one-way ORDERING mistake that a reorder could fix. It is a CYCLE, and a
      // reorder just breaks the other direction — the guides get a dead
      // "ask questions here" link. See DECLARED_CYCLES in
      // test/lib/artifact-cycles.test.ts.
      'training-llo-guide',
      'training-onboarding-email',
      'training-deck-generate',
    ],
    phase: 'ocs',
    required: true,
    description: 'Operator-facing handoff doc: creds + paste instructions for the Connect opportunity widget (until update_opportunity API lands). Also the source of widget_url for the Phase 6 training docs.',
  },
  {
    path: '5-ocs/ocs-chatbot-qa_transcript-quick.md',
    producedBy: 'ocs-chatbot-qa',
    role: 'transcript',
    consumedBy: ['ocs-chatbot-eval'],
    phase: 'ocs',
    required: false,
    description: 'Transcript from the --quick suite (3 smoke prompts): each entry has prompt + response + cited_files + expected_answer_summary + structural-pass flag. Input to ocs-chatbot-eval --quick',
  },
  {
    path: '5-ocs/ocs-chatbot-qa_transcript-deep.md',
    producedBy: 'ocs-chatbot-qa',
    role: 'transcript',
    consumedBy: ['ocs-chatbot-eval'],
    phase: 'ocs',
    required: false,
    description: 'Transcript from the --deep suite (Connect-general + ACE-specific + opp-specific + edge cases): structured transcript input to ocs-chatbot-eval --deep. Required to be fresh and passing for go-live; absent if /ace:qa-deep has not been run.',
  },
  {
    path: '5-ocs/ocs-chatbot-eval_verdict-quick.yaml',
    producedBy: 'ocs-chatbot-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'ocs',
    required: false,
    description: 'Machine-readable verdict from --quick LLM-as-Judge grading: overall_score, per-dimension scores, per-prompt verdicts, gate disposition. Shape matches skills/README.md § QA vs Eval',
  },
  {
    path: '5-ocs/ocs-chatbot-eval_verdict-deep.yaml',
    producedBy: 'ocs-chatbot-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'ocs',
    required: false,
    description: 'Machine-readable verdict from --deep LLM-as-Judge grading; read by opp-eval for cross-skill aggregation. Required to be fresh and passing for go-live; absent if /ace:qa-deep has not been run.',
  },
  {
    path: '5-ocs/ocs-chatbot-eval_report-deep.md',
    producedBy: 'ocs-chatbot-eval',
    role: 'report',
    consumedBy: [],
    phase: 'ocs',
    required: false,
    description: 'Human-readable eval report from the Phase 5 --deep gate. Complements the machine-readable verdict YAML.',
  },
  {
    path: '5-ocs/ocs-widget-handoff-eval_verdict.yaml',
    producedBy: 'ocs-widget-handoff-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'ocs',
    required: true,
    description: 'Per-skill -eval verdict for ocs-widget-handoff: widget URL correctness, embed key staging, opportunity-binding completeness, HITL operator handoff hygiene. Filename uses the eval skill (ocs-widget-handoff-eval) rather than the agent name (ocs-agent-setup) — see 0.12.0 Option-α naming rule.',
  },
  {
    path: '5-ocs/ocs-agent-setup_dry-run-log.md',
    producedBy: 'ocs-agent-setup',
    role: 'dry-run-log',
    consumedBy: [],
    phase: 'ocs',
    required: false,
    description: 'Log of every MCP atom call ocs-agent-setup would issue when invoked with --dry-run. Companion to ocs-agent-setup.md from real runs; surfaced for operator review before a live run.',
  },
  {
    path: '5-ocs/ocs-setup_summary.md',
    producedBy: 'ocs-setup',
    role: 'summary',
    consumedBy: [],
    phase: 'ocs',
    required: true,
    description: 'Phase 5 (ocs-setup) end-of-phase summary written by the ocs-setup subagent. Captures chatbot config (experiment_id, embed key), publish status, and gate disposition handed back to the orchestrator.',
  },

  // ── Phase 3 CCZ structural QA (app-release-qa) ────────────────
  // AVD-free verification of released CCZ structural + install-time
  // integrity at the end of Phase 3. Catches CCZ-marker drops, form-
  // count drift vs. Nova blueprint, XForm parse errors, and
  // commcare-cli `play` install-time XPath binding failures — without
  // the Phase 4 / Connect-state dependency that forced us to revert
  // the prior "move app-screenshot-capture to Phase 3" attempt. Live
  // AVD smoke (`app-screenshot-capture`) stays in Phase 6 where
  // Connect opp + ACE-test-user invite are available. Renamed from
  // `app-release-smoke` 2026-05-27 — "smoke" understated the role;
  // this IS the structural QA partner for `app-release`.
  {
    path: '3-commcare/app-release-qa_result.yaml',
    producedBy: 'app-release-qa',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'commcare',
    required: true,
    description: 'Structural + install-time QA verdict from app-release-qa: download released Learn + Deliver CCZs, parse, verify form counts and Connect-marker presence match Nova blueprints, run commcare-cli validate + play install-time gates. Halts loud on mismatch. No AVD, no Connect dependency — purely CCHQ-side.',
  },

  // ── Phase 3 HQ-layer standing-instruction apply-step ──────────
  // Applies the two settings Nova can't set at build time — camera-only
  // photo capture (appearance="acquire" on Deliver image uploads, #867)
  // and grid menu display per module (both apps) — to the deployed CCHQ
  // draft apps, BETWEEN app-deploy and app-release. Resolves the
  // matching phases.commcare-setup.residuals[] entries. Draft mutations
  // only; app-release ships them, app-release-qa backstops them.
  {
    path: '3-commcare/app-hq-settings_summary.md',
    producedBy: 'app-hq-settings',
    role: 'summary',
    consumedBy: ['opp-eval'],
    phase: 'commcare',
    required: false,
    description: 'Per-app record of the HQ-layer standing-instruction settings applied to the deployed draft apps by app-hq-settings: Deliver image <upload>s patched to appearance="acquire" (#867), modules set to grid menu display, and the camera-only + grid residuals resolved. Optional (not gate-required); app-release ships the settings and app-release-qa re-verifies them from the released CCZ.',
  },

  // app-media-coverage (Phase 3 Step 1.7) attaches media IN THE NOVA
  // BLUEPRINT, before app-deploy — so it survives a rebuild and travels to
  // HQ inside the ordinary upload. Optional: images improve the worker
  // experience but nothing downstream gates on them.
  {
    path: '3-commcare/app-media-coverage_report.md',
    producedBy: 'app-media-coverage',
    role: 'summary',
    consumedBy: ['opp-eval'],
    phase: 'commcare',
    required: false,
    description:
      'Per-app record of the media attached to the Learn and Deliver apps: which images came from the opp\'s inputs/media/ folder, which built-in CommCare menu icons were applied, and which were generated by the Content Generator — each with the field, option, or tile it landed on and why. Also lists supplied files left unused, inputs CommCare cannot ingest, and any conflict between the operator guidance document and the built app. Optional (not gate-required).',
  },
  {
    path: '3-commcare/app-media-coverage_plan-learn.yaml',
    producedBy: 'app-media-coverage',
    role: 'manifest',
    consumedBy: ['app-media-coverage'],
    phase: 'commcare',
    required: false,
    description:
      'The media plan for the Learn app, validated by lib/media-plan.ts: one row per intended attachment (field slot, select option, module or form tile, app logo) with its source, rationale, and an operator_override slot. Re-read rather than rebuilt on a re-run, so operator hand-edits win.',
  },
  {
    path: '3-commcare/app-media-coverage_plan-deliver.yaml',
    producedBy: 'app-media-coverage',
    role: 'manifest',
    consumedBy: ['app-media-coverage'],
    phase: 'commcare',
    required: false,
    description:
      'The media plan for the Deliver app. Same shape and semantics as the Learn plan.',
  },

  // ── QA + Training phase (Phase 6) ──────────────────────────────
  {
    path: '6-qa-and-training/app-screenshot-capture_manifest.yaml',
    producedBy: 'app-screenshot-capture',
    role: 'manifest',
    consumedBy: ['training-flw-guide', 'training-deck-generate', 'app-ux-eval'],
    phase: 'qa-and-training',
    required: false,
    description: 'Manifest of every captured screenshot with step labels and Drive paths.',
  },
  {
    path: '6-qa-and-training/app-screenshot-capture_verdict-shallow.yaml',
    producedBy: 'app-screenshot-capture',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'qa-and-training',
    required: true,
    description: 'Shallow smoke verdict from /ace:run Phase 6 — smoke recipe pass/fail + thin UX judge ≥ 2/3 per app. Always present after a successful /ace:run.',
  },
  {
    path: '6-qa-and-training/app-screenshot-capture_verdict.yaml',
    producedBy: 'app-screenshot-capture',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'qa-and-training',
    required: true,
    description: 'Structural verdict from app-screenshot-capture: smoke recipe pass/fail status + screenshot capture integrity. Always present after a successful Phase 6 run.',
  },
  {
    path: '6-qa-and-training/app-ux-eval_verdict-deep.yaml',
    producedBy: 'app-ux-eval',
    role: 'verdict',
    consumedBy: ['llo-launch', 'opp-eval'],
    phase: 'qa-and-training',
    required: false,
    description: 'Machine-readable verdict from app-ux-eval (deep). Read by llo-launch (Phase 9 activation gate) for freshness check vs. latest released CommCare build, and by opp-eval for cross-skill aggregation. Required to be fresh and passing for go-live; absent if /ace:qa-deep has not been run.',
  },

  {
    path: '6-qa-and-training/training-llo-guide.md',
    producedBy: 'training-llo-guide',
    consumedBy: ['llo-onboarding', 'ocs-knowledge-refresh', 'training-onboarding-email'],
    phase: 'qa-and-training',
    required: true,
    // Step-2 training artifact: its producer consumes the OCS chatbot URL, so
    // it cannot exist when Phase 5 was skipped (ace#1069).
    notRequiredInModes: ['app-QA-only'],
    rendered: true,
    sourcePersisted: true,
    illustrated: true,
    recipientFacing: true,
    shareRole: 'commenter',
    description: 'LLO Manager guide for overseeing FLW deployment',
  },
  {
    path: '6-qa-and-training/training-llo-guide.source.md',
    producedBy: 'training-llo-guide',
    consumedBy: ['run-surface-audit'],
    phase: 'qa-and-training',
    // Never required: making it so would retroactively fail every run that
    // completed before ace#1687 shipped. verify_phase_artifacts counts it
    // under optional_present_count.
    required: false,
    description: 'Verbatim markdown `training-llo-guide.md` was composed from, stored as a plain text/markdown file for the DOC-FIDELITY-UNVERIFIED diff (ace#1687). Optional by contract.',
  },
  {
    path: '6-qa-and-training/training-flw-guide.md',
    producedBy: 'training-flw-guide',
    consumedBy: ['llo-onboarding', 'ocs-knowledge-refresh', 'training-onboarding-email'],
    phase: 'qa-and-training',
    required: true,
    // Step-2 training artifact: its producer consumes the OCS chatbot URL, so
    // it cannot exist when Phase 5 was skipped (ace#1069).
    notRequiredInModes: ['app-QA-only'],
    rendered: true,
    sourcePersisted: true,
    illustrated: true,
    recipientFacing: true,
    shareRole: 'commenter',
    description: 'Step-by-step FLW training guide for app usage and protocols',
  },
  {
    path: '6-qa-and-training/training-flw-guide.source.md',
    producedBy: 'training-flw-guide',
    consumedBy: ['run-surface-audit'],
    phase: 'qa-and-training',
    // Never required: making it so would retroactively fail every run that
    // completed before ace#1687 shipped. verify_phase_artifacts counts it
    // under optional_present_count.
    required: false,
    description: 'Verbatim markdown `training-flw-guide.md` was composed from, stored as a plain text/markdown file for the DOC-FIDELITY-UNVERIFIED diff (ace#1687). The illustrated guide that lost 44 screenshots and 224 words is the regression this makes checkable. Optional by contract.',
  },
  {
    path: '6-qa-and-training/training-quick-reference.md',
    producedBy: 'training-quick-reference',
    consumedBy: ['llo-onboarding', 'ocs-knowledge-refresh', 'training-onboarding-email'],
    phase: 'qa-and-training',
    required: true,
    // Step-2 training artifact: its producer consumes the OCS chatbot URL, so
    // it cannot exist when Phase 5 was skipped (ace#1069).
    notRequiredInModes: ['app-QA-only'],
    rendered: true,
    sourcePersisted: true,
    recipientFacing: true,
    shareRole: 'commenter',
    description: 'One-page laminated pocket card for FLWs in the field',
  },
  {
    path: '6-qa-and-training/training-quick-reference.source.md',
    producedBy: 'training-quick-reference',
    consumedBy: ['run-surface-audit'],
    phase: 'qa-and-training',
    // Never required: making it so would retroactively fail every run that
    // completed before ace#1687 shipped. verify_phase_artifacts counts it
    // under optional_present_count.
    required: false,
    description: 'Verbatim markdown `training-quick-reference.md` was composed from, stored as a plain text/markdown file for the DOC-FIDELITY-UNVERIFIED diff (ace#1687). Optional by contract.',
  },
  {
    path: '6-qa-and-training/ocs-knowledge-refresh.md',
    producedBy: 'ocs-knowledge-refresh',
    consumedBy: ['opp-eval'],
    phase: 'qa-and-training',
    // `required: true` since 0.13.1037. It was optional, while its own
    // description said its absence means the chatbot never got the training
    // documents — so `verify_phase_artifacts` could not flag the exact thing
    // the artifact exists to signal. The original defect WAS a step nobody
    // ran; the skill's own [BLOCKER] on zero-uploaded only fires once the
    // skill has started. A skipped Phase 5 is not an exception: the skill
    // still writes this file with `status: skipped` and the reason.
    required: true,
    // Same carve-out as its sibling training artifacts: an app-QA-only run
    // has no Phase 5 chatbot to refresh (ace#1069).
    notRequiredInModes: ['app-QA-only'],
    description: "Record of the Phase 6 knowledge-base refresh: which training documents were uploaded into the chatbot's RAG collection, the resulting file count, and the published version_number. Absent on a completed Phase 6 means the chatbot never received the training documents.",
  },
  {
    path: '6-qa-and-training/training-faq.md',
    producedBy: 'training-faq',
    consumedBy: ['llo-onboarding', 'ocs-knowledge-refresh'],
    phase: 'qa-and-training',
    required: true,
    // Step-2 training artifact: its producer consumes the OCS chatbot URL, so
    // it cannot exist when Phase 5 was skipped (ace#1069).
    notRequiredInModes: ['app-QA-only'],
    rendered: true,
    sourcePersisted: true,
    recipientFacing: true,
    shareRole: 'commenter',
    description: 'Frequently asked questions for LLOs and FLWs',
  },
  {
    path: '6-qa-and-training/training-faq.source.md',
    producedBy: 'training-faq',
    consumedBy: ['run-surface-audit'],
    phase: 'qa-and-training',
    // Never required: making it so would retroactively fail every run that
    // completed before ace#1687 shipped. verify_phase_artifacts counts it
    // under optional_present_count.
    required: false,
    description: 'Verbatim markdown `training-faq.md` was composed from, stored as a plain text/markdown file for the DOC-FIDELITY-UNVERIFIED diff (ace#1687). Optional by contract.',
  },
  {
    path: '6-qa-and-training/training-onboarding-email.md',
    producedBy: 'training-onboarding-email',
    consumedBy: ['llo-onboarding'],
    phase: 'qa-and-training',
    required: true,
    // Step-2 training artifact: its producer consumes the OCS chatbot URL, so
    // it cannot exist when Phase 5 was skipped (ace#1069).
    notRequiredInModes: ['app-QA-only'],
    rendered: true,
    sourcePersisted: true,
    recipientFacing: true,
    shareRole: 'commenter',
    description: 'LLO onboarding email template authored in Phase 6 and sent by Phase 9 (execution-manager) llo-onboarding, with {{LLO_NAME}}/{{LLO_FIRST_NAME}}/{{LLO_ORG}} tokens',
  },
  {
    path: '6-qa-and-training/training-onboarding-email.source.md',
    producedBy: 'training-onboarding-email',
    consumedBy: ['run-surface-audit'],
    phase: 'qa-and-training',
    // Never required: making it so would retroactively fail every run that
    // completed before ace#1687 shipped. verify_phase_artifacts counts it
    // under optional_present_count.
    required: false,
    description: 'Verbatim markdown `training-onboarding-email.md` was composed from, stored as a plain text/markdown file for the DOC-FIDELITY-UNVERIFIED diff (ace#1687). Optional by contract.',
  },
  {
    path: '6-qa-and-training/training-deck-spec.yaml',
    producedBy: 'training-deck-generate',
    consumedBy: ['training-deck-render'],
    phase: 'qa-and-training',
    required: false,
    description: 'YAML spec for the training deck. Validated by Zod schema in `lib/training-deck-spec.ts`. Rendered to Google Slides by `training-deck-render`.',
  },
  {
    path: '6-qa-and-training/training-deck-render_verdict.yaml',
    producedBy: 'training-deck-render',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'qa-and-training',
    required: false,
    description: 'Self-emitted verdict from training-deck-render — slide count, image resolution, API success.',
  },
  {
    path: '6-qa-and-training/training-deck-generate-eval_verdict.yaml',
    producedBy: 'training-deck-generate-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'qa-and-training',
    required: true,
    // Step-2 training artifact: its producer consumes the OCS chatbot URL, so
    // it cannot exist when Phase 5 was skipped (ace#1069).
    notRequiredInModes: ['app-QA-only'],
    description: 'Companion-eval verdict for training-deck-generate. Grades module coverage, content concreteness, image ref validity, slide count.',
  },
  {
    path: '6-qa-and-training/training-faq-eval_verdict.yaml',
    producedBy: 'training-faq-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'qa-and-training',
    required: true,
    // Step-2 training artifact: its producer consumes the OCS chatbot URL, so
    // it cannot exist when Phase 5 was skipped (ace#1069).
    notRequiredInModes: ['app-QA-only'],
    description: 'Companion-eval verdict from `training-faq-eval`. Grades comprehensiveness, accuracy, scannability, field realism, anticipated-question depth.',
  },
  {
    path: '6-qa-and-training/training-flw-guide-eval_verdict.yaml',
    producedBy: 'training-flw-guide-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'qa-and-training',
    required: true,
    // Step-2 training artifact: its producer consumes the OCS chatbot URL, so
    // it cannot exist when Phase 5 was skipped (ace#1069).
    notRequiredInModes: ['app-QA-only'],
    description: 'Companion-eval verdict from `training-flw-guide-eval`. Grades step concreteness, screenshot completeness, language accessibility (BLOCKER on wrong language), error recovery, flow ordering.',
  },
  {
    path: '6-qa-and-training/training-llo-guide-eval_verdict.yaml',
    producedBy: 'training-llo-guide-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'qa-and-training',
    required: true,
    // Step-2 training artifact: its producer consumes the OCS chatbot URL, so
    // it cannot exist when Phase 5 was skipped (ace#1069).
    notRequiredInModes: ['app-QA-only'],
    description: 'Companion-eval verdict from `training-llo-guide-eval`. Grades operational completeness, action-orientation, screenshot grounding, cap-threshold accuracy, escalation-pathway clarity.',
  },
  {
    path: '6-qa-and-training/training-onboarding-email-eval_verdict.yaml',
    producedBy: 'training-onboarding-email-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'qa-and-training',
    required: true,
    // Step-2 training artifact: its producer consumes the OCS chatbot URL, so
    // it cannot exist when Phase 5 was skipped (ace#1069).
    notRequiredInModes: ['app-QA-only'],
    description: 'Companion-eval verdict from `training-onboarding-email-eval`. Grades warmth, clarity, call-to-action effectiveness, context fidelity, length discipline.',
  },
  {
    path: '6-qa-and-training/training-quick-reference-eval_verdict.yaml',
    producedBy: 'training-quick-reference-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'qa-and-training',
    required: true,
    // Step-2 training artifact: its producer consumes the OCS chatbot URL, so
    // it cannot exist when Phase 5 was skipped (ace#1069).
    notRequiredInModes: ['app-QA-only'],
    description: 'Companion-eval verdict from `training-quick-reference-eval`. Grades scannability, key-number coverage, numeric accuracy, printability, glance-priority ordering.',
  },

  // ── Synthetic Data and Workflows phase (Phase 7) ───────────────
  // CONVERGED (Plan C, 2026-07-21): Phase 7 is the `ace-run` provider of the
  // same pipeline `/ace:demo` uses — `demo-data-setup` → `demo-narrative` →
  // canopy DDD. The REQUIRED set below is that pipeline's output. The Plan B
  // chain (synthetic-narrative-plan → … → synthetic-summary) remains declared
  // beneath it as a deprecated fallback, all `required: false`, until those
  // skills are deleted from disk.
  //
  // Only fixed-name paths may be `required: true` — `diffArtifacts` does exact
  // matching (modulo the doc-extension tolerance), so any path carrying a
  // `<placeholder>` segment can never satisfy a required entry.

  {
    path: '7-synthetic/realized.json',
    producedBy: 'demo-data-setup',
    role: 'manifest',
    consumedBy: ['demo-narrative', 'demo-data-setup-qa'],
    phase: 'synthetic-data-and-workflows',
    required: true,
    description:
      'THE handoff between the two halves of the phase: a FLAT JSON map of `${var}` → live labs dashboard URL. Carries `primary_par_url` plus one `<key>_par_url` per dashboard, each a `/labs/workflow/<def>/run/?run_id=<id>&opportunity_id=<opp>` deep-link. DDD substitutes these verbatim into scene URLs, so it must stay flat — a nested value renders a literal `${…}` into the filmed page.',
  },
  {
    path: '7-synthetic/demo-data-setup_manifest.yaml',
    producedBy: 'demo-data-setup',
    role: 'manifest',
    consumedBy: ['demo-narrative', 'demo-data-setup-qa'],
    phase: 'synthetic-data-and-workflows',
    required: true,
    description:
      'The generation contract for the synthetic dataset: pinned timeline anchor, FLW personas, outcome/field model keyed on the real deliver-app form paths, and the realised totals. Under the `ace-run` provider this is derived from the run\'s own PDD + built apps, not from a free-text brief.',
  },
  {
    path: '7-synthetic/branch-scrub_report.yaml',
    producedBy: 'demo-data-setup',
    role: 'qa-result',
    consumedBy: ['demo-data-setup-qa'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description:
      "Step 2c's ledger for the dataset's own legality: the DatasetSpec derived from the deliver app (every question's `relevant` / `constraint`), every expression the derivation could NOT read (`unparsed[]` — a gate this run did not audit), the branch scrub that removed the off-branch values the labs manifest has no primitive to avoid, and `auditDataset` over the records as they now stand. Optional because the `denovo` provider has no deliver app to derive from; when it is absent, `demo-data-setup-qa` check 9 requires a stated reason rather than accepting a hand-declared spec (ace#1658).",
  },
  {
    path: '7-synthetic/demo-data-setup-qa_result.yaml',
    producedBy: 'demo-data-setup-qa',
    role: 'qa-result',
    consumedBy: ['opp-eval'],
    phase: 'synthetic-data-and-workflows',
    required: true,
    description:
      'Structural gate on the handoff, run BEFORE `demo-narrative` authors scenes against it: realized.json parses and is flat, every `<key>_par_url` is a real run deep-link (not the run picker or the definition page), planned dashboards match the realized map, the opp is labs-only (id ≥ 10000), the timeline is a pinned Monday, and deliver units were captured. A dead dashboard must not reach a stakeholder.',
  },
  {
    path: '7-synthetic/why_brief.yaml',
    producedBy: 'demo-narrative',
    consumedBy: ['synthetic-data-and-workflows'],
    phase: 'synthetic-data-and-workflows',
    required: true,
    description:
      'canopy DDD `WhyBrief`: the problem statement, a grounded `spine[]` (each claim carrying non-assumed evidence), and typed `gaps[]` (RESEARCH / CAPABILITY / DECISION) for everything the demo cannot honestly assert. Gated by canopy `scripts.ddd.validate why_brief`.',
  },
  {
    path: '7-synthetic/<narrative-slug>.yaml',
    producedBy: 'demo-narrative',
    consumedBy: ['synthetic-data-and-workflows'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description:
      'canopy DDD `UnifiedSpec` — personas, scenes on `${…_par_url}`, per-scene `concept_claim` + `provenance` + `features[]` + scripted `actions[]`. Named for the narrative slug, so it cannot be a fixed-path required entry. Gated by canopy `scripts.ddd.validate unified_spec`, `spec_qa`, and `narrative_coherence`.',
  },
  {
    path: '7-synthetic/walkthroughs/walkthrough.mp4',
    producedBy: 'synthetic-data-and-workflows',
    consumedBy: [],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description:
      'The rendered walkthrough, filmed against the LIVE labs dashboards. Optional because canopy\'s webm→mp4 conversion is a known-flaky render-infra step — the per-scene frames under `walkthrough-frames/` are the documented fallback deliverable.',
  },
  {
    path: '7-synthetic/walkthroughs/scene_<N>_<slug>.png',
    producedBy: 'synthetic-data-and-workflows',
    consumedBy: [],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description:
      'One full-page frame per scene, captured from the live dashboard during the render. The fallback deliverable when mp4 conversion fails, and the input the DDD concept/visual judges score.',
  },
  {
    path: '7-synthetic/synthetic-data-and-workflows_summary.md',
    producedBy: 'synthetic-data-and-workflows',
    role: 'summary',
    consumedBy: [],
    phase: 'synthetic-data-and-workflows',
    required: true,
    description:
      'Phase summary a Dimagi staffer forwards to a stakeholder: the live dashboard URLs, what the dataset is, which controls the platform actually enforces versus what only export-side analysis can catch, the metrics computed live, every placeholder stated as a placeholder, and the phase\'s own known gaps.',
  },

  // ── DEPRECATED (Plan B chain, superseded by Plan C above) ──────
  // Retained so the fallback path still resolves while the retired skills
  // remain on disk. All `required: false` — a converged Phase 7 run produces
  // none of them, and requiring them fails `verify_phase_artifacts` on an
  // otherwise-complete phase.

  {
    path: '7-synthetic/synthetic-narrative-plan.md',
    producedBy: 'synthetic-narrative-plan',
    consumedBy: ['synthetic-data-generate', 'synthetic-walkthrough-spec', 'synthetic-summary', 'synthetic-narrative-plan-eval', 'synthetic-workflow-polish-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'Human-readable narrative explaining the synthetic-data story (cast, anomalies, week-by-week arc). Companion to the manifest YAML.',
  },
  {
    path: '7-synthetic/synthetic-narrative-plan.yaml',
    producedBy: 'synthetic-narrative-plan',
    role: 'manifest',
    consumedBy: ['synthetic-data-generate', 'synthetic-workflow-seed', 'synthetic-walkthrough-spec', 'synthetic-summary', 'synthetic-narrative-plan-eval', 'synthetic-data-generate-eval', 'synthetic-workflow-seed-eval', 'synthetic-workflow-polish-eval', 'synthetic-walkthrough-spec-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'Richer manifest authored from PDD + journeys + connect setup: named FLW personas, deliberate anomalies, coaching arcs, KPI thresholds. Schema identical to synthetic-data-generate_manifest.yaml.',
  },
  {
    path: '7-synthetic/synthetic-data-generate_manifest.yaml',
    producedBy: 'synthetic-data-generate',
    role: 'manifest',
    consumedBy: ['synthetic-summary', 'synthetic-data-generate-eval', 'synthetic-workflow-seed-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'Stage 1 default manifest (5 FLWs, 4-week timeline, no anomalies) — used when `synthetic-narrative-plan.yaml` is absent. Sent verbatim to labs `synthetic_generate_from_manifest`.',
  },
  {
    path: '7-synthetic/synthetic-data-generate.md',
    producedBy: 'synthetic-data-generate',
    consumedBy: ['synthetic-walkthrough-spec', 'synthetic-summary', 'synthetic-data-generate-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'Run summary: labs opp_id, fixture folder URL, record counts, form_schema_questions, payment-unit pre-flight + share-gap warnings, labs URL.',
  },
  {
    path: '7-synthetic/synthetic-workflow-seed.md',
    producedBy: 'synthetic-workflow-seed',
    consumedBy: ['synthetic-workflow-polish', 'synthetic-walkthrough-spec', 'synthetic-summary', 'synthetic-workflow-seed-eval', 'synthetic-workflow-polish-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'Run summary: workflow_ids (llo_weekly_review + program_admin_audit), pipeline_id, KPI count, coaching-task IDs, scaffold_unsuitable flag, saved-runs Week-1/Week-2 run_ids + snapshot timestamps (Stage 3b).',
  },
  {
    path: '7-synthetic/synthetic-workflow-polish.md',
    producedBy: 'synthetic-workflow-polish',
    consumedBy: ['synthetic-summary', 'synthetic-workflow-polish-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'Run summary: per-workflow patches applied (intent label per patch), final render_code_versions, smoke-render result, L2-rewrite flag.',
  },
  {
    path: '7-synthetic/synthetic-walkthrough-spec_<persona>.yaml',
    producedBy: 'synthetic-walkthrough-spec',
    consumedBy: ['synthetic-walkthrough-run', 'synthetic-walkthrough-spec-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'Per-persona canopy:walkthrough spec — ordered scenes (URL hint, show, impressive_because, ai_quality). One file per canned + opp-overlay persona.',
  },
  {
    path: '7-synthetic/walkthroughs/<persona>-<timestamp>/slideshow.html',
    producedBy: 'synthetic-walkthrough-run',
    consumedBy: ['synthetic-summary'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'HTML deck produced by canopy:walkthrough — scored screenshots, narration, AI evaluations. New timestamped folder per persona run; opp.yaml.synthetic.walkthroughs[] tracks history.',
  },
  {
    path: '7-synthetic/walkthroughs/<persona>-<timestamp>/eval.json',
    producedBy: 'synthetic-walkthrough-run',
    consumedBy: ['synthetic-summary'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'canopy:walkthrough sidecar with per-scene scores (5 dimensions per scene from canopy:visual-judge dispatch). Sibling of slideshow.html in the same timestamped persona folder. synthetic-summary aggregates eval scores into the persona row.',
  },
  {
    path: '7-synthetic/synthetic-summary.md',
    producedBy: 'synthetic-summary',
    role: 'summary',
    consumedBy: [],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'One-page reviewer-facing summary a Dimagi staffer forwards to a stakeholder. Labs URL + workflow URLs + per-persona slideshow links + 3-paragraph narrative.',
  },

  // Phase 7 eval verdicts (Stage 4 of Plan B).
  {
    path: '7-synthetic/synthetic-narrative-plan-eval_verdict.yaml',
    producedBy: 'synthetic-narrative-plan-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false, // deprecated (Plan B) — the converged Phase 7 does not run this skill
    description: 'LLM-as-Judge verdict on the narrative plan: PDD anchoring, cast realism, anomaly+coaching coherence, manifest schema validity, stakeholder narrative quality.',
  },
  {
    path: '7-synthetic/synthetic-narrative-plan-qa_result.yaml',
    producedBy: 'synthetic-narrative-plan-qa',
    role: 'qa-result',
    consumedBy: ['opp-eval', 'synthetic-narrative-plan-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'Static structural-correctness check on synthetic-narrative-plan.yaml. 8 checks via Zod (`ManifestZ`): YAML parse, required keys, FLW personas well-formed, KPI field-paths resolvable, anomalies traceable, coaching-arcs match personas, random_seed present, timeline dates consistent. Gates the eval — eval skipped if QA fails irrecoverably.',
  },
  {
    path: '7-synthetic/synthetic-walkthrough-spec_<persona>-qa_result.yaml',
    producedBy: 'synthetic-walkthrough-spec-qa',
    role: 'qa-result',
    consumedBy: ['opp-eval', 'synthetic-walkthrough-spec-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'Per-persona static structural-correctness check on the walkthrough spec. 7 checks via Zod (`SpecZ`) mirroring canopy:walkthrough boundary: YAML parse, required top-level keys, ≥4 scenes, scene personas resolvable, ai_quality assertions falsifiable, persona pain-points (intro) documented, scene titles unique.',
  },
  {
    path: '7-synthetic/synthetic-summary-eval_verdict.yaml',
    producedBy: 'synthetic-summary-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'LLM-as-Judge verdict on the synthetic-summary handoff: stakeholder readiness, narrative coherence, completeness (labs URL + fixture folder + per-persona slideshow links resolve), source fidelity, what\'s-next clarity. Hard-deduct triggers cover broken URLs, placeholder tokens, empty-but-promised sections.',
  },
  {
    path: '7-synthetic/synthetic-data-generate-eval_verdict.yaml',
    producedBy: 'synthetic-data-generate-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false, // deprecated (Plan B) — the converged Phase 7 does not run this skill
    description: 'LLM-as-Judge verdict on the data-generate run: record-count health, form schema coverage, warning honesty, manifest provenance, operator next steps.',
  },
  {
    path: '7-synthetic/synthetic-workflow-seed-eval_verdict.yaml',
    producedBy: 'synthetic-workflow-seed-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false, // deprecated (Plan B) — the converged Phase 7 does not run this skill
    description: 'LLM-as-Judge verdict on workflow seeding: workflow wiring, KPI population, coaching-task creation, aggregation-mapping honesty, saved-runs deferral honesty.',
  },
  {
    path: '7-synthetic/synthetic-workflow-polish-eval_verdict.yaml',
    producedBy: 'synthetic-workflow-polish-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false, // deprecated (Plan B) — the converged Phase 7 does not run this skill
    description: 'LLM-as-Judge verdict on workflow polish: narrative-data coherence, patch quality, smoke-render success, domain-language fit, mode honesty. Strictest gate (threshold 7.5) — polish is the headline.',
  },
  {
    path: '7-synthetic/synthetic-walkthrough-spec-eval_verdict_<persona>.yaml',
    producedBy: 'synthetic-walkthrough-spec-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'synthetic-data-and-workflows',
    required: false,
    description: 'LLM-as-Judge verdict per persona spec: persona-priority coverage, wow_moment specificity, ai_quality falsifiability, anomaly-to-scene mapping, turn-off avoidance.',
  },

  // ── Solicitation Management phase (Phase 8) ────────────────────
  // New in 0.12.0; renumbered + rerooted into 8-solicitation-management/ in 0.13.5x.

  {
    path: '8-solicitation-management/solicitation-create_draft.md',
    producedBy: 'solicitation-create',
    role: 'draft',
    consumedBy: ['solicitation-create-eval'],
    phase: 'solicitation-management',
    required: false,
    description: 'Solicitation payload pre-publish: title, type, scope, criteria, response template, deadline. Audit trail for what solicitation-create proposed before posting to labs.',
  },
  {
    path: '8-solicitation-management/solicitation-create_published.md',
    producedBy: 'solicitation-create',
    role: 'published',
    consumedBy: ['solicitation-monitor', 'solicitation-review', 'solicitation-create-eval', 'llo-invite'],
    phase: 'solicitation-management',
    // required: the ONLY local record of the published rubric. `solicitation-review`
    // (the human-gated award path) and `solicitation-create-eval` (itself a required
    // artifact) both read it. As `required: false` the Phase 8 fence returned ok on a
    // run that published to labs but never wrote the snapshot, and the miss surfaced
    // days later at `/ace:step solicitation-review`. dimagi-internal/ace#1865.
    required: true,
    description: 'Snapshot of the published solicitation: solicitation_id, public_url, manage_url, deadline, criteria. Read by every downstream Phase 7 skill and by llo-invite for the URL to email.',
  },
  {
    path: '8-solicitation-management/llo-invite_invitations.md',
    producedBy: 'llo-invite',
    role: 'invitations',
    consumedBy: ['solicitation-monitor', 'solicitation-review-eval'],
    phase: 'solicitation-management',
    required: false,
    description: 'Per-recipient log: who got emailed the solicitation URL, when, and send status. Empty when PDD has no preferred_llos (long-term solicitation flow).',
  },
  {
    path: '8-solicitation-management/solicitation-monitor_responses/',
    producedBy: 'solicitation-monitor',
    consumedBy: ['solicitation-review'],
    phase: 'solicitation-management',
    required: false,
    description: 'One file per solicitation response, written incrementally as responses arrive. Each file contains the response content plus metadata returned by labs.',
  },
  {
    path: '8-solicitation-management/solicitation-review_scoring-rubric.md',
    producedBy: 'solicitation-review',
    role: 'scoring-rubric',
    consumedBy: ['solicitation-review-eval'],
    phase: 'solicitation-management',
    required: false,
    description: 'Per-response, per-criterion scores produced by solicitation-review.',
  },
  {
    path: '8-solicitation-management/solicitation-review-qa_result.yaml',
    producedBy: 'solicitation-review-qa',
    role: 'qa-result',
    consumedBy: ['opp-eval', 'solicitation-review-eval'],
    phase: 'solicitation-management',
    required: false,
    description: 'Static structural-correctness check on the awardee recommendation. 8 checks: recommendation section, named awardee, substantive reasoning, all-responses scored, criteria-coverage table, scoring-table well-formed, tie-break resolved (when top-two gap <0.5), `no_award_action_yet` (load-bearing — QA must run BEFORE the HITL gate calls `award_response`).',
  },
  {
    path: '8-solicitation-management/solicitation-review_recommendation.md',
    producedBy: 'solicitation-review',
    role: 'recommendation',
    consumedBy: ['solicitation-review-eval'],
    phase: 'solicitation-management',
    required: false,
    description: 'Ranked candidates + reasoning. Input to the HITL gate before award_response is called.',
  },
  {
    path: '8-solicitation-management/solicitation-review_award-record.md',
    producedBy: 'solicitation-review',
    role: 'award-record',
    consumedBy: ['solicitation-review-eval', 'opp-closeout'],
    phase: 'solicitation-management',
    required: false,
    description: 'Written when award_response is called (success or failure). Includes response_id, awarded_at, awarded_org_slug, and any error envelope on failure.',
  },
  {
    path: '8-solicitation-management/solicitation-create-eval_verdict.yaml',
    producedBy: 'solicitation-create-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'solicitation-management',
    required: true,
    description: 'Per-skill -eval verdict for solicitation-create: PDD-fidelity, criteria coverage, deadline plausibility, response-template clarity.',
  },
  {
    path: '8-solicitation-management/solicitation-review-eval_verdict.yaml',
    producedBy: 'solicitation-review-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'solicitation-management',
    required: false,
    description: 'Per-skill -eval verdict for solicitation-review: scoring rigor, recommendation justification, alignment with award outcome.',
  },
  {
    path: '8-solicitation-management/solicitation-management_summary.md',
    producedBy: 'solicitation-management',
    role: 'summary',
    consumedBy: [],
    phase: 'solicitation-management',
    required: true,
    description: 'Phase 8 (solicitation-management) end-of-phase summary written by the solicitation-management subagent. Captures published solicitation URL, invitation count, and gate disposition handed back to the orchestrator.',
  },

  // ── Execution Management phase (Phase 9) ───────────────────────
  // Renamed from llo-manager (was Phase 7) in 0.12.0; renumbered to Phase 8 in 0.13.0.

  {
    path: '9-execution-manager/llo-onboarding_comms-log.md',
    producedBy: 'llo-onboarding',
    role: 'comms-log',
    consumedBy: ['learnings-summary'],
    phase: 'execution-management',
    required: true,
    description: 'Onboarding email records with recipients, subject, body, timestamp',
  },
  {
    path: '9-execution-manager/llo-uat_results.md',
    producedBy: 'llo-uat',
    role: 'results',
    consumedBy: ['llo-launch'],
    phase: 'execution-management',
    required: true,
    description: 'Per-LLO sign-off status, issues found, overall UAT verdict',
  },
  {
    path: '9-execution-manager/llo-launch_record.md',
    producedBy: 'llo-launch',
    role: 'record',
    consumedBy: ['timeline-monitor'],
    phase: 'execution-management',
    required: true,
    description: 'Activation timestamp, LLO notifications, app URLs, outstanding issues',
  },
  {
    path: '9-execution-manager/ocs-chatbot-qa_transcript-monitor.md',
    producedBy: 'ocs-chatbot-qa',
    role: 'transcript',
    consumedBy: ['ocs-chatbot-eval'],
    phase: 'execution-management',
    required: false,
    description: 'Transcript from recurring --monitor runs; structured input to ocs-chatbot-eval --monitor',
  },
  {
    path: '9-execution-manager/ocs-chatbot-eval_verdict-monitor.yaml',
    producedBy: 'ocs-chatbot-eval',
    role: 'verdict',
    consumedBy: [],
    phase: 'execution-management',
    required: false,
    description: 'Machine-readable verdict from recurring --monitor runs. Latest-wins file; see 9-execution-manager/ocs-chatbot-eval_trend.md for history',
  },
  {
    path: '9-execution-manager/ocs-chatbot-eval_trend.md',
    producedBy: 'ocs-chatbot-eval',
    consumedBy: [],
    phase: 'execution-management',
    required: false,
    description: 'Rolling trend of OCS eval scores from --monitor runs; one line per run',
  },
  {
    path: '9-execution-manager/timeline-monitor/YYYY-MM-DD.md',
    producedBy: 'timeline-monitor',
    consumedBy: ['learnings-summary', 'cycle-grade'],
    phase: 'execution-management',
    required: false,
    description: 'Weekly timeline status, progress indicators, prompting email drafts',
  },
  {
    path: '9-execution-manager/flw-data-review/YYYY-MM-DD.md',
    producedBy: 'flw-data-review',
    consumedBy: ['learnings-summary', 'cycle-grade', 'flw-data-review-eval'],
    phase: 'execution-management',
    required: false,
    description: 'FLW data quality assessment: per-delivery (Layer B) and cross-delivery (Layer C)',
  },
  {
    path: '9-execution-manager/flw-data-review-eval_verdict-monitor.yaml',
    producedBy: 'flw-data-review-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'execution-management',
    required: false,
    description: 'Per-skill -eval verdict for the recurring --monitor mode of flw-data-review: signal coverage, outlier-detection rigor, recommendation actionability, evidence citation, trajectory awareness.',
  },
  {
    path: '9-execution-manager/llo-launch-eval_verdict.yaml',
    producedBy: 'llo-launch-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'execution-management',
    required: false,
    description: 'Per-skill -eval verdict for llo-launch: UAT sign-off completeness, Connect activation correctness, app-publish status, go-live notification fidelity, pre-launch gate-discipline. The most load-bearing Phase 8 rubric because go-live is the production gate.',
  },
  {
    path: '9-execution-manager/llo-uat-eval_verdict.yaml',
    producedBy: 'llo-uat-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'execution-management',
    required: false,
    description: 'Per-skill -eval verdict for llo-uat: UAT coverage completeness (every PDD success metric exercised), LLO sign-off clarity (named LLO + explicit go/no-go per metric), blocker resolution (each flagged blocker has resolution path or escalation), evidence-citation discipline, launch-readiness recommendation. 3 hard-block rules: <50% metric coverage, LLO no-go but recommend launch, unresolved blocker without resolution path.',
  },
  {
    path: '9-execution-manager/execution-manager_summary.md',
    producedBy: 'execution-manager',
    role: 'summary',
    consumedBy: [],
    phase: 'execution-management',
    required: true,
    description: 'Phase 9 (execution-manager) end-of-phase summary written by the execution-manager subagent. Captures activation status, monitoring config, and gate disposition handed back to the orchestrator.',
  },

  // ── Closeout phase (Phase 10) ──────────────────────────────────

  {
    path: '10-closeout/opp-closeout_invoices.md',
    producedBy: 'opp-closeout',
    role: 'invoices',
    consumedBy: [],
    phase: 'closeout',
    required: true,
    description: 'Invoice details, total payment amount, Jira ticket link',
  },
  {
    path: '10-closeout/llo-feedback.md',
    producedBy: 'llo-feedback',
    consumedBy: ['learnings-summary', 'cycle-grade'],
    phase: 'closeout',
    required: true,
    description: 'Per-LLO feedback responses, common themes, improvement suggestions',
  },
  {
    path: '10-closeout/learnings-summary.md',
    producedBy: 'learnings-summary',
    consumedBy: ['cycle-grade', 'learnings-summary-eval'],
    phase: 'closeout',
    required: true,
    description: 'Process/content/technical/relationship learnings against original PDD',
  },
  {
    path: '10-closeout/learnings-summary-eval_verdict.yaml',
    producedBy: 'learnings-summary-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'closeout',
    required: false,
    description: 'Per-skill -eval verdict for learnings-summary: opp-lifecycle coverage (Phases 1-9 all touched), recommendation actionability (each insight names a specific change to a skill / SKILL.md / process), tone-calibration vs cycle-grade (inflation-detection axis: a 7/10 opp shouldn\'t read like a victory lap), evidence-citation discipline, forward-seeding clarity.',
  },
  {
    path: '10-closeout/learnings-summary_new-pdd.md',
    producedBy: 'learnings-summary',
    role: 'new-pdd',
    consumedBy: [],
    phase: 'closeout',
    required: false,
    description: 'New PDD incorporating learnings (only if iteration warranted)',
  },
  {
    path: '10-closeout/cycle-grade.md',
    producedBy: 'cycle-grade',
    consumedBy: ['cycle-grade-eval'],
    phase: 'closeout',
    required: true,
    description: '6/7-dimension grades with evidence, recommendations, narrative assessment',
  },
  {
    path: '10-closeout/cycle-grade-eval_verdict.yaml',
    producedBy: 'cycle-grade-eval',
    role: 'verdict',
    consumedBy: ['opp-eval'],
    phase: 'closeout',
    required: false,
    description: 'Per-skill -eval verdict for cycle-grade: independent re-grade detecting self-eval inflation, missing learnings, recommendation vagueness.',
  },
  {
    path: '10-closeout/closeout_summary.md',
    producedBy: 'closeout',
    role: 'summary',
    consumedBy: [],
    phase: 'closeout',
    required: true,
    description: 'Phase 10 (closeout) summary written by the closeout subagent at lifecycle completion. The canonical "what shipped, how it landed, what to do next" doc for the opp.',
  },

  // ── Umbrella eval (opp-eval) — ad-hoc, opt-in; not part of the default 10-phase pipeline ──

  {
    path: '10-closeout/opp-eval/opp-eval_scorecard-quick.md',
    producedBy: 'opp-eval',
    role: 'scorecard',
    consumedBy: [],
    phase: 'closeout',
    required: false,
    description: 'Human-readable quick scorecard from opp-eval --quick (structural artifact check only, no LLM cost)',
  },
  {
    path: '10-closeout/opp-eval/opp-eval_scorecard-deep.md',
    producedBy: 'opp-eval',
    role: 'scorecard',
    consumedBy: [],
    phase: 'closeout',
    required: false,
    description: 'Human-readable run-level scorecard from opp-eval --deep: category breakdown, per-skill results, improvement recommendations',
  },
  {
    path: '10-closeout/opp-eval/opp-eval_scorecard-monitor.md',
    producedBy: 'opp-eval',
    role: 'scorecard',
    consumedBy: [],
    phase: 'closeout',
    required: false,
    description: 'Human-readable scorecard from opp-eval --monitor runs; same shape as --deep plus a trend-file append',
  },
  {
    path: '10-closeout/opp-eval/trend.md',
    producedBy: 'opp-eval',
    consumedBy: [],
    phase: 'closeout',
    required: false,
    description: 'Rolling trend of run-level opp-eval scores from --monitor runs; one line per run with date, overall, and category breakdown',
  },
  {
    path: '10-closeout/opp-eval/opp-eval_verdict-deep.yaml',
    producedBy: 'opp-eval',
    role: 'verdict',
    consumedBy: [],
    phase: 'closeout',
    required: false,
    description: 'Machine-readable run-level verdict from opp-eval --deep: 7-category aggregation of every per-skill verdict found under <phase>/...-eval_verdict.yaml, plus improvement recommendations. Shape matches skills/README.md § QA vs Eval',
  },
  {
    path: '10-closeout/opp-eval/opp-eval_verdict-monitor.yaml',
    producedBy: 'opp-eval',
    role: 'verdict',
    consumedBy: [],
    phase: 'closeout',
    required: false,
    description: 'Machine-readable run-level verdict from opp-eval --monitor runs; latest-wins file (history lives in 10-closeout/opp-eval/trend.md)',
  },

  // ── Partnership-video pipeline ─────────────────────────────────
  //
  // Lives under a DIFFERENT Drive root: ACE/partnerships/<slug>/.
  // Per-prospect (prospect-level) artifacts parallel opp-level ones.
  // Per-run artifacts live under ACE/partnerships/<slug>/runs/<run-id>/.
  //
  // Prospect-level paths are added to OPP_LEVEL_EXEMPT in the lint test.
  // Run-root paths (angles.yaml, video_spec.yaml, etc.) are added to
  // RUN_LEVEL_EXEMPT in the lint test.  Phase-folder paths (2-research/,
  // 7-microdemo/, 8-video-build/, 8-deck-build/) are registered in
  // PHASE_FOLDERS in lib/artifact-manifest-roles.ts and pass the standard
  // lint shape checks.

  // ── Prospect-level (ACE/partnerships/<slug>/) ──────────────────

  {
    path: 'prospect.yaml',
    producedBy: 'partnership-video',
    consumedBy: ['partnership-research', 'partnership-angles', 'partnership-microdemo', 'partnership-publish'],
    phase: 'partnership-research',
    required: true,
    description: 'Prospect identity: name, slug, current_program, target_geography, sector, contact, branding refs. Written once by the partnership-video orchestrator from the operator prompt; reused across every run of the same prospect. Lives at ACE/partnerships/<slug>/prospect.yaml (prospect-level, not per-run).',
  },
  {
    path: 'research/deep-research.md',
    producedBy: 'partnership-research',
    consumedBy: ['partnership-research-qa', 'partnership-research-eval', 'partnership-angles'],
    phase: 'partnership-research',
    required: true,
    description: 'Cited org profile from deep web research: what the prospect org does today, their scale, model, geography, and the expansion thesis. Includes a ## Citations section with sourced URLs. Lives at ACE/partnerships/<slug>/research/deep-research.md (prospect-level — survives across runs; re-runs overwrite).',
  },
  {
    path: 'research/connect-fit.md',
    producedBy: 'partnership-research',
    consumedBy: ['partnership-research-qa', 'partnership-research-eval', 'partnership-angles'],
    phase: 'partnership-research',
    required: true,
    description: 'Connect/Dimagi capability-fit memo: what Connect specifically unlocks for this org in the target geography, cross-referenced against ACE PDDs, case studies, and the existing Connect feature set. Names at least one concrete Connect capability (Learn, Deliver, payment, verified delivery, etc.). Lives at ACE/partnerships/<slug>/research/connect-fit.md (prospect-level).',
  },

  // ── Per-run root (ACE/partnerships/<slug>/runs/<run-id>/) ───────

  {
    path: 'angles.yaml',
    producedBy: 'partnership-angles',
    consumedBy: ['partnership-angles-eval', 'partnership-microdemo', 'partnership-video-build', 'partnership-deck-build', 'partnership-publish'],
    phase: 'partnership-angles',
    required: true,
    description: 'Three grounded narrative angles: each entry has angle_id, title, logline, hero/POV, primary_capability, emotional_beat, and ordered beats with filled narration slots grounded in research facts. Terminal artifact of the propose phase — the human picks one angle before production begins. selected_angle is written to run_state.yaml phases.angles.products.selected_angle.',
  },
  {
    path: 'video_spec.yaml',
    producedBy: 'partnership-video-build',
    consumedBy: ['partnership-video-build-eval', 'partnership-publish'],
    phase: 'partnership-video-build',
    required: true,
    description: 'Filled ace-web partnership-pitch spec as POSTed: prospect branding block, all 3 narration variants (active = picked angle), product beats with clip references. Machine-parsed YAML written via drive_create_file.',
  },
  {
    path: 'deck_spec.yaml',
    producedBy: 'partnership-deck-build',
    consumedBy: ['partnership-deck-build-eval', 'partnership-publish'],
    phase: 'partnership-deck-build',
    required: true,
    description: 'Filled TrainingDeckSpec YAML for the pitch deck (10-12 slides mirroring the video arc: cover, their world, expansion thesis, how Connect works, micro-demo proof, business case, ask). Machine-parsed; rendered to Google Slides by partnership-deck-build.',
  },
  {
    path: 'package.yaml',
    producedBy: 'partnership-video-build',
    consumedBy: ['partnership-deck-build', 'partnership-publish', 'partnership-video-build-eval', 'partnership-deck-build-eval'],
    phase: 'partnership-video-build',
    required: true,
    description: 'Final output URL bundle, assembled incrementally: partnership-video-build writes video.program_url + video.media_url; partnership-deck-build merges deck.slides_url + deck.presentation_id + deck.slide_count; partnership-publish merges canopy_web.package_url + canopy_web.share_url + canopy_web.published_at. Human-review gate fires before any external send.',
  },
  {
    path: 'micro-demo/',
    producedBy: 'partnership-microdemo',
    consumedBy: ['partnership-microdemo-eval', 'partnership-video-build'],
    phase: 'partnership-microdemo',
    required: true,
    description: 'Micro-demo clip bundle: provenance.yaml (machine-parsed clip manifest, one entry per clip with source, origin, caption, is_demo_clip) plus the clip files. Reuse-first: each clip is either sourced from the ace-web media library (source: library) or mocked via Nova autobuild + canopy walkthrough (source: mock). provenance.yaml drives the ace-web spec video build in the next phase.',
  },

  // ── Phase-folder artifacts (2-research/, 7-microdemo/, 8-video-build/, 8-deck-build/) ─

  {
    path: '2-research/partnership-research-qa_result.yaml',
    producedBy: 'partnership-research-qa',
    role: 'qa-result',
    consumedBy: ['partnership-research-eval'],
    phase: 'partnership-research',
    required: false,
    description: 'Structural QA result for partnership-research: 4 checks (deep-research exists + non-empty, fit-memo exists + non-empty, deep-research has citations section, fit-memo names a concrete Connect capability). Binary pass/fail per skills/_qa-template.md schema. Gates partnership-research-eval — eval writes verdict: incomplete if QA fails irrecoverably.',
  },
  {
    path: '2-research/partnership-research-eval_verdict.yaml',
    producedBy: 'partnership-research-eval',
    role: 'verdict',
    consumedBy: [],
    phase: 'partnership-research',
    required: true,
    description: 'LLM-as-Judge eval verdict for partnership-research: grounding (citations traceable), Connect-fit specificity (names concrete capability + evidence), factual/brand safety (no fabricated stats or invented history), scope completeness (covers all key prospect dimensions), and actionability (slots fillable by angles skill without inference). Shape matches skills/README.md § QA vs Eval.',
  },
  {
    path: '2-research/partnership-angles-eval_verdict.yaml',
    producedBy: 'partnership-angles-eval',
    role: 'verdict',
    consumedBy: [],
    phase: 'partnership-angles',
    required: true,
    description: 'LLM-as-Judge eval verdict for partnership-angles: grounding (each angle\'s cited facts traceable to research), narrative distinctness (three angles tell meaningfully different stories), capability-tie (each angle leans on a specific Connect capability), persuasiveness (each angle has a clear emotional beat + hero), and factual/brand safety (no fabricated backstory). Shape matches skills/README.md § QA vs Eval.',
  },
  {
    path: '7-microdemo/partnership-microdemo-eval_verdict.yaml',
    producedBy: 'partnership-microdemo-eval',
    role: 'verdict',
    consumedBy: [],
    phase: 'partnership-microdemo',
    required: true,
    description: 'LLM-as-Judge eval verdict for partnership-microdemo: clip-to-beat alignment (each clip matches its product beat intent), provenance honesty (reuse vs mock declared accurately), mock fidelity (mocked clips plausibly represent the capability), technical quality (clips playable, resolution acceptable), and connect-capability visibility (the primary capability is legible in the demo). Shape matches skills/README.md § QA vs Eval.',
  },
  {
    path: '8-video-build/partnership-video-build-eval_verdict.yaml',
    producedBy: 'partnership-video-build-eval',
    role: 'verdict',
    consumedBy: [],
    phase: 'partnership-video-build',
    required: true,
    description: 'LLM-as-Judge eval verdict for partnership-video-build: spec completeness (all required ace-web fields populated), angle-fidelity (active variant matches picked angle beats), clip-wiring (every product beat has a resolved clip reference), render success (program URL and media URL non-null), and brand hygiene (prospect name/logo used, Dimagi chrome preserved). Shape matches skills/README.md § QA vs Eval.',
  },
  {
    path: '8-deck-build/partnership-deck-build-eval_verdict.yaml',
    producedBy: 'partnership-deck-build-eval',
    role: 'verdict',
    consumedBy: [],
    phase: 'partnership-deck-build',
    required: true,
    description: 'LLM-as-Judge eval verdict for partnership-deck-build: spec completeness (all required TrainingDeckSpec fields populated), video-arc alignment (deck beats mirror the chosen video angle), slide-count plausibility (10-12 slides), render success (slides_url non-null), and brand hygiene. Shape matches skills/README.md § QA vs Eval.',
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
