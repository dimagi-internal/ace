/**
 * The Phase 7 cascade STORY: what a synthetic programme is built to show, and
 * whether it actually shows it (ace#2510).
 *
 * A synthetic programme is only worth filming if a viewer drilling
 * programme → partner → opportunity → worker → case finds something. Four
 * signals are authored on purpose, each tied to a registry indicator and a PDD
 * clause:
 *
 *   lagging_partner  — one partner worst on its indicator (the PM's first click)
 *   standout_worker  — one worker best among every worker on its indicator
 *   data_quality     — one worker extreme on a PDD review signal (the S-1 class)
 *   trend            — one partner (or the programme) moving across the weeks
 *
 * The generator draws distributions; a declared signal can still fail to land
 * (a noisy cohort swamps it, a filter drops the carrier, a unit is misread).
 * So the plan is checked BEFORE generation (`checkCascadeStoryPlan`) and the
 * signal is checked AFTER, against the saved runs the programme report actually
 * graded (`verifyCascadeStoryLanded`) — the source of truth is the snapshot,
 * never the manifest. This is `CLAUDE.md § close the loop to the source of
 * truth`: the manifest is what we asked for, the snapshot is what labs says.
 *
 * Pure: no I/O. Snapshot values are labs' raw fractions (0.62 for 62%).
 *
 * WHAT A VIEWER READS (ace#2727). The plan also owns every NAME the dashboard
 * renders for an invented thing — partner, worker, followed entity — because
 * two rails read those names and must agree. ACE's honesty rail (be59309d) says
 * an invented partner must not pass for a real implementer; canopy's DDD
 * user-artifact judge reads the screens as the programme manager and scores a
 * placeholder ("Example partner A", `cbf_a07`, a hashed community id) at
 * clarity 2. Satisfying the first with a placeholder fails the second, and that
 * was the floor of spark-facilitator/20261004-1706 (2.0 across 15 judged passes
 * in three DDD runs). So an invented name is REALISTIC and plainly marked:
 * "Tiyende Community Trust (example)" — a viewer reads an organisation, and is
 * still told it is invented.
 */

export type SignalKind = 'lagging_partner' | 'standout_worker' | 'data_quality' | 'trend';
export const REQUIRED_SIGNAL_KINDS: readonly SignalKind[] = ['lagging_partner', 'standout_worker', 'data_quality', 'trend'];

export interface StorySignal {
  kind: SignalKind;
  /** Partner label (lagging_partner, trend) or worker username (standout_worker, data_quality); `programme` for a programme-wide trend. */
  carrier: string;
  /** Registry indicator id the signal moves, e.g. `SF_P1`. */
  indicator: string;
  /** Is a higher value better on this indicator? Taken from the registry's `direction`. */
  higher_is_better: boolean;
  /** trend only: which way the carrier moves across the periods. */
  trend_direction?: 'up' | 'down';
  /** The PDD clause the signal derives from, e.g. `PDD §7.2 S-1`. Required: an uncited signal is an invented one. */
  pdd_ref: string;
  /** What a viewer SEES, in one sentence — written before generation. */
  visible_as: string;
}

export interface StoryPartner {
  label: string;
  opportunity_id: number;
  workers: number;
}

/**
 * One worker as the dashboard should NAME them (ace#2727). `username` is the
 * synthetic identity the generator writes (and the key the snapshot rows carry);
 * `display_name` is an invented, culturally plausible human name for the PDD's
 * geography — never a real person's name from the opp's inputs.
 */
export interface StoryWorker {
  username: string;
  display_name: string;
  /** The partner label this worker belongs to. */
  partner?: string;
}

/** One followed entity (Spark: a community) as the dashboard should name it. */
export interface StoryEntity {
  /** The entity / case id the generator writes (may be a hash). */
  id: string;
  /** An invented, human-readable name ("Kalemba", not `e3b0c442`). */
  name: string;
  /** The worker username who owns it. */
  worker?: string;
}

