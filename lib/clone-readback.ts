/**
 * lib/clone-readback.ts
 *
 * The Drive-link read-back of `skills/clone-to-new-workspace` § Step 2: after
 * ace-web copies a run into another workspace, does any copied file still name
 * a SOURCE run file by id?
 *
 * History of the scope, because each widening was a real escape:
 *   - run_state.yaml only → a clone whose `previews/<output>/_previews.yaml`
 *     indexes all still named the source's frames passed it, and ace-web
 *     showed no screenshots for twelve outputs (dimagi-internal/ace#2603).
 *   - every YAML file → the partner-facing onboarding email, the FLW guide's
 *     23 screenshot links, the build memo and the Phase 8 summary all still
 *     linked the SOURCE run's Docs and frames, and the read-back exited 0
 *     because none of them is YAML (dimagi-internal/ace#2607).
 * So the read-back now checks every TEXT copy — YAML, markdown, plain text,
 * JSON, and Google Docs — and for a Doc it checks the hyperlink TARGETS as
 * well as the visible text: a rendered guide shows "Learn app — step 3" and
 * hides the Drive id in the link.
 *
 * Three copies hold source ids on purpose and are reported apart from `hits`:
 *   - left behind: ids of comms-logs, which the clone does not copy;
 *   - provenance: the decisions log and eval/QA records — history of what was
 *     decided and judged on the SOURCE run, which a clone does not rewrite.
 *
 * Also the pure half of the REPAIR (`scripts/clone-drive-readback.ts --plan`):
 * `buildCopyIdMap` pairs each source file/folder with its copy by relative
 * path, `rewriteDriveIds` fixes a plain-text copy, and `docIdRewriteRequests`
 * turns a Google Doc's JSON into Docs API requests that fix its link targets
 * and visible ids IN PLACE — a formatted Doc is never written back as text.
 *
 * Pure: the caller walks Drive.
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
  /** Hyperlink targets in the copy (a Google Doc's links); scanned like text. */
  links?: string[];
  /** Drive mime type, when known. */
  mimeType?: string;
}

export interface LeftoverHit {
  copyPath: string;
  sourceId: string;
  sourcePath: string;
  occurrences: number;
}

export interface ReadbackResult {
  /** Copies checked (every text copy in the target run). */
  checked: string[];
  /** Source ids still present that the clone should have rewritten. */
  hits: LeftoverHit[];
  /** Source ids present that point at a file the clone does not copy (comms-logs). */
  leftBehind: LeftoverHit[];
  /** Source ids in the decisions log / eval + QA records: history, left on purpose. */
  provenance: LeftoverHit[];
}

const GOOGLE_DOC = 'application/vnd.google-apps.document';
const TEXT_SUFFIX = /\.(ya?ml|md|markdown|txt|json|csv|html?|xml)$/i;
const TEXT_MIME = /^text\/|json|yaml|xml/;

/**
 * A copy whose content can name another file by id: every text file and every
 * Google Doc. Binary copies (png, mp4, pdf) cannot.
 */
