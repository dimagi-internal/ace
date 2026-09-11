/**
 * The build phases log their calls as decision rows, and the boundary fence
 * can see when they did not (dimagi-internal/ace#2384, a regression of #399).
 *
 * ## The defect this guards
 *
 * `decisions.yaml` is the register ace-web renders on the public run page, with
 * a comment box and an answer editor on every row, and those edits carry into
 * the next run. For the app build it was empty:
 *
 *   poverty-graduation/20260905-1345  61 rows — 3-commcare: 0
 *   poverty-graduation/20260908-0510  66 rows — commcare-setup: 0
 *
 * Meanwhile the same build DID record its calls, as prose: the Deliver
 * summary's `## Build memo` section carries `### [ACE] latitudes taken` and
 * `### [FIXED] ambiguities hit` tables, and the Learn build memo carries the
 * same two. Those are exactly the rows the register exists for — an `[ACE]`
 * latitude is an `inferred` default, a `[FIXED]` ambiguity is a `conflicting`
 * one — and none reached the surface a reviewer can comment on.
 *
 * The fence could not see it. `agents/orchestrator-reference.md`'s Decisions
 * log clause said the orchestrator "stub-fills + warns post-phase if a phase
 * wrote zero rows AND the calibration set for that phase has any required
 * rows". Two things were wrong with that. Phase 3's catalogue has no required
 * rows, so the condition could never fire for the app build. And nothing
 * implemented it at all — the clause was prose with no code behind it.
 *
 * ## What this checks
 *
 * The obligation is derived from the phase's OWN memo, not from a catalogue:
 * a producer whose memo lists any latitude, ambiguity or (Phase 4) verification
 * rule, and whose `skill` tag carries zero rows in this phase's decisions, is
 * `silent` and fails the boundary. A memo that says `None.` owes no rows.
 *
 * The check is per PRODUCER, not per phase, on purpose. `app-test-cases`
 * writes `test-scenario-count` rows tagged `phase: 3-commcare` from the same
 * dispatch site (`agents/commcare-setup.md` Step 2.6), so a phase-level count
 * would let a test-case row stand in for a Learn build that logged nothing —
 * the same shape as #399, one level down.
 *
 * Fewer rows than memo items is reported as a warning, not a failure. The
 * gate is the zero: a build that logged SOMETHING is visibly on the register
 * and a reviewer can see what is missing from it; a build that logged nothing
 * is invisible there.
 *
 * Wired into the boundary fence through `verify_phase_artifacts` (the
 * unconditional Drive-reading call in Turn N+1), which returns this report as
 * `decisions` for the `commcare` and `connect` phases. It is deliberately NOT
 * folded into `missing[]`: that list heals by re-dispatching the producer,
 * and re-running `pdd-to-deliver-app` to repair a log would rebuild the app.
 */

import yaml from 'yaml';

import type { Phase } from './artifact-manifest.js';
import type { DriveListAdapter } from './phase-closeout.js';

export type BuildMemoKind = 'latitude' | 'ambiguity' | 'verification-rule';

export interface BuildMemoSource {
  /** The producing skill. Its decision rows carry this as `skill`. */
  producer: string;
  /** Run-folder-relative path of the file that carries its memo sections. */
  path: string;
}

export interface BuildPhaseDecisionContract {
  phase: Phase;
  /** The `phase` tag this phase's decision rows carry (`<N>-<name>`). */
  decisionPhaseTag: string;
  sources: readonly BuildMemoSource[];
}

/**
 * The build phases whose memo sections owe decision rows. The paths are the
 * same files `skills/build-memo` composes the programme memo from, so the
 * memo and the register read one source.
 */
export const BUILD_PHASE_DECISION_CONTRACTS: Readonly<
  Partial<Record<Phase, BuildPhaseDecisionContract>>
> = {
  commcare: {
    phase: 'commcare',
    decisionPhaseTag: '3-commcare',
    sources: [
      { producer: 'pdd-to-learn-app', path: '3-commcare/pdd-to-learn-app_build-memo.md' },
      { producer: 'pdd-to-deliver-app', path: '3-commcare/pdd-to-deliver-app_summary.md' },
    ],
  },
  connect: {
    phase: 'connect',
    decisionPhaseTag: '4-connect',
    sources: [{ producer: 'connect-opp-setup', path: '4-connect/connect-opp-setup.md' }],
  },
};

// ── Memo parsing ────────────────────────────────────────────────────────────

