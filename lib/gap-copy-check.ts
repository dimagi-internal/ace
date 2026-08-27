/**
 * Check a demo's AUTHORED PROSE against its why-brief's declared gaps.
 *
 * A DDD `why_brief.yaml` declares typed `gaps[]` — the things the build cannot
 * support. `demo-narrative` gates the NARRATIVE against them. Nothing gated the
 * dashboard's own on-screen prose, so a demo could render a page asserting
 * exactly what its gap list said was unsupported, and every instance had to be
 * caught by a DDD judge reading pixels after a full render (ace#1750).
 *
 * Two string sources, one matcher. Dashboard `render_code` needs its prose
 * EXTRACTED from JSX; the narrative artifacts (`why_brief.spine[]`, the spec's
 * `scenes[]`) are already prose and are matched directly. Both were needed:
 * the same run's brief asserted a disposition is recorded "with its reason"
 * while its OWN gap declared no such field exists — a document contradicting
 * the limit it itself declared, and structurally invisible while `sources` was
 * a list of render_code files (ace#1759).
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
  proposed_action?: string;
}

/**
 * One authored surface to scan.
 *
 * Exactly one of `code` (render_code, prose is extracted) or `text` (already
 * prose — a spine claim, a scene's concept_claim) is supplied.
 */
export interface GapCopySource {
  /** Label reported on every finding, e.g. `why_brief:spine[x].claim`. */
  name: string;
  /** Authored render_code. Prose is extracted from it. */
  code?: string;
  /** Already-prose. Matched directly, reported at line 1. */
  text?: string;
}

/** The subset of a canopy `why_brief.yaml` this check reads. */
export interface WhyBriefLike {
  spine?: { id?: string; claim?: string; rationale?: string }[];
  gaps?: GapLike[];
}

/** The subset of a canopy unified spec this check reads. */
export interface UnifiedSpecLike {
  scenes?: {
    id?: string;
    concept_claim?: string;
    show?: string;
    narrative?: string;
  }[];
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
 * Build the narrative half of `sources` from the artifacts as parsed.
 *
 * Every entry is already prose, so it goes to the matcher directly — no
 * `extractProseLines` step, which exists only to dig copy out of JSX.
 */
export function narrativeSources(
  brief?: WhyBriefLike | null,
  spec?: UnifiedSpecLike | null,
): GapCopySource[] {
  const out: GapCopySource[] = [];
  const push = (name: string, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) return;
    out.push({ name, text });
  };

  (brief?.spine ?? []).forEach((item, i) => {
    const id = item?.id ?? String(i + 1);
    push(`why_brief:spine[${id}].claim`, item?.claim);
    push(`why_brief:spine[${id}].rationale`, item?.rationale);
  });

  // `gaps[]` is deliberately NOT a source. It is the one section of the document
  // whose job is to discuss unsupported things — its `detail` states a limit and
  // its `proposed_action` proposes the fix, and a remedy routinely names another
  // gap's subject on the way ("report the rates from the first cycle's
  // adjudication log"). Scanning it makes the honest gap list the report's own
  // worst source of findings. An earlier revision exempted a gap only from
  // ITSELF; on hh-poverty-targeting/20260827-0323 that still produced a
  // cross-gap hit with nothing for an author to fix (ace#1762).

  (spec?.scenes ?? []).forEach((scene, i) => {
    const id = scene?.id ?? String(i + 1);
    push(`unified_spec:scenes[${id}].concept_claim`, scene?.concept_claim);
    push(`unified_spec:scenes[${id}].show`, scene?.show);
    push(`unified_spec:scenes[${id}].narrative`, scene?.narrative);
  });

  return out;
}

/**
 * Flag authored prose that repeats the subject of a declared gap.
 *
 * `sources` is one entry per authored surface: `{name, code}` for a dashboard's
 * render_code, `{name, text}` for a narrative string (see `narrativeSources`).
 */
export function checkGapCopy(
  gaps: GapLike[],
  sources: GapCopySource[],
): GapCopyReport {
  const termsByGap: Record<string, string[]> = {};
  const findings: GapCopyFinding[] = [];

  // Only a CAPABILITY gap constrains what a surface may ASSERT — the thing it
  // names does not exist, so any prose about it is a claim the build cannot
  // back. The other two types forbid a QUALIFIED claim rather than the subject
  // itself, and separating "named it" from "asserted the qualified thing" is a
  // judgement no keyword match should make. Two instances of that one rule:
  //
  //   RESEARCH ("we don't know the real-world rate") does not forbid the page
  //   naming the thing — it forbids a quantified claim about it.
  //
  //   DECISION ("the threshold VALUES are unchosen") does not forbid naming
  //   thresholds — it forbids asserting a specific value ("the threshold is
  //   2x"). Measured on hh-poverty-targeting/20260827-0323, every DECISION hit
  //   was of the shape "recording the disposition is what makes a threshold
  //   tunable" — not merely compatible with the gap but its own proposed
  //   remedy, and 3 of the 9 findings on that run (ace#1762).
  const constraining = gaps.filter((g) => g.type === 'CAPABILITY');

  for (const gap of constraining) termsByGap[gap.id] = deriveGapTerms(gap);

  for (const src of sources) {
    const prose =
      src.code !== undefined
        ? extractProseLines(src.code)
        : [{ line: 1, text: (src.text ?? '').replace(/\s+/g, ' ').trim() }];
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