export function isIdBearingCopy(path: string, mimeType?: string): boolean {
  if (mimeType === GOOGLE_DOC) return true;
  if (mimeType && TEXT_MIME.test(mimeType)) return true;
  return TEXT_SUFFIX.test(path);
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

const VERDICT_FILE = /(_verdict[^/]*|-qa_result[^/]*|_result)(\.ya?ml)?$/i;

/**
 * A copy that records history: the decisions log (`decisions.yaml`,
 * `decisions.gdoc`) and eval/QA records (`*_verdict*`, `*-qa_result*`). What
 * they say about the SOURCE run's files is what was decided and judged, so a
 * clone leaves them as they are; the read-back lists them, never fails on them.
 */
export function isProvenanceCopy(copyPath: string): boolean {
  const base = copyPath.split('/').pop() ?? '';
  return /^decisions\b/.test(base) || VERDICT_FILE.test(base);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One alternation over ids, longest first, whole-id only (Drive ids are `[\w-]`). */
function idPattern(ids: Iterable<string>): RegExp | null {
  const list = [...ids].filter(Boolean).sort((a, b) => b.length - a.length).map(escapeRe);
  if (!list.length) return null;
  return new RegExp(`(?<![\\w-])(${list.join('|')})(?![\\w-])`, 'g');
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
  const checked = copies.filter((c) => isIdBearingCopy(c.path, c.mimeType));
  const result: ReadbackResult = {
    checked: checked.map((c) => c.path),
    hits: [],
    leftBehind: [],
    provenance: [],
  };
  const byId = new Map(sourceFiles.map((f) => [f.id, f.path]));
  const pattern = idPattern(byId.keys());
  if (!pattern || checked.length === 0) return result;
  for (const copy of checked) {
    const counts = new Map<string, number>();
    for (const chunk of [copy.text, ...(copy.links ?? [])]) {
      for (const m of chunk.matchAll(pattern)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    for (const [sourceId, occurrences] of counts) {
      const sourcePath = byId.get(sourceId) ?? '';
      const hit = { copyPath: copy.path, sourceId, sourcePath, occurrences };
      if (isLeftBehind(sourcePath)) result.leftBehind.push(hit);
      else if (isProvenanceCopy(copy.path)) result.provenance.push(hit);
      else result.hits.push(hit);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Repair: source id -> copy id, and the rewrite of one copy.
// ---------------------------------------------------------------------------

export interface TreeEntry {
  id: string;
  /** Slash-separated path from the run folder; folders included. */
  path: string;
}

export interface CopyIdMap {
  /** source id -> copy id */
  ids: Record<string, string>;
  /** Source paths that exist more than once on either side: not paired. */
  ambiguous: string[];
  /** Source paths with no copy at that path (comms-logs, or a missed copy). */
  unmatched: string[];
}

/**
 * Pair each source file/folder with the target entry at the same relative
 * path (ace-web copies the tree verbatim, names included), plus the two run
 * folders themselves. A path present twice on either side is ambiguous and
 * left unpaired rather than guessed.
 */
export function buildCopyIdMap(
  source: TreeEntry[],
  target: TreeEntry[],
  roots?: { source: string; target: string },
): CopyIdMap {
  const group = (es: TreeEntry[]) => {
    const m = new Map<string, string[]>();
    for (const e of es) m.set(e.path, [...(m.get(e.path) ?? []), e.id]);
    return m;
  };
  const src = group(source);
  const dst = group(target);
  const out: CopyIdMap = { ids: {}, ambiguous: [], unmatched: [] };
  if (roots) out.ids[roots.source] = roots.target;
  for (const [p, sids] of src) {
    const tids = dst.get(p);
    if (!tids) {
      out.unmatched.push(p);
      continue;
    }
    if (sids.length > 1 || tids.length > 1) {
      out.ambiguous.push(p);
      continue;
    }
    if (sids[0] !== tids[0]) out.ids[sids[0]] = tids[0];
  }
  return out;
}

/** Replace every whole source id in `text` with its copy, in one pass. */
export function rewriteDriveIds(text: string, ids: Record<string, string>): { text: string; replacements: number } {
  const pattern = idPattern(Object.keys(ids));
  if (!pattern) return { text, replacements: 0 };
  let n = 0;
  const out = text.replace(pattern, (m) => {
    n++;
    return ids[m];
  });
  return { text: out, replacements: n };
}

/** A hyperlink in a Google Doc: its target and where it sits. */
export interface DocLink {
  url: string;
  startIndex: number;
  endIndex: number;
  segmentId?: string;
}

/**
 * Visible text and hyperlinks of a Google Doc (`documents.get` JSON), across
 * the body, headers, footers and footnotes, tables included.
 */
export function docTextAndLinks(doc: any): { text: string; links: DocLink[] } {
  const parts: string[] = [];
  const links: DocLink[] = [];
  const walk = (content: any[] | undefined, segmentId?: string) => {
    for (const el of content ?? []) {
      for (const pe of el.paragraph?.elements ?? []) {
        const tr = pe.textRun;
        if (tr?.content) parts.push(tr.content);
        const url = tr?.textStyle?.link?.url;
        if (url) {
          links.push({ url, startIndex: pe.startIndex ?? 0, endIndex: pe.endIndex ?? 0, segmentId });
        }
      }
      for (const row of el.table?.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) walk(cell.content, segmentId);
      }
      if (el.tableOfContents) walk(el.tableOfContents.content, segmentId);
    }
  };
  walk(doc?.body?.content);
  for (const [id, h] of Object.entries<any>(doc?.headers ?? {})) walk(h.content, id);
  for (const [id, f] of Object.entries<any>(doc?.footers ?? {})) walk(f.content, id);
  for (const [id, fn] of Object.entries<any>(doc?.footnotes ?? {})) walk(fn.content, id);
  return { text: parts.join(''), links };
}

export interface DocRewrite {
  requests: any[];
  /** Links retargeted. */
  links: number;
  /** Visible id occurrences replaced. */
  textIds: number;
  /** Source ids in visible text that replaceAllText cannot rewrite safely (a longer token contains them). */
  unsafe: string[];
}

/**
 * Docs API requests that point a Google Doc at the clone's copies without
 * touching its formatting: `updateTextStyle` on each link whose target names a
 * source id (only the `link` field — bold, headings, tables untouched), then
 * `replaceAllText` for each source id in the visible text. Link updates come
 * first so their ranges are the document's current indices.
 *
 * `replaceAllText` is a substring replace, so it is used only for an id whose
 * every occurrence is a whole id; one that also occurs inside a longer token
 * is reported in `unsafe` and left alone.
 */
export function docIdRewriteRequests(doc: any, ids: Record<string, string>): DocRewrite {
  const out: DocRewrite = { requests: [], links: 0, textIds: 0, unsafe: [] };
  const pattern = idPattern(Object.keys(ids));
  if (!pattern) return out;
  const { text, links } = docTextAndLinks(doc);
  for (const l of links) {
    const r = rewriteDriveIds(l.url, ids);
    if (!r.replacements) continue;
    const range: any = { startIndex: l.startIndex, endIndex: l.endIndex };
    if (l.segmentId) range.segmentId = l.segmentId;
    out.requests.push({
      updateTextStyle: { range, textStyle: { link: { url: r.text } }, fields: 'link' },
    });
    out.links++;
  }
  const whole = new Map<string, number>();
  for (const m of text.matchAll(pattern)) whole.set(m[1], (whole.get(m[1]) ?? 0) + 1);
  for (const [id, n] of whole) {
    const anywhere = text.split(id).length - 1;
    if (anywhere !== n) {
      out.unsafe.push(id);
      continue;
    }
    out.requests.push({
      replaceAllText: { containsText: { text: id, matchCase: true }, replaceText: ids[id] },
    });
    out.textIds += n;
  }
  return out;
}
