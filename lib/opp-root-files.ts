/**
 * The single registry of files and folders ACE itself owns at an opportunity
 * root — `ACE/<opp>/`.
 *
 * Why one registry (dimagi-internal/ace#1282 + #1325): two consumers each kept
 * their own hand-maintained exemption list, documented as "keep the two in
 * sync", and both listed only `opp.yaml` and `*_comms-log*`:
 *
 *  - the orchestrator's Step 5b auto-migrate, which moves every non-folder
 *    direct child of the opp root into `inputs/` so an operator can drop a
 *    brief next to `opp.yaml` (jjackson/ace#299);
 *  - `detectStrayOppRootFiles`, which reports anything outside the whitelist
 *    as cruft in `/ace:doctor`.
 *
 * Both then swept ACE's own state into the Phase 1 evidence pack.
 * `open-questions.md` is written to the opp root BY ACE'S OWN MANDATE, so the
 * orchestrator created a file in one step and migrated it in another — which
 * both fed ACE's prior conclusions back in as curated source evidence (the
 * `no-inferred-backstory` class through a self-referential back door) and
 * silently broke the ace#1201 durable-questions loop, whose read half looks
 * at the opp root. `iterate-state.yaml` is `/ace:iterate` campaign control
 * state read from the same place; migrating it resets the campaign's golden
 * pointer, streak and kill switch.
 *
 * `_comms-log` was itself bolted on one incident at a time (ace#929).
 * Enumerating ACE-owned names per incident IS the defect, so the enumeration
 * lives here once, every consumer imports it, and
 * `test/lib/opp-root-files.test.ts` asserts the orchestrator doc lists every
 * entry — the sync obligation made structural instead of asserted in prose.
 *
 * **Adding an entry is the contract for writing to the opp root.** If a skill
 * needs a durable per-opp file, register it here in the same PR; otherwise
 * Step 5b will migrate it and the skill will silently stop finding it on the
 * next run. Per-RUN state belongs under `runs/<run-id>/`, not here.
 */

export interface OppRootEntry {
  /** Exact name or glob-ish label, as it appears in docs. */
  label: string;
  kind: 'file' | 'folder';
  /** What writes it. */
  owner: string;
  /** Why it must stay at the opp root — what breaks if it is moved. */
  why: string;
  /** Tracking issue, when the entry came from one. */
  ref?: string;
  match: (name: string) => boolean;
}

const exact = (n: string) => (name: string) => name === n;

export const ACE_OWNED_OPP_ROOT: OppRootEntry[] = [
  {
    label: 'opp.yaml',
    kind: 'file',
    owner: 'connect-program-setup (the only skill that mutates it)',
    why: 'opp identity plus the durable Connect program reference every run reuses',
    match: exact('opp.yaml'),
  },
  {
    label: 'inputs',
    kind: 'folder',
    owner: 'orchestrator Step 5a',
    why: 'the evidence pack itself — the destination Step 5b migrates INTO',
    match: exact('inputs'),
  },
  {
    label: 'runs',
    kind: 'folder',
    owner: 'orchestrator run bootstrap',
    why: 'every per-run folder lives under it; runs are independent of each other',
    match: exact('runs'),
  },
  {
    label: 'current',
    kind: 'folder',
    owner: 'orchestrator run bootstrap',
    why: 'shortcut to the active run, resolved by /ace:status and resume',
    match: exact('current'),
  },
  {
    label: 'eval-calibration',
    kind: 'folder',
    owner: 'eval-calibration + the -eval skills',
    why: 'holds known-issues.md and the per-rubric run logs, shared across every run of the opp',
    match: exact('eval-calibration'),
  },
  {
    label: 'feedback',
    kind: 'folder',
    owner: 'feedback-ledger',
    why: 'the per-reviewer fact store and rendered ledgers, one stable URL per review',
    match: exact('feedback'),
  },
  {
    label: 'open-questions.md',
    kind: 'file',
    owner: 'idea-to-pdd / Phase 1',
    why:
      'durable across runs — Phase 1 reads it at the opp root to declare resolves / carries ' +
      'forward / contradicts. Migrated, the read half finds nothing and contradiction detection ' +
      'silently stops firing, while the write half keeps producing a fresh one',
    ref: 'dimagi-internal/ace#1201, #1325',
    match: exact('open-questions.md'),
  },
  {
    label: 'iterate-state.yaml',
    kind: 'file',
    owner: '/ace:iterate',
    why:
      'campaign control state read from the opp root — golden_run_id, the pass streak, caps and ' +
      'the kill switch. Migrating it silently resets the campaign',
    ref: 'dimagi-internal/ace#1282',
    match: (name) => /^iterate-state(-legacy-\d+)?\.yaml$/.test(name),
  },
  {
    label: '*_comms-log*',
    kind: 'file',
    owner: 'email-communicator / inbox-triage',
    why:
      'inbox-triage routes inbound threads by matching Gmail thread_id against these, so moving ' +
      'one breaks thread routing as well as poisoning the evidence pack',
    ref: 'dimagi-internal/ace#929',
    match: (name) => name.includes('_comms-log'),
  },
];

/** The registry entry claiming `name`, or null when nothing does. */
export function classifyOppRootEntry(name: string): OppRootEntry | null {
  return ACE_OWNED_OPP_ROOT.find((e) => e.match(name)) ?? null;
}

/**
 * True when ACE owns this opp-root entry — so Step 5b must not migrate it and
 * `/ace:doctor` must not report it as stray.
 */
export function isAceOwnedOppRootEntry(name: string): boolean {
  return classifyOppRootEntry(name) !== null;
}