export interface CascadeStoryPlan {
  partners: StoryPartner[];
  weeks: number;
  signals: StorySignal[];
  /** Worker usernames the plan names as carriers must exist; the roster lets the check say so. */
  worker_roster?: string[];
  /**
   * The display roster (ace#2727): every worker with the human name a viewer
   * reads. Required for invented partners — a code-shaped row label is what the
   * judge scores at clarity 2. One entry per worker (sum of `partners[].workers`).
   */
  workers?: StoryWorker[];
  /** The followed entities with human names (required for invented partners). */
  entities?: StoryEntity[];
  /**
   * The indicators the programme report's headline (scene 1, and the partner
   * table it is sorted by) shows. Required for invented partners (ace#2727).
   */
  headline_indicators?: string[];
  /**
   * The per-partner value (raw fraction) the pool is AUTHORED to produce for each
   * headline indicator: `{SF_P1: {"<partner label>": 0.95, ...}}`. A headline that
   * is the same for every partner gives the viewer nothing to sort by.
   */
  headline_spread?: Record<string, Record<string, number>>;
  /** The synthetic programme's name as labs renders it; must say it is illustrative. */
  programme_name?: string;
  /**
   * `invented` (default): ACE made the partners up, so it can always make three.
   * `programme`: they mirror the programme's real partners -- two is a real
   * programme's shape, not a thin story, so the floor drops to 2 (a comparison
   * needs two) and fewer than 3 warns that a benchmark exposes a peer's figures.
   */
  partner_source?: 'invented' | 'programme';
  /**
   * What each signal's `pdd_ref` cites. `pdd` (default): a PDD section (`§N`).
   * `app`: there is no PDD, so a signal cites the released Deliver app's form and
   * rule (`Deliver app — FCR Test, pass = result >= 0.2 mg/L`).
   */
  anchor?: 'pdd' | 'app';
  /**
   * How many implementing organisations the PDD actually names (default 1 —
   * a single-LLO pilot). Read from the PDD, never inferred from the demo.
   * With `partner_source: 'programme'` the partner count must equal it; with
   * invented partners it is what the illustrative label is honest about.
   */
  implementing_orgs?: number;
  /**
   * What the PDD says happens to a record carrying each review flag (ace#2735).
   * Required alongside a `data_quality` signal: the signal makes one worker's
   * records carry the flag, and the generated records must then follow the
   * design's own review path — not sit `approved` with nothing sent to review,
   * which is what spark-facilitator/20261004-1706 filmed (11 of 12 flagged
   * records approved, against PDD §7.2 S-1's desk review). Checked against the
   * generated visit rows by `checkReviewRouting` (`lib/cascade-build-qa.ts`).
   */
  review_routing?: ReviewRoute[];
  /**
   * Drill levels the PDD fixes at exactly one child (Spark: one community per
   * facilitator), each with the reason. Without an entry, a level that has one
   * child everywhere fails `checkDrillLevels` — a click into it shows the same
   * thing again (ace#2735). A blank reason exempts nothing.
   */
  single_child_levels?: Array<{ level: DrillLevel; reason: string }>;
}

/** The cascade's drill levels, parent>child, as the programme report renders them. */
export type DrillLevel = 'partner>opportunity' | 'opportunity>worker' | 'worker>entity';
export const DRILL_LEVELS: readonly DrillLevel[] = ['partner>opportunity', 'opportunity>worker', 'worker>entity'];

/**
 * One review flag's route (ace#2735). `flag` is a visit column the registry
 * declares as a flag (`indicators_doc.display.visit_flags[].column`). Exactly one of:
 *  - `expect`: field → allowed values every FLAGGED record must carry, read from
 *    what the PDD says happens (desk review: `{flagged: [true]}`; held for review:
 *    `{status: ['pending']}`);
 *  - `report_only`: the PDD's own words saying the flag is reported, not routed.
 */
export interface ReviewRoute {
  flag: string;
  pdd_ref: string;
  expect?: Record<string, Array<string | number | boolean>>;
  report_only?: string;
}

