/**
 * Does each `[FIXED]` instrument question in a RELEASED form carry the
 * published question text and exactly the published options?
 *
 * Why this exists (dimagi-internal/ace#2366). On `poverty-graduation/20260908-0510`
 * the released Deliver app digitised the Nigeria PPI — a `[FIXED]`,
 * verbatim-only instrument whose source sat in the run's `inputs/` — and ONE of
 * its ten questions carried a third option the instrument does not have:
 *
 *     ppi_assets-ppi_fan-opt0-label | A. Yes
 *     ppi_assets-ppi_fan-opt1-label | B. No
 *     ppi_assets-ppi_fan-opt2-label | Declined or does not know
 *
 * The instrument says "No paraphrasing, no added or dropped options", and the
 * source workbook says changing any option invalidates the tool. The score was
 * unaffected (the option scores 0, same as No), which is exactly why nothing
 * caught it: `lib/instrument-constants.ts` `diffScoringConstants` compares POINT
 * VALUES only, and an added zero-point option is invisible to a points diff.
 * `app-release-qa` had no instrument step at all.
 *
 * This module is the missing axis: question TEXT and option SET (count, labels,
 * order), read from the released XForm and compared with the instrument
 * markdown in `inputs/`. Points stay `instrument-constants`' job.
 *
 * ## What counts as "the same label"
 *
 * The instrument letters its options (`A. North Central`, `A.Yes`) and a
 * released app may or may not keep the letter. The letter is the scorecard's
 * presentation, not the option, so a leading `A.` / `B. ` is stripped on both
 * sides and whitespace is collapsed. Nothing else is normalised — case and
 * wording are the instrument's, and "verbatim" means verbatim.
 *
 * Pure — no network, no filesystem. The caller reads the instrument file and
 * the released form XML; this module only compares.
 */

import { DOMParser } from '@xmldom/xmldom';

// ---------------------------------------------------------------------------
// The instrument markdown
// ---------------------------------------------------------------------------

export interface InstrumentOption {
  label: string;
  points: number | null;
}

export interface InstrumentQuestion {
  /** The instrument's own question number, as written (`'1'`, `'9'`). */
  number: string;
  text: string;
  options: InstrumentOption[];
}

