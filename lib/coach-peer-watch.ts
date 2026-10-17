/**
 * Who the Coach may start with when the design sets no targets (ace#3053).
 *
 * Labs grades a cell red / yellow only against the registry's `bands`, and
 * `semantic-registry-author` writes bands only when the PDD states a target. A
 * target-less PDD therefore yields a report on which every cell is `unbanded`:
 * Labs' `start_ocs_outreach` briefs nobody (it skips "nothing red or yellow"),
 * the report draws no "Start coaching" button, and `workflow_run_indicators(band:
 * "red")` returns nothing (kaduna-graduation/20261015-1411: 60 workers x 6
 * indicators, every cell unbanded, while one mentor had 53.5% short-visit flags
 * against a 0.7% median).
 *
 * Labs has no relative band to fall back on: `connect_labs/semantic/snapshot.py`
 * `band_of` grades only against fixed `bands` thresholds, and its peer cohorts
 * (`semantic/cohorts.py`) feed benchmarks and coaching charts, never the grade.
 * So the selection is made here, from the same graded cells Labs returns:
 *
 *   (a) PEER WATCH — a worker whose figure on a coachable, target-less indicator
 *       sits well outside their peers' (beyond Tukey's fence, 1.5 x IQR past the
 *       near quartile, AND at least `minGap` from the peer median). It is a
 *       comparison with other workers, never a programme target, and the briefing
 *       says so in those words (#2778's rule: never call a level nobody set a goal).
 *   (b) NAMED — when nobody stands out, the workers a supervisor names. Their
 *       topics carry the peer comparison but no judgement.
 *
 * Either way the composed text is a full Labs-shaped briefing (`renderBriefing`)
 * passed as each worker item's `prompt`: Labs keeps a briefing it is handed as-is
 * (`workflow/actions.py` `_brief_workers`, `coach_briefing.is_briefing`), so the
 * worker is no longer skipped for having nothing red or yellow.
 *
 * Pure: no I/O.
 */

import {
  coachableIndicators,
  renderBriefing,
  type IndicatorCard,
  type RegistryMeasure,
} from "./coach-briefing.js";

/** One cell as `workflow_run_indicators` returns it. */
export interface RunIndicatorCell {
  band?: string | null;
  value?: number | null;
  n?: number | null;
}

/** One worker row as `workflow_run_indicators(scope: "worker")` returns it. */
export interface RunIndicatorWorker {
  key: string;
  name?: string | null;
  username?: string | null;
  organisation?: string | null;
  reds?: number | null;
  yellows?: number | null;
  indicators: Record<string, RunIndicatorCell>;
}

export interface PeerWatchOptions {
  /** Fewest peers a comparison may rest on. Labs' own floor (`cohorts.MIN_COHORT`). */
  minPeers?: number;
  /** Tukey fence multiplier. */
  fence?: number;
  /** Smallest distance from the peer median that counts, in display units
   *  (percentage points for a `%` indicator). Stops a tight spread from flagging
   *  a trivial difference. */
  minGap?: number;
  /** Most topics in one briefing. */
  maxTopics?: number;
}

export interface PeerTopic {
  key: string;
  label: string;
  unit: string;
  direction: "higher" | "lower";
  /** The worker's figure, in display units (percent for `%`). */
  value: number;
  /** The median of the OTHER workers' figures, in display units. */
  peerMedian: number;
  peerCount: number;
  /** How far past the fence, in display units — the ordering key. */
  excess: number;
  n?: number | null;
}

export interface CoachSelection {
  key: string;
  name: string;
  organisation?: string | null;
  topics: PeerTopic[];
}

export type SelectionMode = "band" | "peer_watch" | "named" | "none";

export interface CoachingSelection {
  mode: SelectionMode;
  workers: CoachSelection[];
  /** Why the selection is what it is — always non-empty for `none`. */
  reasons: string[];
  /** Names a supervisor gave that match no worker on the run. */
  unmatched: string[];
}

const DEFAULTS: Required<PeerWatchOptions> = {
  minPeers: 8,
  fence: 1.5,
  minGap: 10,
  maxTopics: 3,
};