/**
 * The marker that tells a dashboard viewer a partner is a demo device, not an
 * organisation in the programme: a trailing `(example)` (or `(illustrative)`)
 * on an otherwise realistic name. Checked on each partner label, because the
 * label IS what the programme report renders (it is the `llo_map` org name).
 *
 * ace#2727 narrowed this from "the word example/illustrative anywhere": that
 * accepted "Example partner A", a placeholder canopy's judge scores at clarity 2.
 */
export const ILLUSTRATIVE_LABEL = /\((?:example|illustrative)\)\s*$/i;

/**
 * Placeholder-shaped organisation names: a role word plus a letter/number
 * ("Partner A", "Org 2"), a demo word up front ("Example partner C"), or a bare
 * code. Applied to a partner label with its marker stripped.
 */
/**
 * A PDD citation: numbered (`§5.4`) or named (`§ Success Metrics`) — ACE's PDD
 * template has unnumbered headings, so a named citation is the only one it can
 * carry (ace#2803). Format only: the registry's `pdd-anchor` check resolves names.
 */
const PDD_CITE = /§\s*[\p{L}\d]/u;
const PLACEHOLDER_ORG =
  /^(?:(?:example|illustrative|sample|demo|test|synthetic|fake|dummy)\b|(?:partner|org|organi[sz]ation|llo|ngo|implementer|site|team|group)\s*[A-Z0-9]{1,3}$|[A-Z0-9]{1,3}$)/i;

/** A human-readable name: starts with a capital letter; letters, spaces and '’.- only (no digits, no `_`). */
const HUMAN_NAME = /^\p{Lu}[\p{L}'’.\-]*(?:\s+[\p{L}'’.\-]+)*$/u;

/** Role words that make a "name" a placeholder ("Worker A", "Community 3", "Facilitator B"). */
const PLACEHOLDER_PERSON =
  /^(?:worker|facilitator|flw|cbf|chw|community|village|household|case|user|participant|entity|beneficiary|example|sample|test)\b/i;

/**
 * Why `label` is not an acceptable invented-partner name, or null. Exported so
 * the skill's authoring step and the QA backstop apply the same rule.
 */
export function exampleOrgLabelProblem(label: string): string | null {
  if (!ILLUSTRATIVE_LABEL.test(label)) return 'carries no trailing "(example)" marker';
  const core = label.replace(ILLUSTRATIVE_LABEL, '').trim();
  if (!core) return 'is only the marker';
  if (PLACEHOLDER_ORG.test(core) || /[\d_]/.test(core)) return 'is a placeholder, not an organisation name';
  return null;
}

/** Why `name` is not a human-readable display name for `id`, or null. */
export function displayNameProblem(name: string | undefined, id: string): string | null {
  const n = (name ?? '').trim();
  if (!n) return 'has no display name';
  if (n.toLowerCase() === id.toLowerCase()) return 'its display name is its code';
  if (!HUMAN_NAME.test(n)) return `"${n}" is code-shaped (digits, \`_\`, or not capitalised)`;
  if (PLACEHOLDER_PERSON.test(n) || /\s[A-Z]$/.test(n)) return `"${n}" is a placeholder`;
  return null;
}

/** Best-minus-worst spread a headline indicator needs across partners (raw units: 0.05 = 5 pts). */
export const MIN_HEADLINE_SPREAD = 0.05;

export interface PlanCheckOptions {
  /**
   * Names of real people found in the opp's inputs (PDD contacts, LLO contacts,
   * reviewers). A worker display name containing one fails — an invented roster
   * must never put a real person's name next to a synthetic figure.
   */
  realPeople?: readonly string[];
}

export interface StoryFinding {
  signal?: SignalKind;
  severity: 'fail' | 'warn';
  detail: string;
}

export interface PlanFloors {
  minPartners: number;
  minWorkersPerPartner: number;
  minWeeks: number;
}

/**
 * Default story shape: 5 partners × ~12 workers × ~13 weeks (ace#2727). Three
 * invented partners, all at 100% on the programme's Step 7, were too few for
 * the concept judge to see why sorting partners by need matters. The floor IS
 * the default, not below it: a floor under the default is a prose default with
 * no rail. A `partner_source: programme` plan still floors at 2 (a real
 * programme's shape).
 */
