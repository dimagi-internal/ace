/**
 * lib/clone-asset-refs.ts
 *
 * The asset-reference rewrite of `skills/clone-to-new-workspace` § Step 4e:
 * after 4a copies the HQ apps and 4b rebuilds Connect in the target
 * workspace, rewrite every copied document that still NAMES the source's
 * assets — HQ project space, app ids, released build ids and versions, Connect
 * program/opportunity ids, org slugs — to the target's copies.
 *
 * Why: 4a/4b rewrite `products.*` in run_state, and ace-web rewrites Drive file
 * ids (ace-web#829/#851), but nothing touched prose. The first Spark clone
 * (spark/spark-facilitator/20261001-2208) kept ~140 source mentions across 37
 * files, including the partner-facing LLO guide pointing at
 * `connect-ace-prod` and an `ace-nm-org` opportunity URL the partner cannot
 * open (dimagi-internal/ace#2606).
 *
 * Three kinds of file, decided by `classifyClonePath`:
 *   - rewrite: replace the source refs, and put one provenance note at the top
 *     so a reviewer knows these are copies of what was reviewed;
 *   - note:    an eval/QA record — it describes what a judge saw on the SOURCE
 *     assets, so rewriting it would falsify it. Prepend the note only;
 *   - skip:    an audit trail (decisions log — its source rows are superseded
 *     by the rebuild's own rows), a phase the operator has kept on the source
 *     (Phase 8 solicitation by default), files a rebuild re-authored itself
 *     (4-connect after 4b), or a file regenerated later (validate-release-readiness, README).
 *
 * Pure: the caller walks Drive (`scripts/clone-asset-rewrite.ts`).
 */

export interface AppAssets {
  hq_app_id?: string;
  released_build_id?: string;
  released_version?: number | string;
}

export interface ConnectAssets {
  program_id?: string;
  opportunity_id?: string;
  opportunity_int_id?: number | string;
  pm_org?: string;
  holding_org?: string;
}

export interface RunAssets {
  hq_domain?: string;
  apps: Record<string, AppAssets>; // keyed learn / deliver
  connect?: ConnectAssets;
}

export interface CloneLabel {
  from: string; // e.g. dimagi-team/spark-facilitator/20261001-2208
  to: string; // target workspace slug, e.g. spark
}

export interface AssetPair {
  kind: 'hq_domain' | 'app' | 'build' | 'program' | 'opportunity' | 'opportunity_int' | 'org';
  from: string;
  to: string;
  /** For app/build: learn | deliver. */
  app?: string;
}

export interface AssetMap {
  pairs: AssetPair[];
  versions: Record<string, { from: string; to: string }>;
  source: RunAssets;
  target: RunAssets;
  connectRebuilt: boolean;
}

const APP_LABEL: Record<string, string> = { learn: 'Learn', deliver: 'Deliver' };

function s(v: unknown): string | undefined {
  return v === undefined || v === null || v === '' ? undefined : String(v);
}

/** Read the asset facts a run_state records (Phase 3 + Phase 4 products). */
export function runAssetsFromRunState(rs: any): RunAssets {
  const apps = rs?.phases?.['commcare-setup']?.products?.apps ?? {};
  const out: RunAssets = { hq_domain: s(apps.domain), apps: {} };
  for (const k of ['learn', 'deliver']) {
    const a = apps[k];
    if (!a) continue;
    // Older runs record the space only in hq_url (`/a/<domain>/apps/…`).
    out.hq_domain = out.hq_domain ?? s(a.domain) ?? /\/a\/([^/]+)\/apps\//.exec(String(a.hq_url ?? ''))?.[1];
    out.apps[k] = {
      hq_app_id: s(a.hq_app_id),
      released_build_id: s(a.released_build_id),
      released_version: s(a.released_version),
    };
  }
  const c = rs?.phases?.['connect-setup']?.products?.connect;
  out.hq_domain = out.hq_domain ?? s(c?.learn_app?.cc_domain) ?? s(c?.domain);
  if (c) {
    out.connect = {
      program_id: s(c.program?.id),
      opportunity_id: s(c.opportunity?.id),
      opportunity_int_id: s(c.opportunity?.connect_int_id),
      pm_org: s(c.pm_org_slug ?? c.organization_slug),
      holding_org: s(c.holding_org_slug ?? c.organization_slug),
    };
  }
  return out;
}

/**
 * Source→target pairs for every asset that actually moved. An asset absent on
 * either side, or unchanged (e.g. `--keep-shared connect`), yields no pair —
 * so the rewrite is safe to run after 4a alone and again after 4b.
 */
