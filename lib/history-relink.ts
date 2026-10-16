/**
 * Relink a run's artifacts after `workflow_rebuild_history` (dimagi-internal/ace#2700).
 *
 * A rebuild REPLACES every period's saved run with a new one ("build and
 * complete the NEW run before deleting the old one", connect-labs
 * `workflow/history_rebuild.py`), so each period gets a fresh run id — on the
 * programme report AND on every opportunity report it hands down to. Nothing
 * else in ACE knew, so every URL naming an old id (realized.json, the
 * run_state products block, the summaries, the DDD narrative) went dead, and
 * the old id 404s as "not found". Measured on spark-facilitator/20261004-1706:
 * registry 7185 v2 → v3, rebuild replaced runs 7198..7254 with 7261..7317 and
 * hand-downs 7256/7257/7258 with 7319/7320/7321.
 *
 * The map is built from the source of truth — `workflow_history_runs` read
 * before and after the rebuild, matched per workflow on `period_end` — never
 * guessed from id arithmetic (the gaps between ids depend on what else labs
 * minted in between). A period present before and missing after is an error,
 * not a skip: a half-applied map is how a link goes dead silently.
 *
 * Pure.
 */

export interface HistoryRun {
  run_id: number;
  period_end: string;
}

export interface HistoryListing {
  /** The workflow definition the runs belong to (programme report or an opp report). */
  workflowId: number;
  runs: HistoryRun[];
}

export type RunIdMap = Map<number, number>;

/**
 * Old run id → new run id, per workflow, matched on `period_end`.
 * Unchanged ids (a period the rebuild skipped) are left out of the map.
 */
export function buildRunIdMap(before: HistoryListing[], after: HistoryListing[]): RunIdMap {
  const map: RunIdMap = new Map();
  for (const b of before) {
    const a = after.find((x) => x.workflowId === b.workflowId);
    if (!a) throw new Error(`buildRunIdMap: no after-listing for workflow ${b.workflowId}`);
    const byPeriod = new Map<string, number>();
    for (const r of a.runs) {
      if (byPeriod.has(r.period_end)) {
        throw new Error(`buildRunIdMap: workflow ${b.workflowId} has two runs for period ending ${r.period_end} after the rebuild`);
      }
      byPeriod.set(r.period_end, r.run_id);
    }
    for (const r of b.runs) {
      const next = byPeriod.get(r.period_end);
      if (next === undefined) {
        throw new Error(`buildRunIdMap: workflow ${b.workflowId} period ending ${r.period_end} (run ${r.run_id}) has no run after the rebuild`);
      }
      if (next !== r.run_id) map.set(r.run_id, next);
    }
  }
  return map;
}

export interface RelinkOptions {
  /**
   * Also replace bare occurrences of an old id (prose such as "run 7254" or
   * "runs 7198..7254"). Off by default: in a URL or a `run_id` field the
   * number can only be a run id, in prose it might be anything. Turn it on
   * for an artifact you have checked names these ids only as runs.
   *
   * A bare id must stand alone: not touching a letter, digit, `_` or `-` on
   * either side, so the leading hex run of a UUID (`7499fdb3-…`) or a
   * hyphen-joined UUID segment (`…-7499-…`) is never an id (ace#2731). The
   * cost: a hyphen range like "7198-7254" is neither rewritten nor reported;
   * write ranges as "7198..7254".
   */
  bare?: boolean;
}

export interface RelinkResult {
  text: string;
  replaced: number;
  /**
   * Old ids still sitting in a RUN-ID POSITION in the output: a `run_id` /
   * `source_run` URL param or field (anchored or not), or an element of a
   * `run_ids` list. Should be empty; non-empty means a dead link.
   *
   * Only run-id positions count (ace#3012): labs mints run ids, workflow ids
   * and labs-only program/opportunity ids from ONE sequence, so an old run id
   * can equal a `program_id=` / `opportunity_id=` / `workflow/<id>/` in the
   * same file, and counting every standalone occurrence reported a correctly
   * relinked realized.json as broken.
   */
  leftovers: number[];
  /**
   * Old ids standing alone OUTSIDE a run-id position (prose, other ids that
   * share labs' sequence). Informational only — they may be run ids in prose
   * (rewrite with `bare` once you have checked) or unrelated ids.
   */
  mentions: number[];
}

/**
 * Lookarounds for a standalone id: no identifier character or hyphen on
 * either side. Shared by the bare rewrite and the leftovers scan so a UUID
 * that merely starts with an old id is neither corrupted nor reported.
 */
const STANDALONE_BEFORE = '(?<![\\w-])';
const STANDALONE_AFTER = '(?![\\w-])';

function idPattern(map: RunIdMap): string {
  return [...map.keys()].sort((x, y) => y - x).map(String).join('|');
}

/**
 * Rewrite run ids in text. Always rewritten: URL params `run_id=` and
 * `source_run=`, and `run_id` fields in YAML (`run_id: N`) or JSON
 * (`"run_id": N`). With `bare`, every standalone occurrence.
 */
