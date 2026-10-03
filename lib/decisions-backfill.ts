/**
 * Upgrade an EXISTING run's decisions.yaml to the v6 review contract
 * (`docs/decisions-contract.md`) — the one-time half of retiring the build
 * memo. New runs get the fields from their producers, the write boundary and
 * `decisions_enrich`; a run that finished under the memo regime has its
 * reviewer-facing content in the memo instead, so the backfill harvests it:
 *
 *   1. stale inherited rows (a fork's source rows for the phases it re-ran)
 *      are retired — onto the re-run row that replaced them where the memo's
 *      provenance appendix names it ("X (and the inherited Y)"), kept live
 *      where the memo cites them as current, retired as history otherwise;
 *   2. the memo's choices table ("What the build chose, and why" / "Where to
 *      check" / "What correct looks like") lands on the rows its appendix
 *      cites, as `plain` / `check_at` / `correct_looks_like`;
 *   3. the memo's harness list marks those rows `audience: internal`;
 *   4. an optional overlay (hand-written plain wording for rows the memo
 *      never covered) is applied;
 *   5. `enrichDecisionsLog` adds everything deterministic — rule scope and
 *      enforcement, cross-skill dedupe, and the review asks, including open
 *      residuals that lived only in run_state.
 *
 * Pure; the script `scripts/backfill-decisions-contract.ts` does the I/O.
 */

import { PHASE_DEFS } from './artifact-manifest.js';
import { rec, str } from './decision-review.js';
import { enrichDecisionsLog, type EnrichReport } from './decisions-enrich.js';
import { retireStaleInherited, type RetireStaleReport } from './decisions-rerun.js';
import type { DecisionRow, DecisionsLog } from './decisions-schema.js';

// ── Memo harvest ───────────────────────────────────────────────────────────

export interface MemoChoice {
  n: number;
  plain: string;
  checkAt: string;
  correctLooksLike: string;
  /** decisions.yaml ids the appendix cites for this item, current first. */
  ids: string[];
  /** ids the appendix names as "the inherited …" for this item. */
  inherited: string[];
}

export interface MemoHarvest {
  choices: MemoChoice[];
  /** ids the memo moved out of its table as ACE's own test harness. */
  harness: string[];
}

