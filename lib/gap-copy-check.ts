/**
 * Check a demo's DASHBOARD COPY against its why-brief's declared gaps.
 *
 * A DDD `why_brief.yaml` declares typed `gaps[]` — the things the build cannot
 * support. `demo-narrative` gates the NARRATIVE against them. Nothing gated the
 * dashboard's own on-screen prose, so a demo could render a page asserting
 * exactly what its gap list said was unsupported, and every instance had to be
 * caught by a DDD judge reading pixels after a full render (ace#1750).
 *
 * Measured on hh-poverty-targeting/20260827-0323: four instances in one run,
 * across two dashboards, and in ALL FOUR the narration was clean and the UI copy
 * was the offender. One of them contradicted the same page's own definition two
 * lines above it.
 *
 * This is a FLAG, never a rejection. It cannot know which phrasings are
 * load-bearing, and refusing a legal spec on a keyword match would be the
 * ace#1238 guard-predicts-a-rejection failure. It reports candidate lines and
 * the author resolves each — the posture `checkSceneCardinality` already takes.
 */

/** The subset of a canopy `Gap` this check reads. */
export interface GapLike {
  id: string;
  type: 'RESEARCH' | 'CAPABILITY' | 'DECISION' | string;
  detail: string;
}

export interface GapCopyFinding {
  /** The gap whose subject the copy repeats. */
  gapId: string;
  /** The term that matched, lower-cased. */
  term: string;
  /** Which authored surface the string came from. */
  source: string;
  /** 1-based line within that source. */
  line: number;
  /** The offending prose, trimmed. */
  text: string;
}

export interface GapCopyReport {
  ok: boolean;
  findings: GapCopyFinding[];
  /** Terms derived per gap — exposed so a caller can show its work. */
  termsByGap: Record<string, string[]>;
}

/**
 * Generic product vocabulary that appears in almost any dashboard and carries no
 * signal about a specific capability gap. Without this, a gap id like
 * `adjudication-log-is-run-state-not-a-register` contributes `run` and `state`
 * and flags every surface in the demo.
 */
const GENERIC_TERMS = new Set([
  'run', 'runs', 'state', 'page', 'data', 'value', 'values', 'score', 'scores',
  'review', 'reviews', 'report', 'reports', 'table', 'column', 'columns',
  'worker', 'workers', 'field', 'fields', 'record', 'records', 'visit', 'visits',
  'demo', 'exist', 'exists', 'does', 'not', 'this', 'that', 'with', 'from',
  'into', 'onto', 'them', 'they', 'been', 'have', 'here', 'only', 'more',
  'than', 'some', 'when', 'what', 'which', 'while', 'about', 'after', 'before',
]);

/**
 * Derive the subject terms of a gap.
 *
 * A gap `id` is authored to NAME its subject (`area-register-does-not-exist`),
 * and its `detail` explains it. Taking the intersection keeps words the author
 * used deliberately in both places and drops the incidental vocabulary of
 * either one.
 */
export function deriveGapTerms(gap: GapLike): string[] {
  const idWords = gap.id.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const detail = gap.detail.toLowerCase();
  const out: string[] = [];
  for (const w of idWords) {
    if (w.length < 4) continue;
    if (GENERIC_TERMS.has(w)) continue;
    // singular/plural tolerance in the detail only
    if (!detail.includes(w) && !detail.includes(w.replace(/s$/, ''))) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

/**
 * Pull human-readable prose out of authored render_code.
 *
 * Two shapes carry copy a viewer reads: JSX text nodes between tags, and string
 * literals long enough to be a sentence fragment. Short literals are skipped —
 * they are class names, ids, enum values and CSS keywords, none of which a
 * reader sees as prose.
 */
export function extractProseLines(source: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const lines = source.split('\n');

  /**
   * Is this line a JSX TEXT line — prose a viewer reads, not code?
   *
   * Deliberately a line-shape heuristic rather than a scanner. render_code is a
   * JS file, not a JSX document: `<` appears in comparisons (`i < n`) and `>` in
   * arrow functions, so a tag-aware character scan desynchronises on the first
   * one and starts reporting code as prose. Measured while building this —
   * a scanner emitted `+ C.line, borderRadius: 10, overflow:` as a prose piece.
   *
   * A prose line survives inline-tag stripping with three or more words and
   * carries none of the punctuation that makes a line code.
   */
  const proseOf = (raw: string): string | null => {
    const stripped = raw.replace(/<[^<>]*>/g, ' ');
    if (/[={};()[\]]/.test(stripped)) return null;
    const text = stripped.replace(/\s+/g, ' ').trim();
    if (text.split(' ').filter(Boolean).length < 3) return null;
    if (!/[A-Za-z]{3}/.test(text)) return null;
    return text;
  };

  // Consecutive prose lines are one paragraph: a wrapped JSX text node must be
  // matched whole, because the subject of a gap routinely straddles the wrap.
  let buf: string[] = [];
  let bufLine = 0;
  const flush = () => {
    if (buf.length) out.push({ line: bufLine, text: buf.join(' ') });
    buf = [];
  };
  lines.forEach((raw, idx) => {
    const prose = proseOf(raw);
    if (prose === null) { flush(); return; }
    if (!buf.length) bufLine = idx + 1;
    buf.push(prose);
  });
  flush();

  // Plus string literals of sentence length — copy also reaches the screen as
  // `title="..."`, a built label, or a concatenated fragment.
  lines.forEach((raw, idx) => {
    for (const m of raw.matchAll(/'([^'\\]{12,})'|"([^"\\]{12,})"/g)) {
      const text = (m[1] ?? m[2] ?? '').replace(/\s+/g, ' ').trim();
      if (text.split(' ').filter(Boolean).length < 3) continue;
      if (!/[A-Za-z]{3}/.test(text)) continue;
      out.push({ line: idx + 1, text });
    }
  });

  return out;
}

/**
 * Flag dashboard copy that repeats the subject of a declared gap.
 *
 * `sources` is one entry per authored surface — `{name, code}` where `code` is
 * the render_code as it will be uploaded.
 */
export function checkGapCopy(
  gaps: GapLike[],
  sources: { name: string; code: string }[],
): GapCopyReport {
  const termsByGap: Record<string, string[]> = {};
  const findings: GapCopyFinding[] = [];

  // Only capability/decision gaps constrain what a surface may ASSERT. A
  // RESEARCH gap ("we don't know the real-world rate") does not forbid the page
  // from naming the thing — it forbids a quantified claim about it, which is a
  // judgement no keyword match should make.
  const constraining = gaps.filter(
    (g) => g.type === 'CAPABILITY' || g.type === 'DECISION',
  );

  for (const gap of constraining) termsByGap[gap.id] = deriveGapTerms(gap);

  for (const src of sources) {
    const prose = extractProseLines(src.code);
    for (const gap of constraining) {
      for (const term of termsByGap[gap.id]) {
        for (const { line, text } of prose) {
          if (!new RegExp(`\\b${term}s?\\b`, 'i').test(text)) continue;
          findings.push({ gapId: gap.id, term, source: src.name, line, text });
        }
      }
    }
  }

  return { ok: findings.length === 0, findings, termsByGap };
}