const SECTION_TITLES: ReadonlyArray<{ kind: BuildMemoKind; re: RegExp }> = [
  { kind: 'latitude', re: /^\[ACE\]\s+latitudes?\s+taken\b/i },
  { kind: 'ambiguity', re: /^\[FIXED\]\s+ambiguit(?:y|ies)\s+hit\b/i },
  { kind: 'verification-rule', re: /^Verification rules\b.*\bwhere each is applied\b/i },
];

/**
 * Text a producer writes when a section has nothing in it. The skills say
 * `None.`; the rest are the spellings a model reaches for instead.
 */
const NONE_LIKE =
  /^(?:none\b|n\/a\b|nil\b|not applicable\b|nothing\b|no\s+(?:\[?(?:ace|fixed)\]?\s+)?(?:latitudes?|ambiguit(?:y|ies)|verification rules?|rules?)\b|[—–-]+$)/i;

function isNoneLike(text: string): boolean {
  const t = text.replace(/^[*_`\s]+|[*_`\s]+$/g, '').trim();
  return t === '' || NONE_LIKE.test(t);
}

interface SectionStart {
  kind: BuildMemoKind;
  /** Markdown heading level; `Infinity` for a bare title line (see below). */
  level: number;
  line: number;
}

function matchTitle(text: string): BuildMemoKind | null {
  const t = text.replace(/[:\s]+$/, '').trim();
  for (const { kind, re } of SECTION_TITLES) if (re.test(t)) return kind;
  return null;
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * A section starts at a markdown heading whose text is a known title, OR at a
 * line that is nothing BUT a known title. The second form is for a memo file
 * written through the Docs markdown importer and read back as `text/plain`:
 * the `#` markers are gone, and a parser that required them would find no
 * section and pass the phase — the silent pass this module exists to end.
 */
function findSections(lines: string[]): SectionStart[] {
  const out: SectionStart[] = [];
  lines.forEach((raw, i) => {
    const h = HEADING_RE.exec(raw);
    if (h) {
      const kind = matchTitle(h[2]);
      if (kind) out.push({ kind, level: h[1].length, line: i });
      return;
    }
    const kind = matchTitle(raw);
    if (kind && raw.trim().length < 80) out.push({ kind, level: Infinity, line: i });
  });
  return out;
}

/** A line that belongs to a list or a table (including a Docs-exported table cell). */
function isStructuredLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('|') || line.startsWith('\t') || LIST_ITEM.test(t);
}

function sectionBody(lines: string[], start: SectionStart): string[] {
  const bare = start.level === Infinity;
  const body: string[] = [];
  let seenStructured = false;
  for (let i = start.line + 1; i < lines.length; i++) {
    const line = lines[i];
    const h = HEADING_RE.exec(line);
    if (h && h[1].length <= start.level) break;
    // A bare-title section (no heading level) ends at any heading at all.
    if (h && bare) break;
    if (!h && matchTitle(line) && line.trim().length < 80) break;
    if (bare && line.trim() !== '') {
      // A Docs-imported memo has no heading markers, so its sections cannot
      // end at the next heading. Measured on poverty-graduation/20260908-0510:
      // `[ACE] latitudes taken` is a bare line followed by four `* ` bullets,
      // then `Open, and not resolved here` — a sibling section with its own
      // numbered list. A bare section is therefore its title plus the one
      // block under it: a single `None.`-style line, or the list/table that
      // follows, ending at the first prose line after it.
      const structured = isStructuredLine(line);
      if (!structured && seenStructured) break;
      if (!structured && body.every((l) => l.trim() === '')) {
        body.push(line);
        if (isNoneLike(line)) break;
        continue;
      }
      if (structured) seenStructured = true;
    }
    body.push(line);
  }
  return body;
}

const TABLE_SEPARATOR = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+(.*)$/;

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** Items recorded in one section body. `None.` in any of its spellings is 0. */
export function countSectionItems(body: readonly string[]): number {
  const lines = body.map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
  if (lines.length === 0) return 0;

  let items = 0;
  let structured = false;

  // Tables: each run of contiguous `|` lines is one table. Its first line is
  // the header whether or not a separator follows it (a separator-less table
  // must not count its header as an item). A data row whose every cell is
  // blank or none-like is the "None." placeholder row, not an item.
  let block: string[] = [];
  const flush = () => {
    if (block.length === 0) return;
    structured = true;
    const data = block.slice(1).filter((l) => !TABLE_SEPARATOR.test(l));
    for (const row of data) if (!tableCells(row).every(isNoneLike)) items++;
    block = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('|')) block.push(line);
    else flush();
  }
  flush();

  // Top-level list items (indent < 2 spaces), outside tables.
  for (const line of lines) {
    if (/^\s{2,}/.test(line)) continue;
    const m = LIST_ITEM.exec(line.trim());
    if (!m || line.trim().startsWith('|')) continue;
    structured = true;
    if (!isNoneLike(m[1])) items++;
  }

  if (structured) return items;
  // Prose only. "None." (or a spelling of it) is nothing; anything else is at
  // least one recorded item — undercounting prose to 1 is safe for a gate
  // that only asks whether a producer owes ANY row, and the alternative
  // (counting 0) would let an unstructured memo pass a silent build.
  return isNoneLike(lines.join(' ')) ? 0 : 1;
}

