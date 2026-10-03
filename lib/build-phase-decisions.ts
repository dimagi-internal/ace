/**
 * The build phases log their calls as decision rows, and the boundary fence
 * can see when they did not (dimagi-internal/ace#2384, a regression of #399).
 *
 * ## The defect this guards
 *
 * `decisions.yaml` is the register ace-web renders on the public run page, with
 * a comment box and an answer editor on every row, and those edits carry into
 * the next run. Since 2026-10-03 it is also the run's ONLY review artifact —
 * the per-run build memo is retired (docs/decisions-contract.md). For the app
 * build it used to be empty:
 *
 *   poverty-graduation/20260905-1345  61 rows — 3-commcare: 0
 *   poverty-graduation/20260908-0510  66 rows — commcare-setup: 0
 *
 * while the same build recorded its calls as memo prose that no reviewer could
 * comment on.
 *
 * ## What this checks
 *
 * Per PRODUCER, not per phase: a build producer whose summary artifact is in
 * Drive (so it ran) and whose `skill` tag carries ZERO live rows in this
 * phase's decisions is `silent`, and fails the boundary. Every build makes
 * calls a reviewer must see — which modules, which bounds, how each payment
 * rule is enforced — so a build with no rows is a build whose choices are
 * invisible. The count is per producer on purpose: `app-test-cases` writes
 * `3-commcare` rows from the same dispatch site, and a phase-level count would
 * let a test-harness row stand in for a Learn build that logged nothing.
 *
 * A producer with rows but some live partner-facing rows lacking `plain` is
 * reported as a warning (the v6 contract requires `plain`; old rows predate
 * it).
 *
 * Wired into the boundary fence through `verify_phase_artifacts`, which returns
 * this report as `decisions` for the `commcare` and `connect` phases. It is
 * deliberately NOT folded into `missing[]`: that list heals by re-dispatching
 * the producer, and re-running `pdd-to-deliver-app` to repair a log would
 * rebuild the app. Heal by appending the rows.
 */

import yaml from 'yaml';

import type { Phase } from './artifact-manifest.js';
import { isInternalDecision } from './decision-review.js';
import type { DriveListAdapter } from './phase-closeout.js';

export interface BuildProducer {
  /** The producing skill. Its decision rows carry this as `skill`. */
  producer: string;
  /** Run-folder-relative path of its summary artifact — present means it ran. */
  path: string;
}

export interface BuildPhaseDecisionContract {
  phase: Phase;
  /** The `phase` tag this phase's decision rows carry (`<N>-<name>`). */
  decisionPhaseTag: string;
  sources: readonly BuildProducer[];
}

/** The build phases whose producers owe decision rows. */
export const BUILD_PHASE_DECISION_CONTRACTS: Readonly<Partial<Record<Phase, BuildPhaseDecisionContract>>> = {
  commcare: {
    phase: 'commcare',
    decisionPhaseTag: '3-commcare',
    sources: [
      { producer: 'pdd-to-learn-app', path: '3-commcare/pdd-to-learn-app_summary.md' },
      { producer: 'pdd-to-deliver-app', path: '3-commcare/pdd-to-deliver-app_summary.md' },
    ],
  },
  connect: {
    phase: 'connect',
    decisionPhaseTag: '4-connect',
    sources: [{ producer: 'connect-opp-setup', path: '4-connect/connect-opp-setup.md' }],
  },
};

// ── Decision rows ───────────────────────────────────────────────────────────

export interface DecisionRowRef {
  id?: unknown;
  phase?: unknown;
  skill?: unknown;
  superseded_by?: unknown;
  audience?: unknown;
  plain?: unknown;
}

/**
 * Read the rows out of a decisions.yaml body, leniently. Schema validity is
 * `decisions-render`'s gate, not this one. An unparseable log yields no rows
 * and a note, so a silent producer still fails — with the parse error in the
 * message instead of a misleading zero.
 */