export function buildAssetMap(source: RunAssets, target: RunAssets): AssetMap {
  const pairs: AssetPair[] = [];
  const versions: AssetMap['versions'] = {};
  const add = (kind: AssetPair['kind'], from?: string, to?: string, app?: string) => {
    if (from && to && from !== to && !pairs.some((p) => p.kind === kind && p.from === from)) {
      pairs.push({ kind, from, to, app });
    }
  };
  add('hq_domain', source.hq_domain, target.hq_domain);
  for (const k of Object.keys(source.apps)) {
    const a = source.apps[k];
    const b = target.apps[k];
    if (!b) continue;
    add('app', a.hq_app_id, b.hq_app_id, k);
    add('build', a.released_build_id, b.released_build_id, k);
    const fv = s(a.released_version);
    const tv = s(b.released_version);
    if (fv && tv && fv !== tv && a.released_build_id !== b.released_build_id) versions[k] = { from: fv, to: tv };
  }
  const sc = source.connect;
  const tc = target.connect;
  let connectRebuilt = false;
  if (sc && tc && sc.opportunity_id && tc.opportunity_id && sc.opportunity_id !== tc.opportunity_id) {
    connectRebuilt = true;
    add('program', sc.program_id, tc.program_id);
    add('opportunity', sc.opportunity_id, tc.opportunity_id);
    add('opportunity_int', s(sc.opportunity_int_id), s(tc.opportunity_int_id));
    add('org', sc.holding_org, tc.holding_org);
    add('org', sc.pm_org, tc.pm_org);
  }
  return { pairs, versions, source, target, connectRebuilt };
}