export interface MemoItemCounts {
  latitude: number;
  ambiguity: number;
  'verification-rule': number;
  total: number;
  /** Section kinds actually found in the file, in document order, deduped. */
  sections: BuildMemoKind[];
}

/**
 * Count the latitudes, ambiguities and verification rules a producer's memo
 * sections record. Every other part of the file is ignored.
 */
export function countBuildMemoItems(markdown: string): MemoItemCounts {
  const lines = markdown.replace(/^﻿/, '').split('\n').map((l) => l.replace(/\r$/, ''));
  const counts: MemoItemCounts = {
    latitude: 0,
    ambiguity: 0,
    'verification-rule': 0,
    total: 0,
    sections: [],
  };
  for (const start of findSections(lines)) {
    const n = countSectionItems(sectionBody(lines, start));
    counts[start.kind] += n;
    counts.total += n;
    if (!counts.sections.includes(start.kind)) counts.sections.push(start.kind);
  }
  return counts;
}

// ── Decision rows ───────────────────────────────────────────────────────────

export interface DecisionRowRef {
  id?: unknown;
  phase?: unknown;
  skill?: unknown;
}

/**
 * Read the rows out of a decisions.yaml body, leniently. Schema validity is
 * `decisions-render`'s gate, not this one; this only needs `phase` + `skill`.
 * An unparseable log yields no rows and a note, so a silent producer still
 * fails — with the parse error in the message instead of a misleading zero.
 */
export function decisionRowsFromYaml(text: string | null): {
  rows: DecisionRowRef[];
  note?: string;
} {
  if (text === null) return { rows: [], note: 'decisions.yaml is not in the run folder' };
  let parsed: unknown;
  try {
    parsed = yaml.parse(text.replace(/^﻿/, ''));
  } catch (e: any) {
    return { rows: [], note: `decisions.yaml did not parse: ${e?.message ?? e}` };
  }
  const decisions = (parsed as { decisions?: unknown } | null)?.decisions;
  if (!Array.isArray(decisions)) {
    return { rows: [], note: 'decisions.yaml has no top-level `decisions:` list' };
  }
  return {
    rows: decisions.filter((r): r is DecisionRowRef => typeof r === 'object' && r !== null),
  };
}

// ── The check ───────────────────────────────────────────────────────────────

export type ProducerVerdict =
  /** memo lists items; this producer wrote at least as many rows */
  | 'ok'
  /** memo lists items; this producer wrote SOME rows but fewer — warning */
  | 'short'
  /** memo lists items; this producer wrote ZERO rows — fails the boundary */
  | 'silent'
  /** memo records no latitude, ambiguity or rule — owes no rows */
  | 'no-items'
  /** the memo file is not in Drive — `verify_phase_artifacts.missing` owns that */
  | 'memo-absent';