export const DEFAULT_FLOORS: PlanFloors = { minPartners: 5, minWorkersPerPartner: 8, minWeeks: 8 };

export function checkCascadeStoryPlan(
  plan: CascadeStoryPlan,
  registryIndicatorIds: readonly string[],
  floors: PlanFloors = DEFAULT_FLOORS,
  options: PlanCheckOptions = {},
): { verdict: 'pass' | 'fail'; findings: StoryFinding[] } {
  const findings: StoryFinding[] = [];
  const fail = (detail: string, signal?: SignalKind) => findings.push({ severity: 'fail', detail, ...(signal ? { signal } : {}) });

  const programme = plan.partner_source === 'programme';
  const minPartners = programme ? Math.min(floors.minPartners, 2) : floors.minPartners;
  if (plan.partners.length < minPartners) {
    fail(`${plan.partners.length} partner(s); the cascade needs ≥ ${minPartners} so a partner comparison and an anonymous benchmark mean something`);
  } else if (programme && plan.partners.length < 3) {
    findings.push({ severity: 'warn', detail: `the programme has ${plan.partners.length} partners — its benchmark cohort needs \`min_peers\` below 3, which shows each partner its peer's exact figures` });
  }
  // Invented partners are a deliberate demo device (a comparison and an
  // anonymous benchmark need peers), but a single-implementer pilot shown as
  // "Partner A/B/C" reads as a claim that three organisations deliver it — the
  // outsider eval flagged exactly that on spark-facilitator/20261001-2208. So
  // each label says it is invented. And it says so on a REALISTIC name: the
  // be59309d form "Example partner A" is a placeholder canopy's judge scores at
  // clarity 2, which floored spark-facilitator/20261004-1706 (ace#2727).
  const implementers = plan.implementing_orgs ?? 1;
  if (programme) {
    if (plan.implementing_orgs !== undefined && plan.partners.length !== plan.implementing_orgs) {
      fail(`\`partner_source: programme\` mirrors the programme, but the plan has ${plan.partners.length} partners and the PDD names ${plan.implementing_orgs} implementing organisation(s)`);
    }
  } else {
    const bad = plan.partners
      .map((p) => ({ label: p.label, why: exampleOrgLabelProblem(p.label) }))
      .filter((x): x is { label: string; why: string } => x.why !== null);
    if (bad.length) {
      fail(
        `partner label(s) ${bad.map((b) => `"${b.label}" (${b.why})`).join(', ')} — the PDD names ` +
          `${implementers} implementing organisation(s) and the dashboard shows ${plan.partners.length} invented partners; ` +
          `give each a realistic invented organisation name with a trailing "(example)" marker, ` +
          `e.g. "Tiyende Community Trust (example)" — never a placeholder like "Partner A" or "Example partner A"`,
      );
    }
    if (plan.programme_name !== undefined && !/\b(illustrative|example)\b/i.test(plan.programme_name)) {
      fail(`programme name "${plan.programme_name}" does not say it is illustrative — it is the page title above ${plan.partners.length} invented partners`);
    }
  }
  const labels = new Set(plan.partners.map((p) => p.label));
  if (labels.size !== plan.partners.length) fail('partner labels must be distinct — they are the llo_map organisation names');
  const opps = new Set(plan.partners.map((p) => p.opportunity_id));
  if (opps.size !== plan.partners.length) fail('each partner needs its own synthetic opportunity');
  for (const p of plan.partners) {
    if (p.opportunity_id < 10000) fail(`partner ${p.label}: opportunity ${p.opportunity_id} is not labs-only (≥ 10000) — a real Connect org/opp must never carry synthetic data`);
    if (p.workers < floors.minWorkersPerPartner) fail(`partner ${p.label}: ${p.workers} workers; ≥ ${floors.minWorkersPerPartner} needed so a standout is not trivially the only row`);
  }
  if (plan.weeks < floors.minWeeks) fail(`${plan.weeks} weeks; ≥ ${floors.minWeeks} needed for a trend across saved weekly runs`);

  const ids = new Set(registryIndicatorIds);
  const roster = plan.worker_roster ? new Set(plan.worker_roster) : null;
  for (const kind of REQUIRED_SIGNAL_KINDS) {
    if (!plan.signals.some((s) => s.kind === kind)) fail(`no \`${kind}\` signal — the story needs all four (lagging partner, standout worker, data-quality problem, trend)`, kind);
  }
  for (const s of plan.signals) {
    if (!ids.has(s.indicator)) fail(`indicator ${s.indicator} is not in the registry`, s.kind);
    if (plan.anchor === 'app') {
      if (!/deliver app/i.test(s.pdd_ref ?? '')) fail(`\`pdd_ref\` "${s.pdd_ref ?? ''}" names no Deliver app form — with no PDD, an uncited signal is an invented one`, s.kind);
    } else if (!PDD_CITE.test(s.pdd_ref ?? '')) fail(`\`pdd_ref\` "${s.pdd_ref ?? ''}" cites no PDD section — an uncited signal is an invented one`, s.kind);
    if (!s.visible_as || s.visible_as.trim().length < 20) fail('`visible_as` must say, in a sentence, what a viewer sees', s.kind);
    const partnerCarrier = s.kind === 'lagging_partner' || (s.kind === 'trend' && s.carrier !== 'programme');
    if (partnerCarrier && !labels.has(s.carrier)) fail(`carrier "${s.carrier}" is not a partner in the plan`, s.kind);
    if ((s.kind === 'standout_worker' || s.kind === 'data_quality') && roster && !roster.has(s.carrier)) {
      fail(`carrier "${s.carrier}" is not in the worker roster`, s.kind);
    }
    if (s.kind === 'trend' && !s.trend_direction) fail('a trend signal must declare `trend_direction: up|down`', s.kind);
  }

  const warn = (detail: string) => findings.push({ severity: 'warn', detail });
  checkReviewRoutingPlan(plan, programme, fail, warn);
  checkDisplayRoster(plan, programme, fail, warn, options);
  checkHeadlineSpread(plan, ids, labels, programme, fail, warn);
  return { verdict: findings.some((f) => f.severity === 'fail') ? 'fail' : 'pass', findings };
}

