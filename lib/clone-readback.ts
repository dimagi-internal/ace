/**
 * lib/clone-readback.ts
 *
 * The Drive-link read-back of `skills/clone-to-new-workspace` § Step 2: after
 * ace-web copies a run into another workspace, does any copied file still name
 * a SOURCE run file by id?
 *
 * ace-web rewrites source→copy ids in every YAML file it copies under the run
 * (ace-web#829 for run_state / decisions, ace-web#851 for everything else). The
 * read-back used to grep only the target `run_state.yaml`, so a clone whose
 * `previews/<output>/_previews.yaml` indexes all still named the source's
 * frames passed it, and ace-web showed no screenshots for any of the run's
 * twelve live-system outputs (dimagi-internal/ace#2603). So the read-back now
 * covers the same set the rewrite does: every YAML file in the target run.
 *
 * Pure: the caller walks Drive (`scripts/clone-drive-readback.ts`).
 */

export interface SourceFile {
  id: string;
  /** Slash-separated path from the SOURCE run folder. */
  path: string;
}

export interface CopiedText {
  /** Slash-separated path from the TARGET run folder. */
  path: string;
  text: string;
}

export interface LeftoverHit {
  copyPath: string;
  sourceId: string;
  sourcePath: string;
  occurrences: number;
}

export interface ReadbackResult {
  /** Copies checked (every YAML file in the target run). */
  checked: string[];
  /** Source ids still present, minus those the clone deliberately leaves behind. */
  hits: LeftoverHit[];
  /** Source ids present that point at a file the clone does not copy (comms-logs). */
  leftBehind: LeftoverHit[];
}

const YAML_SUFFIX = /\.ya?ml$/i;

/** Every YAML file in the run may list files by id; those are what ace-web rewrites. */
export function isIdBearingCopy(path: string): boolean {
  return YAML_SUFFIX.test(path);
}

/**
 * A source path the clone deliberately does not copy: ACE's email records
 * (ace-web `run_cloner._skip_run_child` — a segment named `comms-log`, or
 * ending `_comms-log`). An id of one of those has no copy to point at.
 */
export function isLeftBehind(sourcePath: string): boolean {
  return sourcePath
    .split('/')
    .some((seg) => seg === 'comms-log' || seg.endsWith('_comms-log'));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-id matches only: Drive ids are `[A-Za-z0-9_-]`, so one id can be a
 * prefix of another and a plain substring test would report a copy's id that
 * merely starts with a source id.
 */
export function findLeftoverSourceIds(
  sourceFiles: SourceFile[],
  copies: CopiedText[],
): ReadbackResult {
  const checked = copies.filter((c) => isIdBearingCopy(c.path));
  const result: ReadbackResult = { checked: checked.map((c) => c.path), hits: [], leftBehind: [] };
  const byId = new Map(sourceFiles.map((f) => [f.id, f.path]));
  if (byId.size === 0 || checked.length === 0) return result;
  const ids = [...byId.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
  for (const copy of checked) {
    const pattern = new RegExp(`(?<![\\w-])(${ids.join('|')})(?![\\w-])`, 'g');
    const counts = new Map<string, number>();
    for (const m of copy.text.matchAll(pattern)) {
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    for (const [sourceId, occurrences] of counts) {
      const sourcePath = byId.get(sourceId) ?? '';
      const hit = { copyPath: copy.path, sourceId, sourcePath, occurrences };
      (isLeftBehind(sourcePath) ? result.leftBehind : result.hits).push(hit);
    }
  }
  return result;
}