/** Labs returns a `%` indicator's value as a fraction (0.74), and prints it as 74%. */
function display(value: number, unit: string): number {
  return unit === "%" ? value * 100 : value;
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Target-less coachable indicators: the only ones peer watch speaks for. A banded
 *  indicator is Labs' to grade, and a peer figure must never compete with a target. */
function peerCards(cards: IndicatorCard[]): IndicatorCard[] {
  return cards.filter(
    (c) =>
      !(c.bands && c.bands.length) &&
      c.target === undefined &&
      c.direction !== "none",
  );
}

function graded(
  cell: RunIndicatorCell | undefined,
): cell is RunIndicatorCell & { value: number } {
  // Only `unbanded` cells carry a figure that is both credible and ungraded; an
  // `insufficient` / `notcredible` / `nodata` cell is not a figure to compare.
  return (
    !!cell &&
    cell.band === "unbanded" &&
    typeof cell.value === "number" &&
    Number.isFinite(cell.value)
  );
}

function standing(
  worker: RunIndicatorWorker,
  card: IndicatorCard,
  all: RunIndicatorWorker[],
): { value: number; peers: number[] } | undefined {
  const own = worker.indicators[card.key];
  if (!graded(own)) return undefined;
  const peers = all
    .filter((w) => w.key !== worker.key)
    .map((w) => w.indicators[card.key])
    .filter(graded)
    .map((c) => display(c.value, card.unit))
    .sort((a, b) => a - b);
  return { value: display(own.value, card.unit), peers };
}

function topicFor(
  worker: RunIndicatorWorker,
  card: IndicatorCard,
  all: RunIndicatorWorker[],
  o: Required<PeerWatchOptions>,
): (PeerTopic & { watch: boolean }) | undefined {
  const s = standing(worker, card, all);
  if (!s || s.peers.length < o.minPeers) return undefined;
  const q1 = quantile(s.peers, 0.25);
  const med = quantile(s.peers, 0.5);
  const q3 = quantile(s.peers, 0.75);
  const iqr = q3 - q1;
  const higher = card.direction === "higher";
  const fenceAt = higher ? q1 - o.fence * iqr : q3 + o.fence * iqr;
  const past = higher ? fenceAt - s.value : s.value - fenceAt;
  const gap = higher ? med - s.value : s.value - med;
  return {
    key: card.key,
    label: card.label,
    unit: card.unit,
    direction: card.direction as "higher" | "lower",
    value: s.value,
    peerMedian: med,
    peerCount: s.peers.length,
    excess: past,
    n: worker.indicators[card.key]?.n,
    watch: past > 0 && gap >= o.minGap,
  };
}

function workerName(w: RunIndicatorWorker): string {
  return w.name || w.username || w.key;
}

/**
 * (a) Workers well outside their peers on at least one coachable, target-less
 * indicator, most topics first, then the furthest out. Each worker's topics are
 * only the indicators they stand out on.
 */
export function selectPeerWatch(
  workers: RunIndicatorWorker[],
  measures: RegistryMeasure[],
  options: PeerWatchOptions = {},
): CoachSelection[] {
  const o = { ...DEFAULTS, ...options };
  const cards = peerCards(coachableIndicators(measures));
  const out: CoachSelection[] = [];
  for (const w of workers) {
    const topics = cards
      .map((c) => topicFor(w, c, workers, o))
      .filter((t): t is PeerTopic & { watch: boolean } => !!t && t.watch)
      .sort((a, b) => b.excess - a.excess)
      .slice(0, o.maxTopics)
      .map(({ watch: _watch, ...t }) => t);
    if (topics.length)
      out.push({
        key: w.key,
        name: workerName(w),
        organisation: w.organisation,
        topics,
      });
  }
  return out.sort(
    (a, b) =>
      b.topics.length - a.topics.length ||
      b.topics[0].excess - a.topics[0].excess ||
      a.key.localeCompare(b.key),
  );
}

/**
 * (b) The workers a supervisor named (by name, username or worker key, any case).
 * Topics are every coachable target-less indicator the worker has a figure for,
 * worst-placed against peers first — offered for discussion, never as a verdict.
 */
export function selectNamedWorkers(
  workers: RunIndicatorWorker[],
  measures: RegistryMeasure[],
  names: string[],
  options: PeerWatchOptions = {},
): { workers: CoachSelection[]; unmatched: string[] } {
  const o = { ...DEFAULTS, ...options };
  const cards = peerCards(coachableIndicators(measures));
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
  const picked: CoachSelection[] = [];
  const unmatched: string[] = [];
  for (const raw of names) {
    const want = norm(raw);
    if (!want) continue;
    const hits = workers.filter((w) =>
      [w.key, w.username, w.name].some((v) => norm(v) === want),
    );
    if (hits.length !== 1) {
      // Zero hits, or a name two workers share: never guess which one was meant.
      unmatched.push(raw);
      continue;
    }
    const w = hits[0];
    if (picked.some((p) => p.key === w.key)) continue;
    const topics = cards
      .map((c) => topicFor(w, c, workers, o))
      .filter((t): t is PeerTopic & { watch: boolean } => !!t)
      .sort((a, b) => b.excess - a.excess)
      .slice(0, o.maxTopics)
      .map(({ watch: _watch, ...t }) => t);
    picked.push({
      key: w.key,
      name: workerName(w),
      organisation: w.organisation,
      topics,
    });
  }
  return { workers: picked, unmatched };
}

/**
 * The one rule for who a Coach starts with. Red/yellow cells (a PDD with targets)
 * are Labs' to brief, so `band` returns those workers' keys and nothing else. With
 * none, peer watch; with nobody well outside their peers, the supervisor's named
 * list; with neither, `none` and the reason — never an empty success.
 */
export function selectCoachingWorkers(input: {
  workers: RunIndicatorWorker[];
  measures: RegistryMeasure[];
  named?: string[];
  options?: PeerWatchOptions;
}): CoachingSelection {
  const { workers, measures, named = [], options } = input;
  const banded = workers.filter((w) => (w.reds ?? 0) + (w.yellows ?? 0) > 0);
  if (banded.length) {
    return {
      mode: "band",
      workers: banded.map((w) => ({
        key: w.key,
        name: workerName(w),
        organisation: w.organisation,
        topics: [],
      })),
      reasons: [
        "Labs grades these workers red or yellow against the design targets; it writes their briefings.",
      ],
      unmatched: [],
    };
  }
  const reasons: string[] = [];
  const cards = peerCards(coachableIndicators(measures));
  if (!cards.length) {
    reasons.push(
      "No coachable indicator without a target: nothing to compare workers on.",
    );
  } else {
    const watch = selectPeerWatch(workers, measures, options);
    if (watch.length)
      return { mode: "peer_watch", workers: watch, reasons: [], unmatched: [] };
    reasons.push(
      "No worker is well outside their peers on any coachable indicator.",
    );
  }
  if (named.length) {
    const { workers: picked, unmatched } = selectNamedWorkers(
      workers,
      measures,
      named,
      options,
    );
    if (unmatched.length)
      reasons.push(
        `Named but not on this run (or ambiguous): ${unmatched.join(", ")}.`,
      );
    if (picked.length)
      return { mode: "named", workers: picked, reasons, unmatched };
    return { mode: "none", workers: [], reasons, unmatched };
  }
  reasons.push(
    "Ask the supervisor which workers to coach (the named-list fallback).",
  );
  return { mode: "none", workers: [], reasons, unmatched: [] };
}

function fmt(n: number, unit: string): string {
  const r = Math.round(n * 10) / 10;
  return !unit || unit === "%" ? `${r}${unit}` : `${r} ${unit}`;
}

/**
 * The briefing for a peer-watch or named worker, in Labs' briefing shape so Labs
 * keeps it verbatim and reads its topics back (`coach_briefing._TOPIC_LINE`: the
 * band must be one token). The band is `peer-watch` for (a) and `unbanded` for
 * (b); the selection line says, in words, that the comparison is with peers and
 * that the programme set no target.
 */
export function renderSelectionBriefing(b: {
  programName: string;
  workerPlural: string;
  worker: CoachSelection;
  mode: "peer_watch" | "named";
  language?: string;
  qaTester?: string;
}): string {
  const peerWord = b.workerPlural;
  const selection =
    b.mode === "peer_watch"
      ? `Why this worker: their figures below are well outside most other ${peerWord}' — a comparison with peers. ` +
        "The programme sets no target for these, so never call the peer figure a goal or a target."
      : `Why this worker: the programme team asked for a check-in. The programme sets no target for these topics, ` +
        `so explore them alongside how other ${peerWord} are doing; do not call a figure good or bad.`;
  return renderBriefing({
    programName: b.programName,
    workerName: b.worker.name,
    language: b.language,
    qaTester: b.qaTester,
    selection,
    topics: b.worker.topics.map((t) => ({
      key: t.key,
      label: t.label,
      figure: `${fmt(t.value, t.unit)} (median of ${t.peerCount} other ${peerWord}: ${fmt(t.peerMedian, t.unit)})`,
      band: b.mode === "peer_watch" ? "peer-watch" : "unbanded",
    })),
  });
}