/**
 * A data-quality signal declares the PDD's review route for its flag (ace#2735).
 * The route is a fact about the DESIGN, so it is authored with the story and
 * cited; the generated records are judged against it after generation.
 * Required for invented partners; a programme mirror that omits it is warned.
 */
function checkReviewRoutingPlan(
  plan: CascadeStoryPlan,
  programme: boolean,
  fail: (detail: string, signal?: SignalKind) => void,
  warn: (detail: string) => void,
): void {
  const routes = plan.review_routing ?? [];
  const hasDq = plan.signals.some((s) => s.kind === 'data_quality');
  if (hasDq && routes.length === 0) {
    (programme ? warn : fail)(
      'a `data_quality` signal with no `review_routing` — say what the PDD does with a flagged record ' +
        '(`expect` the fields a flagged record carries, or `report_only` with the PDD\'s words), so the ' +
        'generated records can be checked against it (ace#2735: 11 of 12 flagged Spark records filmed ' +
        '`approved` with nothing sent to review, against PDD §7.2 S-1)',
    );
  }
  for (const r of routes) {
    const where = `review_routing ${r.flag || '(no flag)'}`;
    if (!r.flag?.trim()) fail(`${where}: names no flag column`);
    const cited = plan.anchor === 'app' ? /deliver app/i.test(r.pdd_ref ?? '') : PDD_CITE.test(r.pdd_ref ?? '');
    if (!cited) fail(`${where}: \`pdd_ref\` "${r.pdd_ref ?? ''}" cites no ${plan.anchor === 'app' ? 'Deliver app form' : 'PDD section'}`);
    const hasExpect = !!r.expect && Object.keys(r.expect).length > 0 && Object.values(r.expect).every((v) => Array.isArray(v) && v.length > 0);
    const hasReport = !!r.report_only?.trim();
    if (hasExpect === hasReport) {
      fail(`${where}: declare exactly one of \`expect\` (fields → allowed values a flagged record carries) or \`report_only\` (the PDD's words)`);
    }
  }
  for (const s of plan.single_child_levels ?? []) {
    if (!DRILL_LEVELS.includes(s.level)) fail(`single_child_levels: "${s.level}" is not a drill level (${DRILL_LEVELS.join(', ')})`);
    if (!s.reason?.trim()) fail(`single_child_levels ${s.level}: no reason — an unevidenced exemption exempts nothing`);
  }
}