function escapeRe(x: string): string {
  return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const HEX_ID = /^[0-9a-f-]{16,}$/i;

/** A pattern per pair; ids also match by their 8-char prefix (how prose abbreviates them). */
function idPatterns(p: AssetPair): Array<{ re: RegExp; to: string }> {
  const out: Array<{ re: RegExp; to: string }> = [];
  if (p.kind === 'opportunity_int') {
    out.push({
      re: new RegExp(`\\b(opportunity|opp|int|connect_opportunity_id:)(\\s+)${escapeRe(p.from)}\\b`, 'gi'),
      to: `$1$2${p.to}`,
    });
    return out;
  }
  if (p.kind === 'org' || p.kind === 'hq_domain') {
    out.push({ re: new RegExp(`(?<![\\w-])${escapeRe(p.from)}(?![\\w-])`, 'g'), to: p.to });
    return out;
  }
  out.push({ re: new RegExp(`(?<![0-9a-f])${escapeRe(p.from)}(?![0-9a-f])`, 'gi'), to: p.to });
  if (HEX_ID.test(p.from) && p.from.length > 8) {
    out.push({
      re: new RegExp(`(?<![0-9a-f-])${escapeRe(p.from.slice(0, 8))}(?![0-9a-f])`, 'gi'),
      to: p.to.slice(0, 8),
    });
  }
  return out;
}

/** Connect URLs carry an org AND an id; rewrite them as a unit first. */
function urlPatterns(map: AssetMap): Array<{ re: RegExp; to: string }> {
  const sc = map.source.connect;
  const tc = map.target.connect;
  if (!map.connectRebuilt || !sc || !tc) return [];
  const out: Array<{ re: RegExp; to: string }> = [];
  if (sc.holding_org && sc.opportunity_id && tc.holding_org && tc.opportunity_id) {
    out.push({
      re: new RegExp(`/a/${escapeRe(sc.holding_org)}/opportunity/${escapeRe(sc.opportunity_id)}`, 'g'),
      to: `/a/${tc.holding_org}/opportunity/${tc.opportunity_id}`,
    });
  }
  if (sc.pm_org && sc.program_id && tc.pm_org && tc.program_id) {
    out.push({
      re: new RegExp(`/a/${escapeRe(sc.pm_org)}/program/${escapeRe(sc.program_id)}`, 'g'),
      to: `/a/${tc.pm_org}/program/${tc.program_id}`,
    });
  }
  return out;
}

/**
 * A build's version only means something next to that build, so versions are
 * rewritten (a) on a line naming the source build, or within the next 3 lines
 * for a `version:` / `released_version:` key, and (b) in "Learn v22" /
 * "Deliver app v9" shorthand anywhere.
 */
function rewriteVersions(lines: string[], map: AssetMap): number {
  let n = 0;
  // A version follows its build id, or its app id ("HQ 58ef8132 v9").
  const builds = map.pairs.filter((p) => (p.kind === 'build' || p.kind === 'app') && p.app && map.versions[p.app]);
  for (const k of Object.keys(map.versions)) {
    const { from, to } = map.versions[k];
    const label = APP_LABEL[k] ?? k;
    const re = new RegExp(`\\b(${label}(?: app)?)\\s+v${escapeRe(from)}\\b`, 'g');
    for (let i = 0; i < lines.length; i++) {
      const next = lines[i].replace(re, (_m, l) => (n++, `${l} v${to}`));
      lines[i] = next;
    }
  }
  let ctx: { app: string; until: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const b = builds.find(
      (p) => line.toLowerCase().includes(p.from.toLowerCase()) || line.toLowerCase().includes(p.from.slice(0, 8).toLowerCase()),
    );
    if (b) ctx = { app: b.app!, until: i + 3 };
    if (!ctx || i > ctx.until) continue;
    const { from, to } = map.versions[ctx.app];
    const f = escapeRe(from);
    let l = line;
    if (b) {
      l = l
        .replace(new RegExp(`(?<![\\w.])v${f}\\b`, 'g'), () => (n++, `v${to}`))
        .replace(new RegExp(`\\b(version\\s*[:=]?\\s*"?)${f}\\b`, 'gi'), (_m, p1) => (n++, `${p1}${to}`))
        .replace(new RegExp(`\\|\\s*${f}\\s*\\|`, 'g'), () => (n++, `| ${to} |`));
    } else {
      l = l.replace(new RegExp(`^(\\s*(?:released_)?version:\\s*"?)${f}("?\\s*)$`), (_m, p1, p2) => (n++, `${p1}${to}${p2}`));
    }
    lines[i] = l;
  }
  return n;
}

/** Rewrite every source asset ref in `text`. Returns the new text and the count. */
export function rewriteAssetRefs(text: string, map: AssetMap): { text: string; replacements: number } {
  let n = 0;
  const lines = text.split('\n');
  n += rewriteVersions(lines, map);
  let out = lines.join('\n');
  const patterns = [
    ...urlPatterns(map),
    // longest first, so a full id is replaced before its prefix could match
    ...map.pairs
      .slice()
      .sort((a, b) => b.from.length - a.from.length)
      .flatMap(idPatterns),
  ];
  for (const { re, to } of patterns) {
    out = out.replace(re, (...args) => {
      n++;
      // `$1$2` substitution for the contextual int-id pattern
      return to.replace(/\$(\d)/g, (_m, d) => String(args[Number(d)] ?? ''));
    });
  }
  return { text: out, replacements: n };
}

/** True when the text still names any source asset (the read-back). */
export function findSourceRefs(text: string, map: AssetMap): string[] {
  const found = new Set<string>();
  for (const p of map.pairs) {
    for (const { re } of idPatterns(p)) {
      re.lastIndex = 0;
      if (re.test(text)) found.add(p.from);
    }
  }
  return [...found];
}

/**
 * Invert a Google Doc's `text/plain` export so it can be written back with no
 * drift. Measured 2026-10-02 (ace#2606): uploading `A\nB` exports `A\r\nB`,
 * `A\n\nB` exports `A\r\n\r\n\r\nB` and `A\n\n\nB` exports five CRLFs — a run
 * of n newlines comes back as 2n-1 CRLFs. Writing the export straight back
 * therefore doubles every blank line on each round trip; the clone's first
 * apply did exactly that to 21 docs before this inverse existed.
 */
export function docTextFromExport(exported: string): string {
  return exported
    .replace(/^﻿/, '')
    .replace(/(?:\r\n)+/g, (run) => '\n'.repeat(Math.floor((run.length / 2 + 1) / 2)));
}

export type CloneFileKind = 'rewrite' | 'note' | 'skip';

export interface ClassifyOpts {
  /** Phase folders left on the source by operator decision (default: Phase 8). */
  keepPhaseFolders?: string[];
  connectRebuilt?: boolean;
  /** The text lands in a Google Doc — styled render or plain text alike. A Doc
   *  has no comment syntax, so the HTML-comment marker would print (see `addProvenanceNote`). */
  rich?: boolean;
}

const VERDICT_FILE = /(_verdict[^/]*|-qa_result|_result)\.ya?ml$/i;

export function classifyClonePath(path: string, opts: ClassifyOpts = {}): CloneFileKind {
  const keep = opts.keepPhaseFolders ?? ['8-solicitation-management'];
  const segs = path.split('/');
  const top = segs[0];
  const base = segs[segs.length - 1];
  if (keep.includes(top)) return 'skip';
  if (segs.some((x) => x === 'comms-log' || x.endsWith('_comms-log'))) return 'skip';
  if (/^decisions\b/.test(base)) return 'skip';
  if (/^release-(?:check|readiness)_/.test(base) || base === 'README.md' || base === 'run_state.yaml') return 'skip';
  // 4b re-runs Phase 4, which re-authors 4-connect from the clone's own products;
  // what it says about the source there is deliberate provenance.
  if (opts.connectRebuilt && top === '4-connect') return 'skip';
  if (VERDICT_FILE.test(base)) return 'note';
  return 'rewrite';
}

export const PROVENANCE_MARKER = 'clone-provenance';

function mappingSummary(map: AssetMap): string {
  const parts: string[] = [];
  const sd = map.source.hq_domain;
  const td = map.target.hq_domain;
  if (sd && td && sd !== td) parts.push(`HQ ${sd} → ${td}`);
  for (const k of Object.keys(map.source.apps)) {
    const a = map.source.apps[k];
    const b = map.target.apps[k];
    if (!b || !a.hq_app_id || a.hq_app_id === b.hq_app_id) continue;
    const va = a.released_version ? ` v${a.released_version}` : '';
    const vb = b.released_version ? ` v${b.released_version}` : '';
    parts.push(`${APP_LABEL[k] ?? k} ${a.hq_app_id.slice(0, 8)}${va} → ${b.hq_app_id!.slice(0, 8)}${vb}`);
  }
  if (map.connectRebuilt && map.source.connect && map.target.connect) {
    const sc = map.source.connect;
    const tc = map.target.connect;
    parts.push(
      `Connect opportunity ${sc.opportunity_id!.slice(0, 8)} (${sc.holding_org}) → ${tc.opportunity_id!.slice(0, 8)} (${tc.holding_org})`,
    );
  }
  return parts.join('; ');
}

export function provenanceNote(kind: 'rewrite' | 'note', map: AssetMap, label: CloneLabel): string {
  const m = mappingSummary(map);
  const head = `Copied into the ${label.to} workspace for review from ${label.from}.`;
  if (kind === 'rewrite') {
    const connect = map.connectRebuilt ? ` and Connect was rebuilt in ${label.to}'s own orgs` : '';
    return (
      `${head} The HQ apps are copies of the source run's released builds${connect}; the ids ` +
      `below name those copies (${m}).`
    );
  }
  return (
    `${head} This record was produced on the SOURCE run's assets and was not re-run on the ` +
    `copies, so it names the source ids on purpose. The copies: ${m}.`
  );
}

function wrap(text: string, width: number, prefix: string): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > width) {
      lines.push(prefix + cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(prefix + cur);
  return lines;
}

/**
 * Insert the note at the top in the file's own comment syntax: `#` for
 * YAML / Python (stays parseable; closed by a `# /clone-provenance` line so a
 * file's own leading comments are never mistaken for it), a blockquote after
 * any front matter for Markdown. `rich: true` is for text that lands in ANY
 * Google Doc, styled or plain — no HTML-comment marker, which a Doc prints as
 * text; the note line itself is recognisable. Replaces a note already there
 * (with or without a marker).
 */
export function addProvenanceNote(text: string, path: string, note: string, opts: { rich?: boolean } = {}): string {
  const body = stripProvenanceNote(text);
  if (/\.(ya?ml|py)$/i.test(path)) {
    const lead = body.startsWith('#!') ? body.slice(0, body.indexOf('\n') + 1) : '';
    const rest = body.slice(lead.length);
    return `${lead}# ${PROVENANCE_MARKER}\n${wrap(note, 78, '# ').join('\n')}\n# /${PROVENANCE_MARKER}\n${rest}`;
  }
  const block = `${opts.rich ? '' : `<!-- ${PROVENANCE_MARKER} -->\n`}> **Note:** ${note}\n\n`;
  const fm = /^---\n[\s\S]*?\n---\n/.exec(body);
  if (fm) return `${fm[0]}\n${block}${body.slice(fm[0].length).replace(/^\n+/, '')}`;
  return block + body;
}

/**
 * The note's own line, in every form it reaches a reader in: the markdown
 * source (`> **Note:** Copied into …`) and a rendered Doc's plain-text export
 * (`Note: Copied into …`), with or without the HTML-comment marker above it.
 */
const NOTE_LINE = String.raw`(?:> )?(?:\*\*)?Note:(?:\*\*)? Copied into the \S+ workspace for review from [^\n]*`;

/** The inverse of `addProvenanceNote` — so a re-run rewrites the body, never the note. */
export function stripProvenanceNote(text: string): string {
  return text
    .replace(new RegExp(`(^|\\n)# ${PROVENANCE_MARKER}\\n[\\s\\S]*?# /${PROVENANCE_MARKER}\\n`), '$1')
    .replace(new RegExp(`\\n?(?:<!-- ${PROVENANCE_MARKER} -->\\n)?${NOTE_LINE}\\n\\n?`), '');
}

export interface FileResult {
  kind: CloneFileKind;
  changed: boolean;
  text: string;
  replacements: number;
  /** Source refs present (before) — for the report on skipped files. */
  sourceRefs: string[];
}

/** Classify + rewrite one copied file. Untouched when it names no source asset. */
export function processCloneFile(
  path: string,
  text: string,
  map: AssetMap,
  label: CloneLabel,
  opts: ClassifyOpts = {},
): FileResult {
  const kind = classifyClonePath(path, { connectRebuilt: map.connectRebuilt, ...opts });
  const body = stripProvenanceNote(text);
  const sourceRefs = findSourceRefs(body, map);
  if (kind === 'skip' || sourceRefs.length === 0) {
    // A Doc an earlier pass already rewrote may still carry the marker it
    // printed; drop it so re-running the rewrite heals the copy.
    const own = opts.rich && kind !== 'skip' ? text.replace(`<!-- ${PROVENANCE_MARKER} -->\n`, '') : text;
    return { kind, changed: own !== text, text: own, replacements: 0, sourceRefs };
  }
  if (kind === 'note') {
    const t = addProvenanceNote(body, path, provenanceNote('note', map, label), { rich: opts.rich });
    return { kind, changed: t !== text, text: t, replacements: 0, sourceRefs };
  }
  const r = rewriteAssetRefs(body, map);
  const t = addProvenanceNote(r.text, path, provenanceNote('rewrite', map, label), { rich: opts.rich });
  return { kind, changed: t !== text, text: t, replacements: r.replacements, sourceRefs };
}

export interface RunStateRewrite {
  /** A `merge: "deep"` patch: whole values for each changed phase key. */
  patch: { phases?: Record<string, Record<string, unknown>> };
  changed: string[]; // phases.<phase>.<key>
  skippedWithRefs: string[];
}

function rewriteDeep(v: unknown, map: AssetMap): unknown {
  if (typeof v === 'string') return rewriteAssetRefs(v, map).text;
  if (Array.isArray(v)) return v.map((x) => rewriteDeep(x, map));
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = rewriteDeep(x, map);
    return o;
  }
  return v;
}