export function decisionRowsFromYaml(text: string | null): { rows: DecisionRowRef[]; note?: string } {
  if (text === null) return { rows: [], note: 'decisions.yaml is not in the run folder' };
  let parsed: unknown;
  try {
    parsed = yaml.parse(text.replace(/^﻿/, ''));
  } catch (e: any) {
    return { rows: [], note: `decisions.yaml did not parse: ${e?.message ?? e}` };
  }
  const decisions = (parsed as { decisions?: unknown } | null)?.decisions;
  if (!Array.isArray(decisions)) return { rows: [], note: 'decisions.yaml has no top-level `decisions:` list' };
  return { rows: decisions.filter((r): r is DecisionRowRef => typeof r === 'object' && r !== null) };
}

// ── The check ───────────────────────────────────────────────────────────────

export type ProducerVerdict =
  /** ran, and wrote at least one live row */
  | 'ok'
  /** ran (summary present) and wrote ZERO live rows — fails the boundary */
  | 'silent'
  /** the summary is not in Drive — `verify_phase_artifacts.missing` owns that */
  | 'absent';

export interface ProducerDecisionFinding {
  producer: string;
  path: string;
  verdict: ProducerVerdict;
  /** Live rows in decisions.yaml with this phase's tag and `skill: <producer>`. */
  decision_rows: number;
  /** ids of its live partner-facing rows with no `plain` (schema v6). */
  missing_plain: string[];
}

export interface BuildPhaseDecisionsReport {
  phase: Phase;
  decision_phase: string;
  /** False iff some producer is `silent` (or the inputs could not be read). */
  ok: boolean;
  /** Set when a Drive read threw — the check did not run. Never a pass. */
  unreadable?: boolean;
  producers: ProducerDecisionFinding[];
  /** The `silent` producers — what the orchestrator heals. */
  failures: ProducerDecisionFinding[];
  warnings: string[];
  /** Narration-ready one-liner. */
  summary: string;
}

export interface CheckBuildPhaseDecisionsInput {
  phase: Phase;
  /** Which producer summaries are in Drive, keyed by the source's `path`. */
  present: Readonly<Record<string, boolean>>;
  /** decisions.yaml text; `null` = not in the run folder. */
  decisionsYaml: string | null;
}

/**
 * Pure. Throws for a phase with no contract — callers gate on
 * {@link BUILD_PHASE_DECISION_CONTRACTS} (as {@link verifyBuildPhaseDecisions}
 * does) so the report is attached only where it applies.
 */
export function checkBuildPhaseDecisions(input: CheckBuildPhaseDecisionsInput): BuildPhaseDecisionsReport {
  const contract = BUILD_PHASE_DECISION_CONTRACTS[input.phase];
  if (!contract) {
    throw new Error(
      `checkBuildPhaseDecisions: phase ${JSON.stringify(input.phase)} has no build-phase contract ` +
        `(contracted: ${Object.keys(BUILD_PHASE_DECISION_CONTRACTS).join(', ')})`,
    );
  }
  const { rows, note } = decisionRowsFromYaml(input.decisionsYaml);
  const warnings: string[] = [];

  const producers: ProducerDecisionFinding[] = contract.sources.map(({ producer, path }) => {
    const mine = rows.filter(
      (r) => r.phase === contract.decisionPhaseTag && r.skill === producer && r.superseded_by === undefined,
    );
    const missing_plain = mine
      .filter((r) => r.plain === undefined && r.audience !== 'internal' && !isInternalDecision(r))
      .map((r) => String(r.id));
    const verdict: ProducerVerdict = !input.present[path] ? 'absent' : mine.length === 0 ? 'silent' : 'ok';
    if (verdict === 'ok' && missing_plain.length > 0) {
      warnings.push(
        `${producer}: ${missing_plain.length} live partner-facing row(s) have no \`plain\` line ` +
          `(${missing_plain.slice(0, 5).join(', ')}${missing_plain.length > 5 ? ', …' : ''}) — a reviewer reads ` +
          `the decisions log instead of a build memo, so each row must say what it chose (docs/decisions-contract.md).`,
      );
    }
    return { producer, path, verdict, decision_rows: mine.length, missing_plain };
  });

  const failures = producers.filter((p) => p.verdict === 'silent');
  if (note && failures.length > 0) warnings.push(note);

  const summary =
    failures.length > 0
      ? `FAIL — ${failures
          .map((f) => `${f.producer} ran (${f.path}) and wrote 0 live decision rows (phase ${contract.decisionPhaseTag}, skill ${f.producer})`)
          .join('; ')}. A reviewer sees none of its choices — append them with decisions_append_rows.`
      : `decision rows present for every build producer that ran — ${producers
          .map((p) => (p.verdict === 'absent' ? `${p.producer}: summary not in Drive` : `${p.producer}: ${p.decision_rows} row(s)`))
          .join('; ')}`;

  return { phase: input.phase, decision_phase: contract.decisionPhaseTag, ok: failures.length === 0, producers, failures, warnings, summary };
}