export function relinkText(text: string, map: RunIdMap, opts: RelinkOptions = {}): RelinkResult {
  if (map.size === 0) return { text, replaced: 0, leftovers: [], mentions: [] };
  const ids = idPattern(map);
  let replaced = 0;
  const swap = (id: string): string => {
    replaced += 1;
    return String(map.get(Number(id)));
  };
  let out = text.replace(
    new RegExp(`((?:[?&](?:run_id|source_run)=)|(?:\\brun_id"?\\s*:\\s*"?))(${ids})(?!\\d)`, 'g'),
    (_m, pre: string, id: string) => pre + swap(id),
  );
  if (opts.bare) {
    // Standalone (see RelinkOptions.bare), and not part of a decimal: not preceded by
    // "<digit>." nor followed by ".<digit>".
    out = out.replace(
      new RegExp(`${STANDALONE_BEFORE}(?<!\\d\\.)(${ids})${STANDALONE_AFTER}(?!\\.\\d)`, 'g'),
      (_m, id: string) => swap(id),
    );
  }
  const leftovers = new Set<number>();
  // Run-id positions: `run_id` / `source_run` as a URL param or a YAML/JSON
  // field, whether or not the rewrite above could anchor it.
  const positional = new RegExp(`(?<![\\w])(?:run_id|source_run)"?\\s*[=:]\\s*"?(${ids})(?!\\d)`, 'g');
  for (const m of out.matchAll(positional)) leftovers.add(Number(m[1]));
  // Elements of a `run_ids` list: inline `[a, b]` (YAML flow or JSON) or a YAML block list.
  const runIdsList = /(?<![\w])run_ids"?\s*:\s*(\[[^\]]*\]|(?:\s*\n\s*-\s*"?\d+"?)+)/g;
  const standaloneId = new RegExp(`${STANDALONE_BEFORE}(${ids})${STANDALONE_AFTER}`, 'g');
  for (const m of out.matchAll(runIdsList)) {
    for (const x of m[1].matchAll(standaloneId)) leftovers.add(Number(x[1]));
  }
  const mentions = [
    ...new Set((out.match(standaloneId) ?? []).map(Number).filter((n) => !leftovers.has(n))),
  ];
  return { text: out, replaced, leftovers: [...leftovers], mentions };
}

/**
 * Rewrite a parsed JSON/YAML value: every string is relinked (URL params and
 * `run_id` fields only), and every number held under a key named `run_id` or
 * inside a `run_ids` list is mapped. Returns a new value.
 */
export function relinkValue<T>(value: T, map: RunIdMap): T {
  const walk = (v: unknown, key: string | null, inRunIds: boolean): unknown => {
    if (typeof v === 'number') {
      return (key === 'run_id' || inRunIds) && map.has(v) ? map.get(v) : v;
    }
    if (typeof v === 'string') {
      if (key === 'run_id' && /^\d+$/.test(v) && map.has(Number(v))) return String(map.get(Number(v)));
      return relinkText(v, map).text;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, null, key === 'run_ids'));
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = walk(x, k, false);
      return o;
    }
    return v;
  };
  return walk(value, null, false) as T;
}

/** The run_state phase whose products a Phase 7 rebuild invalidates. */
export const SYNTHETIC_PHASE = 'synthetic-data-and-workflows';

export interface RunStateRelink {
  /**
   * An `update_yaml_file` patch (`merge: 'deep'`, via `localFilePath`) carrying
   * the WHOLE relinked products block — arrays such as `opp_reports[]` and
   * `source.dashboards[]` are replaced wholesale under every merge mode, so the
   * patch resends them complete.
   */
  patch: { phases: Record<string, { products: Record<string, unknown> }> };
  leftovers: number[];
  mentions: number[];
  /** True when anything in the block changed. */
  changed: boolean;
}

/**
 * Relink EVERY run id inside `phases.synthetic-data-and-workflows.products` of a
 * parsed run_state (ace#2739). The skill used to keep a hand list of fields to
 * relink, and the list missed `source.dashboards[].par_url` — so a rebuild left
 * seven dashboard links on dead ids. Walking the whole block means no list has
 * to be remembered: every `run_id=` / `source_run=` param, `run_id` field and
 * `run_ids` list is mapped wherever it sits, and anything still left in a
 * run-id position is reported as a leftover.
 */
export function relinkRunStateProducts(runState: unknown, map: RunIdMap, phase = SYNTHETIC_PHASE): RunStateRelink {
  const phases = (runState as { phases?: Record<string, { products?: unknown }> } | null)?.phases;
  const products = phases?.[phase]?.products;
  if (!products || typeof products !== 'object' || Array.isArray(products)) {
    throw new Error(`relinkRunStateProducts: run_state has no phases.${phase}.products block`);
  }
  const relinked = relinkValue(products as Record<string, unknown>, map);
  const text = JSON.stringify(relinked);
  const scan = relinkText(text, map);
  return {
    patch: { phases: { [phase]: { products: relinked } } },
    leftovers: scan.leftovers,
    mentions: scan.mentions,
    changed: text !== JSON.stringify(products),
  };
}
