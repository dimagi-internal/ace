/**
 * Phase 1 fence: every platform-behaviour question is answered from evidence
 * before Phase 3 builds on it.
 *
 * ## The defect this guards
 *
 * kaduna-graduation/20261015-1411's PDD asked "does Connect require every Learn
 * module to be completed?" (Flag F3) and answered it with "the first device
 * walk". Nothing then stopped Phase 3 from building the role-gated Learn app
 * that question was about; the walk ran in Phase 6, Connect read 9/14 = 64.3%,
 * and Deliver never unlocked (ace#3036). The answer was eight lines of Connect
 * source (`OpportunityAccess.learn_progress`).
 *
 * ## What this checks
 *
 * Every LIVE `decisions.yaml` row tagged `kind: platform-behaviour` must carry
 * `resolved_by: source | api` with a `resolution_citation` (a pinned
 * `<owner>/<repo>@<sha>:<path>:<line>` for `source`) before the design phase
 * closes. `resolved_by: device` is accepted only when the row ALSO carries a
 * `review_ask` — the honest shape for the rare question that genuinely needs a
 * device: it is an open ask a reviewer sees, never a silent assumption the build
 * runs on — and is reported as a warning. Anything else fails the boundary.
 *
 * Wired into `verify_phase_artifacts(phase='design')` as its `platform_behaviour`
 * block. Like the build phases' `decisions` block it is NOT folded into
 * `missing[]`: heal by answering the question from source / an API probe and
 * appending a superseding row, never by re-running `idea-to-pdd`.
 */

import { decisionRowsFromYaml } from './build-phase-decisions.js';
import { SOURCE_CITATION_RE } from './decisions-schema.js';
import type { DriveReadAdapter } from './build-phase-decisions.js';

export interface PlatformBehaviourRowFinding {
  id: string;
  resolved_by?: string;
  problem: string;
}

export interface PlatformBehaviourReport {
  ok: boolean;
  unreadable?: boolean;
  /** Live platform-behaviour rows seen. */
  rows: number;
  failures: PlatformBehaviourRowFinding[];
  warnings: string[];
  summary: string;
}

interface Row {
  id?: unknown;
  kind?: unknown;
  resolved_by?: unknown;
  resolution_citation?: unknown;
  review_ask?: unknown;
  superseded_by?: unknown;
}

/** Pure. `decisionsYaml` null = no decisions.yaml in the run folder. */
export function checkPlatformBehaviourDecisions(decisionsYaml: string | null): PlatformBehaviourReport {
  if (decisionsYaml === null) {
    return { ok: true, rows: 0, failures: [], warnings: [], summary: 'no decisions.yaml yet — no platform-behaviour rows to check' };
  }
  const { rows, note } = decisionRowsFromYaml(decisionsYaml);
  if (note && rows.length === 0 && !/not in the run folder/.test(note)) {
    return { ok: false, unreadable: true, rows: 0, failures: [], warnings: [], summary: `could not read decisions.yaml — ${note}` };
  }
  const live = (rows as Row[]).filter((r) => r.kind === 'platform-behaviour' && r.superseded_by === undefined);
  const failures: PlatformBehaviourRowFinding[] = [];
  const warnings: string[] = [];
  for (const r of live) {
    const id = String(r.id);
    const by = typeof r.resolved_by === 'string' ? r.resolved_by : undefined;
    const cite = typeof r.resolution_citation === 'string' ? r.resolution_citation.trim() : '';
    if (!by) {
      failures.push({ id, problem: 'unresolved — no `resolved_by`. Answer it from Connect/HQ source or a read-only API probe.' });
    } else if (!cite) {
      failures.push({ id, resolved_by: by, problem: '`resolved_by` without a `resolution_citation`' });
    } else if (by === 'source' && !SOURCE_CITATION_RE.test(cite)) {
      failures.push({ id, resolved_by: by, problem: 'source citation is not pinned as <owner>/<repo>@<sha>:<path>:<line>' });
    } else if (by === 'device') {
      if (r.review_ask === undefined) {
        failures.push({
          id,
          resolved_by: by,
          problem:
            '`resolved_by: device` cannot settle a question before Phase 3 builds the apps a device would test. ' +
            'Answer it from source or an API probe; if it genuinely needs a device, keep it an open ask (`review_ask`).',
        });
      } else {
        warnings.push(`${id}: left to a device (${cite}) as an open ask — confirm no source or API probe answers it`);
      }
    } else if (by !== 'source' && by !== 'api') {
      failures.push({ id, resolved_by: by, problem: `unknown resolved_by "${by}" (source | api | device)` });
    }
  }
  const ok = failures.length === 0;
  const summary = ok
    ? `${live.length} platform-behaviour row(s), all answered from source/API` + (warnings.length ? ` (${warnings.length} left to a device as an open ask)` : '')
    : `FAIL — ${failures.length} platform-behaviour row(s) not answered from evidence: ` +
      failures.map((f) => `${f.id} (${f.problem})`).join('; ') +
      '. Read the answer in Connect/HQ source (or one read-only API call) and append a superseding row with ' +
      '`resolved_by` + `resolution_citation` before Phase 3.';
  return { ok, rows: live.length, failures, warnings, summary };
}

export function unreadablePlatformBehaviour(message: string): PlatformBehaviourReport {
  return {
    ok: false,
    unreadable: true,
    rows: 0,
    failures: [],
    warnings: [],
    summary: `could not check platform-behaviour rows — a Drive read failed: ${message}`,
  };
}

const FOLDER_MIMETYPE = 'application/vnd.google-apps.folder';
const DECISIONS_NAMES = new Set(['decisions.yaml', 'decisions']);

/** IO wrapper: find the run-root decisions.yaml and check it. Throws on a failed read. */
export async function verifyPlatformBehaviourDecisions(
  drive: DriveReadAdapter,
  runFolderId: string,
): Promise<PlatformBehaviourReport> {
  const children = await drive.listFolder(runFolderId);
  const file = children.find((c) => DECISIONS_NAMES.has(c.name) && c.mimeType !== FOLDER_MIMETYPE);
  return checkPlatformBehaviourDecisions(file ? await drive.readText(file.id) : null);
}