/**
 * The report for a check that could not run because a Drive read threw. It
 * fails, because a gate that cannot read its inputs has not passed anything.
 */
export function unreadableBuildPhaseDecisions(phase: Phase, message: string): BuildPhaseDecisionsReport | null {
  const contract = BUILD_PHASE_DECISION_CONTRACTS[phase];
  if (!contract) return null;
  return {
    phase,
    decision_phase: contract.decisionPhaseTag,
    ok: false,
    unreadable: true,
    producers: [],
    failures: [],
    warnings: [],
    summary: `could not check build-phase decision rows — a Drive read failed: ${message}`,
  };
}

// ── IO wrapper (the atom injects the Drive client) ─────────────────────────

export interface DriveReadAdapter extends DriveListAdapter {
  /** Text of one file — a Google Doc exported as text/plain, or raw text. */
  readText(fileId: string): Promise<string>;
}

const FOLDER_MIMETYPE = 'application/vnd.google-apps.folder';
const DECISIONS_NAMES = new Set(['decisions.yaml', 'decisions']);

function stripDocExtension(name: string): string {
  return name.replace(/\.(md|markdown)$/i, '');
}

/**
 * Find each producer's summary and decisions.yaml in Drive and run
 * {@link checkBuildPhaseDecisions}. A Google Doc named without its `.md`
 * suffix still matches (the ace#786 tolerance `verify_phase_artifacts` uses).
 * Returns `null` for a phase with no contract; throws on a failed read — the
 * caller turns that into {@link unreadableBuildPhaseDecisions}.
 */
export async function verifyBuildPhaseDecisions(
  drive: DriveReadAdapter,
  runFolderId: string,
  phase: Phase,
): Promise<BuildPhaseDecisionsReport | null> {
  const contract = BUILD_PHASE_DECISION_CONTRACTS[phase];
  if (!contract) return null;

  const runChildren = await drive.listFolder(runFolderId);
  const decisionsFile = runChildren.find((c) => DECISIONS_NAMES.has(c.name) && c.mimeType !== FOLDER_MIMETYPE);

  const folderName = contract.sources[0].path.split('/')[0];
  const phaseFolder = runChildren.find((c) => c.name === folderName && c.mimeType === FOLDER_MIMETYPE);
  const phaseChildren = phaseFolder ? await drive.listFolder(phaseFolder.id) : [];
  const present: Record<string, boolean> = {};
  for (const { path } of contract.sources) {
    const base = path.split('/').slice(1).join('/');
    present[path] = phaseChildren.some(
      (c) => c.mimeType !== FOLDER_MIMETYPE && (c.name === base || c.name === stripDocExtension(base)),
    );
  }

  const decisionsYaml = decisionsFile ? await drive.readText(decisionsFile.id) : null;
  return checkBuildPhaseDecisions({ phase, present, decisionsYaml });
}