/**
 * The display roster (ace#2727): workers and followed entities carry the names
 * a viewer reads. Required for invented partners; a programme mirror that
 * omits it is warned, not failed (its names may come from the real programme).
 */
function checkDisplayRoster(
  plan: CascadeStoryPlan,
  programme: boolean,
  fail: (detail: string, signal?: SignalKind) => void,
  warn: (detail: string) => void,
  options: PlanCheckOptions,
): void {
  const missing = (what: string) =>
    `no \`${what}\` display roster — rows render as codes (\`cbf_a07\`, a hashed id), which the DDD judge scores at clarity 2 (ace#2727)`;
  if (!plan.workers?.length) (programme ? warn : fail)(missing('workers'));
  if (!plan.entities?.length) (programme ? warn : fail)(missing('entities'));

  const labels = new Set(plan.partners.map((p) => p.label));
  const realPeople = (options.realPeople ?? []).map((n) => n.trim().toLowerCase()).filter((n) => n.length > 0);
  if (plan.workers?.length) {
    const expected = plan.partners.reduce((n, p) => n + p.workers, 0);
    if (plan.workers.length !== expected) {
      fail(`the display roster names ${plan.workers.length} workers; the partners declare ${expected}`);
    }
    const usernames = new Set<string>();
    const names = new Set<string>();
    for (const w of plan.workers) {
      if (usernames.has(w.username)) fail(`worker ${w.username} appears twice in the display roster`);
      usernames.add(w.username);
      const why = displayNameProblem(w.display_name, w.username);
      if (why) fail(`worker ${w.username}: ${why}`);
      const key = (w.display_name ?? '').trim().toLowerCase();
      if (key && names.has(key)) fail(`two workers share the display name "${w.display_name}" — a viewer cannot tell their rows apart`);
      names.add(key);
      if (w.partner !== undefined && !labels.has(w.partner)) fail(`worker ${w.username}: partner "${w.partner}" is not a partner in the plan`);
      const real = realPeople.find((r) => key.includes(r));
      if (real) fail(`worker ${w.username}: display name "${w.display_name}" is a real person's name from the inputs ("${real}") — invent one`);
    }
    for (const s of plan.signals) {
      if ((s.kind === 'standout_worker' || s.kind === 'data_quality') && !usernames.has(s.carrier)) {
        fail(`carrier "${s.carrier}" has no display name in the roster`, s.kind);
      }
    }
  }
  if (plan.entities?.length) {
    const workerNames = new Set((plan.workers ?? []).map((w) => w.username));
    const names = new Set<string>();
    for (const e of plan.entities) {
      const why = displayNameProblem(e.name, e.id);
      if (why) fail(`entity ${e.id}: ${why}`);
      const key = (e.name ?? '').trim().toLowerCase();
      if (key && names.has(key)) fail(`two entities share the name "${e.name}"`);
      names.add(key);
      if (e.worker !== undefined && workerNames.size && !workerNames.has(e.worker)) {
        fail(`entity ${e.id}: worker "${e.worker}" is not in the display roster`);
      }
    }
  }
}