export interface ProducerDecisionFinding {
  producer: string;
  path: string;
  verdict: ProducerVerdict;
  items: MemoItemCounts;
  /** Rows in decisions.yaml with this phase's tag and `skill: <producer>`. */
  decision_rows: number;
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

function describeItems(c: MemoItemCounts): string {
  const parts: string[] = [];
  if (c.latitude) parts.push(`${c.latitude} [ACE] latitude${c.latitude === 1 ? '' : 's'}`);
  if (c.ambiguity) parts.push(`${c.ambiguity} [FIXED] ambiguit${c.ambiguity === 1 ? 'y' : 'ies'}`);
  if (c['verification-rule']) {
    const n = c['verification-rule'];
    parts.push(`${n} verification rule${n === 1 ? '' : 's'}`);
  }
  return parts.join(', ');
}

export interface CheckBuildPhaseDecisionsInput {
  phase: Phase;
  /** Memo file text keyed by the source's `path`; `null` = not in Drive. */
  memos: Readonly<Record<string, string | null>>;
  /** decisions.yaml text; `null` = not in the run folder. */
  decisionsYaml: string | null;
}

/**
 * Pure. Throws for a phase with no build-memo contract — callers gate on
 * {@link BUILD_PHASE_DECISION_CONTRACTS} (as {@link verifyBuildPhaseDecisions}
 * does) so the report is attached only where it applies.
 */
export function checkBuildPhaseDecisions(
  input: CheckBuildPhaseDecisionsInput,
): BuildPhaseDecisionsReport {
  const contract = BUILD_PHASE_DECISION_CONTRACTS[input.phase];
  if (!contract) {
    throw new Error(
      `checkBuildPhaseDecisions: phase ${JSON.stringify(input.phase)} has no build-memo contract ` +
        `(contracted: ${Object.keys(BUILD_PHASE_DECISION_CONTRACTS).join(', ')})`,
    );
  }

  const { rows, note } = decisionRowsFromYaml(input.decisionsYaml);
  const warnings: string[] = [];

  const producers: ProducerDecisionFinding[] = contract.sources.map(({ producer, path }) => {
    const text = input.memos[path] ?? null;
    const decision_rows = rows.filter(
      (r) => r.phase === contract.decisionPhaseTag && r.skill === producer,
    ).length;
    if (text === null) {
      return {
        producer,
        path,
        verdict: 'memo-absent',
        items: countBuildMemoItems(''),
        decision_rows,
      };
    }
    const items = countBuildMemoItems(text);
    let verdict: ProducerVerdict;
    if (items.total === 0) verdict = 'no-items';
    else if (decision_rows === 0) verdict = 'silent';
    else if (decision_rows < items.total) verdict = 'short';
    else verdict = 'ok';
    if (verdict === 'short') {
      warnings.push(
        `${producer}: its build memo lists ${describeItems(items)} but only ${decision_rows} ` +
          `decision row(s) carry skill: ${producer} in ${contract.decisionPhaseTag} — every memo entry ` +
          `is meant to be a row too.`,
      );
    }
    return { producer, path, verdict, items, decision_rows };
  });

  const failures = producers.filter((p) => p.verdict === 'silent');
  if (note && failures.length > 0) warnings.push(note);

  const summary =
    failures.length > 0
      ? `FAIL — ${failures
          .map(
            (f) =>
              `${f.producer}'s build memo lists ${describeItems(f.items)} and it wrote 0 decision ` +
              `rows (phase ${contract.decisionPhaseTag}, skill ${f.producer})`,
          )
          .join('; ')}. The reviewer's register on the run page shows none of these calls.`
      : `decision rows present for every build-memo producer with items — ${producers
          .map((p) =>
            p.verdict === 'no-items'
              ? `${p.producer}: memo records none`
              : p.verdict === 'memo-absent'
                ? `${p.producer}: memo not in Drive`
                : `${p.producer}: ${p.decision_rows} row(s) / ${p.items.total} memo item(s)`,
          )
          .join('; ')}`;

  return {
    phase: input.phase,
    decision_phase: contract.decisionPhaseTag,
    ok: failures.length === 0,
    producers,
    failures,
    warnings,
    summary,
  };
}

/**
 * The report for a check that could not run because a Drive read threw. It
 * fails, because a gate that cannot read its inputs has not passed anything.
 */
export function unreadableBuildPhaseDecisions(
  phase: Phase,
  message: string,
): BuildPhaseDecisionsReport | null {
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
 * Find each memo source and decisions.yaml in Drive, read them, and run
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
  const decisionsFile = runChildren.find(
    (c) => DECISIONS_NAMES.has(c.name) && c.mimeType !== FOLDER_MIMETYPE,
  );

  const memos: Record<string, string | null> = {};
  const folderName = contract.sources[0].path.split('/')[0];
  const phaseFolder = runChildren.find(
    (c) => c.name === folderName && c.mimeType === FOLDER_MIMETYPE,
  );
  const phaseChildren = phaseFolder ? await drive.listFolder(phaseFolder.id) : [];
  for (const { path } of contract.sources) {
    const base = path.split('/').slice(1).join('/');
    const file = phaseChildren.find(
      (c) =>
        c.mimeType !== FOLDER_MIMETYPE &&
        (c.name === base || c.name === stripDocExtension(base)),
    );
    memos[path] = file ? await drive.readText(file.id) : null;
  }

  const decisionsYaml = decisionsFile ? await drive.readText(decisionsFile.id) : null;
  return checkBuildPhaseDecisions({ phase, memos, decisionsYaml });
}