function unescapeMd(s: string): string {
  return s.replace(/\\([\\`*_{}\[\]()#+\-.!=|>~])/g, '$1').replace(/\s+/g, ' ').trim();
}

function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && line[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '|') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.slice(1, -1).map((c) => c.trim());
}

const ID = /[a-z0-9]+(?:-[a-z0-9]+)+/g;

/**
 * Parse a build memo exported as markdown: its choices table and the
 * `Appendix A2` provenance lines (`* N: …; decisions.yaml a, b (and the
 * inherited c, d); …`).
 */
export function harvestMemo(markdown: string): MemoHarvest {
  const lines = markdown.split('\n');
  const head = lines.findIndex((l) => /^\|.*What the build chose.*\|.*Where to check.*\|.*What correct looks like/i.test(l));
  const table = new Map<number, { plain: string; checkAt: string; correct: string }>();
  if (head >= 0) {
    for (let i = head + 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
      const c = cells(lines[i]);
      const n = Number(unescapeMd(c[0] ?? ''));
      if (!Number.isInteger(n)) continue;
      table.set(n, { plain: unescapeMd(c[1] ?? ''), checkAt: unescapeMd(c[2] ?? ''), correct: unescapeMd(c[3] ?? '') });
    }
  }
  const choices: MemoChoice[] = [];
  const harness: string[] = [];
  for (const raw of lines) {
    const line = unescapeMd(raw);
    const m = /^[*-]\s+(\d+):\s+(.*)$/.exec(line);
    if (m) {
      const n = Number(m[1]);
      const body = m[2];
      const dm = /decisions\.yaml\s+([^;]*)/.exec(body);
      const ids: string[] = [];
      const inherited: string[] = [];
      if (dm) {
        const seg = dm[1];
        const inh = /\(and the inherited ([^)]*)\)/.exec(seg);
        if (inh) inherited.push(...(inh[1].match(ID) ?? []));
        ids.push(...(seg.replace(/\(and the inherited [^)]*\)/, '').match(ID) ?? []));
      }
      const t = table.get(n);
      if (t) {
        choices.push({
          n,
          plain: t.plain,
          checkAt: t.checkAt,
          correctLooksLike: /^[—–-]/.test(t.correct) ? '' : t.correct,
          ids,
          inherited,
        });
      }
      continue;
    }
    if (/test-harness choices/i.test(line)) {
      const seg = line.split(/decisions\.yaml/)[1] ?? '';
      harness.push(...(seg.replace(/\([^)]*\)/g, '').match(ID) ?? []));
    }
  }
  return { choices, harness };
}

// ── Overlay ────────────────────────────────────────────────────────────────

export interface RowOverlay {
  plain?: string;
  plain_question?: string;
  plain_value?: string;
  /** Applied after enrichment, to a row that carries (or gets) a review ask. */
  confirm_reason?: string;
  check_at?: string;
  correct_looks_like?: string;
  audience?: 'partner' | 'internal';
}

export interface BackfillOverlay {
  rows?: Record<string, RowOverlay>;
  /** inherited id → re-run successor. */
  successors?: Record<string, string>;
  /** inherited ids the re-run re-affirmed. */
  reaffirmed?: string[];
}

// ── The backfill ───────────────────────────────────────────────────────────

export interface BackfillInput {
  log: DecisionsLog;
  runState: unknown;
  /** The fork source run's decisions.yaml (needed to know which rows were inherited). */
  sourceLog?: DecisionsLog;
  memo?: MemoHarvest;
  overlay?: BackfillOverlay;
}

export interface BackfillReport {
  retire: RetireStaleReport | null;
  /** ids the memo's table filled. */
  fromMemo: string[];
  /** ids the overlay filled. */
  fromOverlay: string[];
  /** overlay / memo ids that are not live rows. */
  unknownIds: string[];
  enrich: EnrichReport;
}

function forkOrdinal(runState: unknown): number | null {
  const at = str(rec(runState).forked_from_phase);
  if (!at) return null;
  const def = PHASE_DEFS.find((p) => p.agentName === at || p.key === at);
  return def ? def.ordinal : null;
}

export function backfillDecisionsLog(input: BackfillInput): { log: DecisionsLog; report: BackfillReport } {
  let log: DecisionsLog = JSON.parse(JSON.stringify(input.log));
  const report: BackfillReport = { retire: null, fromMemo: [], fromOverlay: [], unknownIds: [], enrich: undefined as never };
  const memo = input.memo ?? { choices: [], harness: [] };

  // 1. Stale inherited rows.
  const fromOrdinal = forkOrdinal(input.runState);
  const sourceRun = str(rec(input.runState).forked_from);
  if (input.sourceLog && fromOrdinal !== null && sourceRun) {
    const inheritedIds = new Set(
      input.sourceLog.decisions.filter((d) => Number(d.phase.split('-')[0]) >= fromOrdinal).map((d) => d.id),
    );
    const successors: Record<string, string> = {};
    const reaffirmed = new Set<string>(input.overlay?.reaffirmed ?? []);
    for (const c of memo.choices) {
      const current = c.ids.find((id) => !inheritedIds.has(id)) ?? c.ids[0];
      for (const old of c.inherited) if (current) successors[old] = current;
      for (const id of c.ids) if (inheritedIds.has(id)) reaffirmed.add(id);
    }
    for (const id of memo.harness) if (inheritedIds.has(id)) reaffirmed.add(id);
    Object.assign(successors, input.overlay?.successors ?? {});
    for (const old of Object.keys(successors)) reaffirmed.delete(old);
    const r = retireStaleInherited(log, { inheritedIds, fromOrdinal, label: sourceRun, successors, reaffirmed });
    log = r.log;
    report.retire = r.report;
  }

  const live = () => new Map(log.decisions.filter((d) => d.superseded_by === undefined).map((d) => [d.id, d]));

  // 2. The memo's choices table.
  let byId = live();
  for (const c of memo.choices) {
    const target = c.ids.map((id) => byId.get(id)).find((r): r is DecisionRow => r !== undefined);
    if (!target) {
      report.unknownIds.push(...c.ids);
      continue;
    }
    if (c.plain) target.plain = c.plain;
    if (c.checkAt) target.check_at = c.checkAt;
    if (c.correctLooksLike) target.correct_looks_like = c.correctLooksLike;
    report.fromMemo.push(target.id);
    for (const id of c.ids) {
      const other = byId.get(id);
      if (!other || other === target) continue;
      if (c.checkAt && other.check_at === undefined) other.check_at = c.checkAt;
      if (c.correctLooksLike && other.correct_looks_like === undefined) other.correct_looks_like = c.correctLooksLike;
    }
  }

  // 3. The memo's harness list.
  for (const id of memo.harness) {
    const r = byId.get(id);
    if (r) r.audience = 'internal';
  }

  // 4. The overlay — before enrichment so derived asks keep the wording, and
  //    again after it for rows enrichment synthesized (an open residual).
  const applyOverlay = (target: DecisionsLog, only?: Set<string>): string[] => {
    const rows = new Map(target.decisions.filter((d) => d.superseded_by === undefined).map((d) => [d.id, d]));
    const missing: string[] = [];
    for (const [id, o] of Object.entries(input.overlay?.rows ?? {})) {
      if (only && !only.has(id)) continue;
      const r = rows.get(id);
      if (!r) {
        missing.push(id);
        continue;
      }
      for (const f of ['plain', 'plain_question', 'plain_value', 'check_at', 'correct_looks_like', 'audience'] as const) {
        if (o[f] !== undefined) (r as Record<string, unknown>)[f] = o[f];
      }
      if (o.confirm_reason !== undefined && r.review_ask !== undefined) r.confirm_reason = o.confirm_reason;
      report.fromOverlay.push(id);
    }
    return missing;
  };
  const deferred = applyOverlay(log);

  // 5. Everything deterministic.
  const enriched = enrichDecisionsLog(log, { runState: input.runState });
  const after = applyOverlay(enriched.log);
  report.unknownIds.push(...after);
  report.fromOverlay = [...new Set(report.fromOverlay)];
  if (deferred.length) {
    // the overlay may have filled `plain` on a synthesized row
    enriched.report.missingPlain = enriched.report.missingPlain.filter(
      (id) => enriched.log.decisions.find((d) => d.id === id)?.plain === undefined,
    );
  }
  report.enrich = enriched.report;
  return { log: enriched.log, report };
}