/**
 * The run_state half. Only `phases.*` is rewritten — the root `clone:` block is
 * the provenance record and keeps the source ids. Kept phases (Phase 8 by
 * default) are reported, not touched. A changed `status_note` / `summary`
 * gets a short "copied" suffix, because those read as a narrative of what this
 * run did.
 */
export function rewriteRunState(
  rs: any,
  map: AssetMap,
  label: CloneLabel,
  keepPhases: string[] = ['solicitation-management'],
): RunStateRewrite {
  const out: RunStateRewrite = { patch: {}, changed: [], skippedWithRefs: [] };
  const phases = rs?.phases ?? {};
  for (const [phase, block] of Object.entries<any>(phases)) {
    if (!block || typeof block !== 'object') continue;
    if (keepPhases.includes(phase)) {
      if (findSourceRefs(JSON.stringify(block), map).length) out.skippedWithRefs.push(`phases.${phase}`);
      continue;
    }
    for (const [key, val] of Object.entries(block)) {
      if (!findSourceRefs(JSON.stringify(val), map).length) continue;
      let next = rewriteDeep(val, map);
      if ((key === 'status_note' || key === 'summary') && typeof next === 'string') {
        next = `${next} [Copied into the ${label.to} workspace for review: the ids name ${label.to}'s copies of the source run's assets.]`;
      }
      if (JSON.stringify(next) === JSON.stringify(val)) continue;
      out.patch.phases = out.patch.phases ?? {};
      out.patch.phases[phase] = out.patch.phases[phase] ?? {};
      out.patch.phases[phase][key] = next;
      out.changed.push(`phases.${phase}.${key}`);
    }
  }
  return out;
}