function cells(line: string): string[] {
  const t = line.trim();
  if (!t.startsWith('|')) return [];
  return t
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function isSeparatorRow(c: string[]): boolean {
  return c.length > 0 && c.every((x) => /^:?-{2,}:?$/.test(x));
}

/**
 * Parse the scorecard table out of an instrument markdown file.
 *
 * The table is located by its HEADER, not its position: a column named
 * `Response` / `Option` / `Answer` is the option column, `Indicator` /
 * `Question` the question column, `#` / `No` the number, `Points` optional.
 * A row with a number starts a question; a row with an empty number continues
 * the previous question's options. Any other table in the file (the
 * score→likelihood lookup) has no option column and is ignored.
 */
export function parseInstrumentMarkdown(md: string): InstrumentQuestion[] {
  const lines = md.split(/\r?\n/);
  const out: InstrumentQuestion[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = cells(lines[i]).map((h) => h.toLowerCase());
    if (header.length < 3 || !isSeparatorRow(cells(lines[i + 1] ?? ''))) continue;
    const opt = header.findIndex((h) => /^(response|option|options|answer)s?$/.test(h));
    const q = header.findIndex((h) => /^(indicator|question)s?$/.test(h));
    const num = header.findIndex((h) => /^(#|no\.?|number)$/.test(h));
    const pts = header.findIndex((h) => /^points?$/.test(h));
    if (opt < 0 || q < 0 || num < 0) continue;

    let current: InstrumentQuestion | null = null;
    let j = i + 2;
    for (; j < lines.length; j++) {
      const row = cells(lines[j]);
      if (row.length === 0) break;
      const n = row[num] ?? '';
      if (n) {
        current = { number: n, text: row[q] ?? '', options: [] };
        out.push(current);
      }
      if (!current) continue;
      const label = row[opt] ?? '';
      if (!label) continue;
      const p = pts >= 0 ? Number((row[pts] ?? '').replace(/[^0-9.-]/g, '')) : NaN;
      current.options.push({ label, points: pts >= 0 && (row[pts] ?? '') !== '' && Number.isFinite(p) ? p : null });
    }
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The released form
// ---------------------------------------------------------------------------

export interface ReleasedSelect {
  /** The control's `ref`, e.g. `/data/g_assets/i9_fan`. */
  ref: string;
  text: string;
  options: string[];
}

const ITEXT_REF = /jr:itext\('([^']+)'\)/;

function textOf(el: Element | undefined | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function directChildren(el: Element, tag: string): Element[] {
  return Array.from(el.childNodes ?? []).filter(
    (n): n is Element => (n as Element).nodeType === 1 && (n as Element).nodeName === tag,
  );
}

/**
 * itext id → text in the DEFAULT language (the `default` translation, else the
 * first). The plain `<value>` wins over `form="markdown"` / `form="image"`.
 */
function defaultItext(doc: Document): Map<string, string> {
  const idx = new Map<string, string>();
  const translations = Array.from(doc.getElementsByTagName('translation'));
  const chosen = translations.find((t) => t.hasAttribute('default')) ?? translations[0];
  if (!chosen) return idx;
  for (const t of Array.from(chosen.getElementsByTagName('text'))) {
    const id = t.getAttribute('id');
    if (!id) continue;
    const values = Array.from(t.getElementsByTagName('value'));
    const plain = values.find((v) => !v.hasAttribute('form')) ?? values.find((v) => v.getAttribute('form') === 'markdown');
    if (plain) idx.set(id, textOf(plain));
  }
  return idx;
}

function labelOf(el: Element, itext: Map<string, string>): string {
  const [label] = directChildren(el, 'label');
  if (!label) return '';
  const inline = textOf(label);
  if (inline) return inline;
  const m = ITEXT_REF.exec(label.getAttribute('ref') ?? '');
  return m ? (itext.get(m[1]) ?? '') : '';
}

/** Every `select1` / `select` in a released XForm, with its label and option labels in order. */
export function readReleasedSelects(xformXml: string): ReleasedSelect[] {
  const doc = new DOMParser().parseFromString(xformXml, 'text/xml') as unknown as Document;
  const itext = defaultItext(doc);
  const out: ReleasedSelect[] = [];
  for (const tag of ['select1', 'select']) {
    for (const el of Array.from(doc.getElementsByTagName(tag))) {
      out.push({
        ref: el.getAttribute('ref') ?? '',
        text: labelOf(el, itext),
        options: directChildren(el, 'item').map((item) => labelOf(item, itext)),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

export type FixedInstrumentFindingKind =
  /** No released select carries this question's text, or anything close to it. */
  | 'question-not-found'
  /** A released select is clearly this question, but its text is not verbatim. */
  | 'question-text-changed'
  /** The build offers an option the instrument does not have (ace#2366). */
  | 'option-added'
  /** The instrument has an option the build does not offer. */
  | 'option-dropped'
  /** Same option set, different order. */
  | 'option-order-changed';

export interface FixedInstrumentFinding {
  kind: FixedInstrumentFindingKind;
  question: string;
  /** The released control, when one was matched. */
  ref?: string;
  source?: string;
  built?: string;
  message: string;
}

export interface FixedInstrumentExemption {
  /** Instrument question number. */
  question: string;
  /** Why this question is legitimately not a released select — cite the instrument. */
  reason: string;
}

export interface FixedInstrumentReport {
  ok: boolean;
  questionsChecked: number;
  matched: { question: string; ref: string; exact: boolean }[];
  exempted: FixedInstrumentExemption[];
  findings: FixedInstrumentFinding[];
}

/** Instrument option letters (`A. `, `B.`) are presentation, not the option. */
export function normaliseOptionLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim().replace(/^[A-Z]\.\s*/, '');
}

function normaliseQuestion(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Below this, a released select is not "this question reworded" — it is a different question. */
const REWORD_THRESHOLD = 0.5;

/**
 * Diff every `[FIXED]` instrument question against the released form's selects.
 *
 * Each instrument question is matched to the released select with the same
 * text; failing that, to the most similar one (a reword); failing that, it is
 * `question-not-found` unless the caller EXEMPTS it with a reason — e.g. the
 * Nigeria PPI's household-size indicator, which the instrument itself says to
 * derive from a roster rather than ask. An exemption is recorded in the report,
 * never silent.
 *
 * The option comparison is set-and-order: an option in the build that the
 * instrument lacks is `option-added` (the ace#2366 failure), the reverse is
 * `option-dropped`, and identical sets in a different order are
 * `option-order-changed`.
 */
export function checkFixedInstrumentVerbatim(input: {
  instrument: readonly InstrumentQuestion[];
  /** Released form XML(s) the instrument is digitised into. */
  forms: readonly string[];
  exempt?: readonly FixedInstrumentExemption[];
}): FixedInstrumentReport {
  const selects = input.forms.flatMap((xml) => readReleasedSelects(xml));
  const exemptBy = new Map((input.exempt ?? []).map((e) => [e.question, e]));
  const findings: FixedInstrumentFinding[] = [];
  const matched: FixedInstrumentReport['matched'] = [];
  const exempted: FixedInstrumentExemption[] = [];
  const used = new Set<ReleasedSelect>();

  // Two passes: every exact match is claimed FIRST, so a reworded question can
  // only fall back onto a select no verbatim question owns. (PPI asset
  // questions share a stem — "Does your household own a sofa?" vs "… an
  // IRON?" score 0.67 — so a single greedy pass lets one reword steal a
  // sibling's select.)
  const exactHit = new Map<InstrumentQuestion, ReleasedSelect>();
  for (const q of input.instrument) {
    const want = normaliseQuestion(q.text);
    const hit = selects.find((s) => !used.has(s) && normaliseQuestion(s.text) === want);
    if (hit) {
      used.add(hit);
      exactHit.set(q, hit);
    }
  }

  for (const q of input.instrument) {
    let hit = exactHit.get(q);
    const exact = Boolean(hit);
    if (!hit) {
      const wantTokens = tokens(normaliseQuestion(q.text));
      let best: ReleasedSelect | undefined;
      let bestScore = 0;
      for (const s of selects) {
        if (used.has(s)) continue;
        const score = jaccard(wantTokens, tokens(s.text));
        if (score > bestScore) {
          bestScore = score;
          best = s;
        }
      }
      if (best && bestScore >= REWORD_THRESHOLD) hit = best;
    }

    if (!hit) {
      const ex = exemptBy.get(q.number);
      if (ex) {
        exempted.push(ex);
        continue;
      }
      findings.push({
        kind: 'question-not-found',
        question: q.number,
        source: q.text,
        message: `Instrument question ${q.number} ("${q.text}") is not a select in the released form — it was dropped, or reworded past recognition.`,
      });
      continue;
    }

    used.add(hit);
    matched.push({ question: q.number, ref: hit.ref, exact });
    if (!exact) {
      findings.push({
        kind: 'question-text-changed',
        question: q.number,
        ref: hit.ref,
        source: q.text,
        built: hit.text,
        message: `Question ${q.number} at ${hit.ref} is not verbatim: instrument "${q.text}", released "${hit.text}".`,
      });
    }

    const source = q.options.map((o) => normaliseOptionLabel(o.label));
    const built = hit.options.map(normaliseOptionLabel);
    const sourceSet = new Set(source);
    const builtSet = new Set(built);
    for (const b of built) {
      if (!sourceSet.has(b)) {
        findings.push({
          kind: 'option-added',
          question: q.number,
          ref: hit.ref,
          built: b,
          message: `Question ${q.number} at ${hit.ref} offers "${b}", which the [FIXED] instrument does not have (${source.length} options in the instrument, ${built.length} released).`,
        });
      }
    }
    for (const s of source) {
      if (!builtSet.has(s)) {
        findings.push({
          kind: 'option-dropped',
          question: q.number,
          ref: hit.ref,
          source: s,
          message: `Question ${q.number} at ${hit.ref} does not offer the instrument's option "${s}".`,
        });
      }
    }
    const sameSet = source.length === built.length && source.every((s) => builtSet.has(s));
    if (sameSet && source.some((s, i) => built[i] !== s)) {
      findings.push({
        kind: 'option-order-changed',
        question: q.number,
        ref: hit.ref,
        source: source.join(' / '),
        built: built.join(' / '),
        message: `Question ${q.number} at ${hit.ref} reorders the instrument's options.`,
      });
    }
  }

  return {
    ok: findings.length === 0,
    questionsChecked: input.instrument.length,
    matched,
    exempted,
    findings,
  };
}