/**
 * No headline indicator may be flat across ALL partners (ace#2727). A headline
 * every partner shares — three partners all at 100% on Step 7 — gives the
 * programme manager nothing to sort partners by, and the concept judge said
 * exactly that. FAIL, not warn: it is decidable before generation from numbers
 * the author writes, it costs one pool edit, and in an unattended run a warning
 * is carried past exactly as the placeholders were. A genuinely saturated
 * indicator is not wrong — it just is not a headline; demote it.
 */
function checkHeadlineSpread(
  plan: CascadeStoryPlan,
  ids: ReadonlySet<string>,
  labels: ReadonlySet<string>,
  programme: boolean,
  fail: (detail: string) => void,
  warn: (detail: string) => void,
): void {
  const headlines = plan.headline_indicators ?? [];
  if (!headlines.length) {
    (programme ? warn : fail)('no `headline_indicators` — the plan cannot show its headline differs across partners (ace#2727)');
    return;
  }
  for (const ind of headlines) {
    if (!ids.has(ind)) fail(`headline indicator ${ind} is not in the registry`);
    const spread = plan.headline_spread?.[ind];
    if (!spread) {
      fail(`headline indicator ${ind} has no \`headline_spread\` — author the per-partner value the pool is written to produce`);
      continue;
    }
    const missing = [...labels].filter((l) => typeof spread[l] !== 'number');
    if (missing.length) fail(`headline indicator ${ind}: no authored value for ${missing.map((m) => `"${m}"`).join(', ')}`);
    const values = [...labels].map((l) => spread[l]).filter((v): v is number => typeof v === 'number');
    if (values.length >= 2 && Math.max(...values) - Math.min(...values) < MIN_HEADLINE_SPREAD) {
      fail(
        `headline indicator ${ind} is flat across all partners (${values.map((v) => `${(v * 100).toFixed(0)}%`).join(', ')}) — ` +
          `nothing to sort partners by; spread them ≥ ${MIN_HEADLINE_SPREAD * 100} pts or demote it from the headline`,
      );
    }
  }
}

// ── After generation: did the signal land in what labs graded? ───────────

/** One saved run's graded cells, the subset of `state.snapshot` this check reads. */
export interface GradedPeriod {
  period_end: string;
  byLLO: Array<{ llo: string; ind: Record<string, { value: number | null } | undefined> }>;
  byFLW: Array<{ flw?: string; key?: string; ind: Record<string, { value: number | null } | undefined> }>;
  programInd?: Record<string, { value: number | null } | undefined>;
}

export interface HeadlineResult {
  indicator: string;
  /** Best-minus-worst across the partner rows at the latest period is ≥ MIN_HEADLINE_SPREAD. */
  spread_ok: boolean;
  observed: string;
}

export interface SignalResult {
  kind: SignalKind;
  carrier: string;
  indicator: string;
  landed: boolean;
  observed: string;
}

export interface LandedThresholds {
  /** Minimum gap (in raw value units, 0.05 = 5 pts) between the carrier and the nearest other row. */
  minGap: number;
  /** Minimum first→last movement for a trend. */
  minTrendDelta: number;
}
export const DEFAULT_LANDED: LandedThresholds = { minGap: 0.05, minTrendDelta: 0.05 };

const val = (cell: { value: number | null } | undefined): number | null =>
  cell && typeof cell.value === 'number' && Number.isFinite(cell.value) ? cell.value : null;

const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

function workerName(row: GradedPeriod['byFLW'][number]): string {
  return row.flw ?? (row.key ? row.key.split('::').pop() ?? row.key : '');
}

/**
 * Compare the carrier against every other row at the LATEST period.
 * `extremeIsGood`: the carrier should be the best row (standout) vs the worst row
 * (lagging partner, data-quality problem).
 */
