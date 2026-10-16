/**
 * Do the `[FIXED]` clauses of a set of component PDDs survive composition into
 * one programme overview — and do two components' `[FIXED]` clauses agree?
 *
 * Why this exists (dimagi-internal/ace#2365). `idea-to-pdd`'s componentized
 * branch (Step 0a) composes N authored component PDDs into one programme
 * overview. Each component PDD's own § 0 says a `[FIXED]` element is
 * implemented exactly and that ACE "flags it to a human rather than resolving
 * it" when it is ambiguous. On `poverty-graduation/20260908-0510` the composed
 * overview did both of the things that rule forbids:
 *
 *  1. **Silent pick between conflicting `[FIXED]` clauses.** Productive Asset
 *     § 8 [FIXED]: the delivered-and-verified flag "gates the recurring
 *     components". Consumption Support § 8 [FIXED]: it is consumed only "where
 *     the model sequences consumption support behind asset delivery". The
 *     overview stated the conditional reading as fact.
 *  2. **A `[FIXED]` threshold dropped.** Targeting § 6 [FIXED]: "GPS: location
 *     missing, spoofed, or > 200m from the FLW's other visits in an implausible
 *     pattern". The overview's verification row carries "GPS present, not
 *     spoofed, plausible travel speed between consecutive visits" — the 200m
 *     figure appears nowhere in its body.
 *
 * ## What this module decides, and what it deliberately does not
 *
 * The overview "composes; it does not restate" (Step 0a), so a `[FIXED]`
 * clause that the overview never touches is NOT a defect — the component PDD
 * stays the authority and downstream reads it by `pdd_file_id`. Those clauses
 * are reported as `uncarried` for completeness, not as findings.
 *
 * What IS a finding is a clause the overview *does* restate, without carrying
 * it verbatim, while losing a load-bearing quantity (`quantity-dropped`) — a
 * paraphrase that weakens a `[FIXED]` threshold is the ace#2365 failure.
 * Paraphrases that keep every quantity are listed as `paraphrased` for the
 * author to confirm, not raised as open questions; a clause the overview cites
 * by component and section (`C6 § 8 [FIXED]`) counts as carried.
 *
 * Conflict detection is a heuristic and says so: two clauses from DIFFERENT
 * components that name the same state term, where one is conditional
 * (`where …`, `only if …`, `unless …`) and the other is not, are raised as a
 * `possible-conflict` open question. The module never decides which reading
 * is right — that is the human's call by the PDDs' own § 0.
 *
 * Input text is the Google Docs plain-text export (`drive_read_file`) or
 * markdown. Reviewer-comment footnotes (`[ad]Targeting § 6 …`) and inline
 * comment markers (`[c][d]`) are stripped first — a threshold quoted only in a
 * reviewer's comment has not survived into the document.
 *
 * Pure — the caller reads the documents.
 */

export interface FixedClause {
  /** Stable id: `<component> §<section> #<n>`. */
  id: string;
  component: string;
  section: string;
  /** The tag as written, e.g. `FIXED` or `FIXED — scope boundary`. */
  tag: string;
  text: string;
  quantities: string[];
}

export interface ComponentPddText {
  /** The component's id as `component-set` names it (e.g. `2`, `5`, `6`). */
  component: string;
  text: string;
  /**
   * How the composed overview cites this component — e.g. `['C5', 'Productive
   * Asset']`. A citation `<alias> § <section>` in the overview counts as
   * carrying every clause of that section.
   */
  citeAs?: readonly string[];
}

export type ClauseSurvival = 'verbatim' | 'cited' | 'mapped' | 'paraphrased' | 'uncarried';

export type FixedClauseFindingKind = 'quantity-dropped' | 'possible-conflict';

export interface FixedClauseFinding {
  kind: FixedClauseFindingKind;
  clauses: string[];
  message: string;
  /** `quantity-dropped`: the quantities the overview no longer carries. */
  droppedQuantities?: string[];
  /** `possible-conflict`: the shared state term. */
  stateTerm?: string;
}

export interface FixedClauseSurvivalReport {
  ok: boolean;
  clauses: (FixedClause & { survival: ClauseSurvival })[];
  findings: FixedClauseFinding[];
}

// ---------------------------------------------------------------------------
// Text hygiene
// ---------------------------------------------------------------------------

/** A Google Docs export footnote line: `[ad]Targeting § 6 …`. */
const FOOTNOTE_LINE = /^\[[a-z]{1,3}\]/;
const INLINE_MARKER = /\[[a-z]{1,3}\]/g;

function bodyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((l) => !FOOTNOTE_LINE.test(l.trim()))
    .map((l) => l.replace(INLINE_MARKER, ''));
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const UNIT: Record<string, string> = {
  m: 'm', metre: 'm', metres: 'm', meter: 'm', meters: 'm',
  km: 'km', kilometre: 'km', kilometres: 'km', kilometer: 'km', kilometers: 'km',
  min: 'min', mins: 'min', minute: 'min', minutes: 'min',
  hour: 'h', hours: 'h', hr: 'h', hrs: 'h',
  day: 'd', days: 'd',
  '%': '%', percent: '%',
};

/** Load-bearing numeric thresholds, canonicalised: `> 200m` and `200 metres` both -> `200m`. */
export function quantitiesIn(text: string): string[] {
  const out: string[] = [];
  const re = /(\d+(?:\.\d+)?)\s*(%|percent\b|kilomet(?:re|er)s?\b|km\b|met(?:re|er)s?\b|m\b|minutes?\b|mins?\b|hours?\b|hrs?\b|days?\b)/gi;
  for (const m of text.matchAll(re)) {
    const unit = UNIT[m[2].toLowerCase()];
    if (!unit) continue;
    const q = `${Number(m[1])}${unit}`;
    if (!out.includes(q)) out.push(q);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const HEADING_PLAIN = /^(\d+[a-z]?(?:\.\d+)*)\.?\s+([A-Z][^\n]{0,90})$/;
const HEADING_MD = /^#{1,6}\s+(\d+[a-z]?(?:\.\d+)*)\.?\s+/;
const TAG = /^\[(FIXED[^\]]*)\]\s*(.*)$/;
const BULLET = /^(?:[*\-•]\s+|\d+\.\s+)(.*)$/;

function headingOf(line: string): string | null {
  const md = HEADING_MD.exec(line);
  if (md) return md[1];
  const plain = HEADING_PLAIN.exec(line);
  // A numbered list item ends in a full stop; a section heading does not.
  if (plain && !/[.:;]$/.test(plain[2].trim())) return plain[1];
  return null;
}

/**
 * Every `[FIXED]` clause in one component PDD. A tag line with text is one
 * clause; the bullets (or numbered items) that follow a tag are one clause
 * each. The § 0 legend (`* [FIXED] — a hard constraint …`) is a bullet, not a
 * tag line, and is not a clause.
 */
export function extractFixedClauses(component: string, text: string): FixedClause[] {
  const out: FixedClause[] = [];
  let section = '0';
  let open: { tag: string } | null = null;
  const push = (tag: string, body: string) => {
    const t = body.replace(/\s+/g, ' ').trim();
    if (!t) return;
    out.push({
      id: `${component} §${section} #${out.filter((c) => c.section === section).length + 1}`,
      component,
      section,
      tag,
      text: t,
      quantities: quantitiesIn(t),
    });
  };

  for (const raw of bodyLines(text)) {
    const line = raw.trim();
    if (!line) continue;
    const tag = TAG.exec(line);
    if (tag) {
      open = { tag: tag[1].trim() };
      push(open.tag, tag[2]);
      continue;
    }
    if (/^\[[A-Z]+/.test(line)) {
      open = null; // an [ACE] (or other) tag closes the FIXED block
      continue;
    }
    const h = headingOf(line);
    if (h && !(open && BULLET.test(line) && /[.)]$/.test(line))) {
      section = h;
      open = null;
      continue;
    }
    const b = BULLET.exec(line);
    if (open && b) {
      push(open.tag, b[1]);
      continue;
    }
    open = null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Survival + conflicts
// ---------------------------------------------------------------------------

const STOP = new Set(
  'that this with from have does what when where which their there they them into than then must only each also other been were will would shall '
    .split(' ')
    .filter(Boolean),
);

function keywords(s: string): Set<string> {
  return new Set(
    norm(s)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  );
}

/** The overview restates a clause when some body line shares most of the clause's (or the line's) keywords. */
function addressed(clause: Set<string>, lines: Set<string>[]): boolean {
  for (const l of lines) {
    let inter = 0;
    for (const w of clause) if (l.has(w)) inter++;
    if (inter >= 3 && inter / Math.min(clause.size, l.size) >= 0.5) return true;
  }
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A clause only CONSTRAINS a state's role when it says what the state gates,
 * sequences or requires. Without this, every clause that merely mentions the
 * state ("a household already at delivered-and-verified is not shown the
 * module again") pairs with every conditional one.
 */
const GATING = /\b(gates?|gated|gating|sequences?|sequenced|depends? on|requires?|blocks?)\b/i;

const CONDITIONAL = /\b(where|only if|only when|only where|unless|provided that|conditional(?:ly)?|if)\b/i;

/** Hyphenated state names (`delivered-and-verified`) used by more than one component. */
function sharedStateTerms(clauses: readonly FixedClause[]): string[] {
  const byTerm = new Map<string, Set<string>>();
  for (const c of clauses) {
    for (const m of c.text.toLowerCase().matchAll(/\b[a-z]+(?:-[a-z]+){2,}\b/g)) {
      const set = byTerm.get(m[0]) ?? new Set<string>();
      set.add(c.component);
      byTerm.set(m[0], set);
    }
  }
  return [...byTerm].filter(([, comps]) => comps.size > 1).map(([t]) => t);
}

/**
 * Check every `[FIXED]` clause of every carried component against the composed
 * overview, and every pair of components' clauses for a possible conflict.
 */
export function checkFixedClauseSurvival(input: {
  components: readonly ComponentPddText[];
  composed: string;
  /** Clause ids the overview carries under a cited mapping the author recorded. */
  mapped?: ReadonlySet<string>;
  /** State terms from the shared case-and-state model, beyond the auto-detected ones. */
  stateTerms?: readonly string[];
}): FixedClauseSurvivalReport {
  const composedLines = bodyLines(input.composed);
  const composedNorm = norm(composedLines.join(' '));
  const composedQuantities = new Set(quantitiesIn(composedLines.join('\n')));
  const composedKeywordLines = composedLines.map(keywords).filter((k) => k.size > 0);
  const findings: FixedClauseFinding[] = [];
  const clauses: FixedClauseSurvivalReport['clauses'] = [];

  for (const comp of input.components) {
    const cites = (comp.citeAs ?? []).map((a) => escapeRe(a.toLowerCase()));
    for (const c of extractFixedClauses(comp.component, comp.text)) {
      const verbatim = composedNorm.includes(norm(c.text).replace(/[.;:]$/, ''));
      const cited =
        cites.length > 0 &&
        new RegExp(`\\b(?:${cites.join('|')})\\s*§\\s*${escapeRe(c.section)}\\b`).test(composedNorm);
      const restated = addressed(keywords(c.text), composedKeywordLines);
      const survival: ClauseSurvival = verbatim
        ? 'verbatim'
        : input.mapped?.has(c.id)
          ? 'mapped'
          : cited
            ? 'cited'
            : restated
              ? 'paraphrased'
              : 'uncarried';
      clauses.push({ ...c, survival });

      if (survival !== 'verbatim' && (cited || restated)) {
        const dropped = c.quantities.filter((q) => !composedQuantities.has(q));
        if (dropped.length) {
          findings.push({
            kind: 'quantity-dropped',
            clauses: [c.id],
            droppedQuantities: dropped,
            message: `${c.id} [${c.tag}] fixes ${dropped.join(', ')} — "${c.text}" — and the composed overview restates this rule without it. Carry the [FIXED] clause verbatim, or raise the omission to a human.`,
          });
        }
      }
    }
  }

  const all = clauses;
  const terms = [...new Set([...(input.stateTerms ?? []).map((t) => t.toLowerCase()), ...sharedStateTerms(all)])];
  const seenPairs = new Set<string>();
  for (const term of terms) {
    const withTerm = all.filter((c) => c.text.toLowerCase().includes(term));
    for (const a of withTerm) {
      for (const b of withTerm) {
        if (a.component === b.component || a.component > b.component) continue;
        if (!GATING.test(a.text) || !GATING.test(b.text)) continue;
        const condA = CONDITIONAL.test(a.text);
        const condB = CONDITIONAL.test(b.text);
        if (condA === condB) continue;
        const key = `${term}|${a.id}|${b.id}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        const [cond, uncond] = condA ? [a, b] : [b, a];
        findings.push({
          kind: 'possible-conflict',
          clauses: [uncond.id, cond.id],
          stateTerm: term,
          message: `Both [FIXED], both about "${term}": ${uncond.id} states it unconditionally ("${uncond.text}"), ${cond.id} conditionally ("${cond.text}"). Ask a human which governs; do not state either reading as fact in the overview.`,
        });
      }
    }
  }

  return { ok: findings.length === 0, clauses, findings };
}
