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
 *
 * ## Why this is still an enumeration — the authorship gate was MEASURED and rejected
 *
 * dimagi-internal/ace#2112 was the FOURTH instance of one class (#929
 * `_comms-log`, #1282 `iterate-state.yaml`, #1325 `open-questions.md`, then a
 * parked outbound draft at `ACE/spark-facilitator/`), and proposed the
 * structural fix this header's own text asks for: stop asking "is this name
 * registered?" and ask **"did ACE write this?"** — gate Step 5b on Drive
 * authorship, since ACE's service account owns what ACE wrote and an operator
 * drop is owned by a human. Better shape, if the signal were real. It is not.
 *
 * Measured 2026-09-07 against the live ACE Drive root
 * (`1HThsA_0Lr5p1OdI5r-aQ446HlNBaySLz`) as the service account, reading the
 * fields `drive_list_folder` would have to add — `owners`,
 * `lastModifyingUser` — across 28 opps:
 *
 *  1. **`owners[]` is EMPTY on 68 of 68 opp-root non-folder children.** ACE's
 *     root lives on a SHARED DRIVE (`driveId: 0AIUhETtpTlpcUk9PVA`), and a
 *     shared-drive item is owned by the drive, not by a user. The field the
 *     proposal turns on does not exist here — not "sometimes ambiguous",
 *     absent.
 *  2. **`lastModifyingUser` never resolves to a human.** Across all 132 files
 *     read (68 opp-root + 64 under `inputs/`) it is either the service
 *     account or `null` — never a person's address. So it cannot express
 *     "a human put this here" either.
 *  3. **And the weaker proxy points the WRONG WAY.** 54 of 64 files inside
 *     `inputs/` — operator-dropped source material, the evidence pack itself —
 *     read `lastModifyingUser == <the SA>`, the same value the ACE-authored
 *     parked draft carries. `spark-facilitator/inputs/` is 6 for 6. An
 *     authorship gate built on it would classify the partner's own source
 *     documents as ACE-authored and decline to migrate them, which fails
 *     SILENTLY and in the more damaging direction: Phase 1 would run on an
 *     empty evidence pack.
 *
 * A stamp ACE writes on its own files at creation (Drive `appProperties`)
 * WOULD be a real structural fix, but it lives on the WRITE side — every
 * `drive_create_*` atom in `mcp/` — and it cannot retro-classify a single
 * file that already exists, including the one that filed #2112. That is a
 * separate change with a migration, not this one.
 *
 * So the enumeration stays, and the honest mitigation is the one below plus
 * making Step 5b LOUD: it already logged every file it MOVED, and a file it
 * DECLINED to move was invisible. Both are logged now, so a wrong entry here
 * shows up in `run_state.yaml.notes` on the next run instead of quietly
 * withholding an operator's brief from Phase 1.
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
    label: '*parked outbound draft*',
    kind: 'file',
    owner: 'inbox-triage / email-communicator (review posture parks a reply)',
    why:
      'an outbound email ACE ITSELF drafted and parked awaiting sign-off. Migrated, ACE reads ' +
      'its own unsent prose back as curated Phase 1 source evidence — the no-inferred-backstory ' +
      'class through the same self-referential back door as open-questions.md. Note the ' +
      'CONVENTION is to park a draft in the thread comms-log (skills/inbox-triage § 4b step 2), ' +
      'which is already claimed below; this entry covers the standalone doc that gets written ' +
      'anyway, and a false positive is now visible because Step 5b logs what it declines',
    ref: 'dimagi-internal/ace#2112',
    match: (name) => /\bparked\b.*\bdraft\b|\boutbound draft\b/i.test(name),
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