function extremeCheck(
  rows: Array<{ name: string; v: number | null }>,
  carrier: string,
  higherIsBetter: boolean,
  extremeIsGood: boolean,
  minGap: number,
): { landed: boolean; observed: string } {
  const mine = rows.find((r) => r.name === carrier);
  if (!mine || mine.v === null) return { landed: false, observed: `${carrier} has no graded value` };
  const others = rows.filter((r) => r.name !== carrier && r.v !== null) as Array<{ name: string; v: number }>;
  if (others.length === 0) return { landed: false, observed: 'no other rows to compare against' };
  // "high" means numerically greater. The carrier must sit at the high end when
  // (good extreme and higher is better) or (bad extreme and lower is better).
  const wantHigh = extremeIsGood === higherIsBetter;
  const nearest = wantHigh ? Math.max(...others.map((o) => o.v)) : Math.min(...others.map((o) => o.v));
  const gap = wantHigh ? mine.v - nearest : nearest - mine.v;
  return {
    landed: gap >= minGap,
    observed: `${carrier} ${pct(mine.v)} vs nearest other ${pct(nearest)} (gap ${(gap * 100).toFixed(1)} pts)`,
  };
}

export function verifyCascadeStoryLanded(
  plan: CascadeStoryPlan,
  periods: GradedPeriod[],
  thresholds: LandedThresholds = DEFAULT_LANDED,
): { verdict: 'pass' | 'fail'; results: SignalResult[]; headlines: HeadlineResult[] } {
  const ordered = [...periods].sort((a, b) => a.period_end.localeCompare(b.period_end));
  const latest = ordered[ordered.length - 1];
  const results: SignalResult[] = [];
  for (const s of plan.signals) {
    let out: { landed: boolean; observed: string };
    if (!latest) out = { landed: false, observed: 'no saved runs to grade against' };
    else if (s.kind === 'lagging_partner') {
      const rows = latest.byLLO.map((r) => ({ name: r.llo, v: val(r.ind[s.indicator]) }));
      out = extremeCheck(rows, s.carrier, s.higher_is_better, false, thresholds.minGap);
    } else if (s.kind === 'standout_worker' || s.kind === 'data_quality') {
      const rows = latest.byFLW.map((r) => ({ name: workerName(r), v: val(r.ind[s.indicator]) }));
      out = extremeCheck(rows, s.carrier, s.higher_is_better, s.kind === 'standout_worker', thresholds.minGap);
    } else {
      const series = ordered
        .map((p) =>
          s.carrier === 'programme'
            ? val(p.programInd?.[s.indicator])
            : val(p.byLLO.find((r) => r.llo === s.carrier)?.ind[s.indicator]),
        )
        .filter((v): v is number => v !== null);
      if (series.length < 2) out = { landed: false, observed: `${series.length} graded period(s) — a trend needs at least 2` };
      else {
        const delta = series[series.length - 1] - series[0];
        const moved = s.trend_direction === 'down' ? -delta : delta;
        out = {
          landed: moved >= thresholds.minTrendDelta,
          observed: `${s.carrier} ${pct(series[0])} → ${pct(series[series.length - 1])} over ${series.length} saved runs`,
        };
      }
    }
    results.push({ kind: s.kind, carrier: s.carrier, indicator: s.indicator, ...out });
  }
  // The headline must differ across partners in what labs GRADED, not only in
  // the plan (ace#2727): a pool can be written to spread and still saturate.
  const headlines: HeadlineResult[] = (plan.headline_indicators ?? []).map((ind) => {
    const vals = (latest?.byLLO ?? []).map((r) => ({ llo: r.llo, v: val(r.ind[ind]) })).filter((x): x is { llo: string; v: number } => x.v !== null);
    if (vals.length < 2) return { indicator: ind, spread_ok: false, observed: `${vals.length} graded partner value(s) — a spread needs at least 2` };
    const hi = Math.max(...vals.map((x) => x.v));
    const lo = Math.min(...vals.map((x) => x.v));
    return {
      indicator: ind,
      spread_ok: hi - lo >= MIN_HEADLINE_SPREAD,
      observed: `${ind} across ${vals.length} partners ${pct(lo)}–${pct(hi)} (spread ${((hi - lo) * 100).toFixed(1)} pts)`,
    };
  });
  const ok = results.length > 0 && results.every((r) => r.landed) && headlines.every((h) => h.spread_ok);
  return { verdict: ok ? 'pass' : 'fail', results, headlines };
}
