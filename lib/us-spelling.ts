// lib/us-spelling.ts
//
// Dimagi writes US English: program, enrollment, organization — never
// programme, enrolment, organisation (`skills/_terminology.md` § US spelling,
// always; owner decision 2026-10-20: "everything should be US spelling", no
// carve-out for worker-facing app labels — ace#3232).
//
// ── The reproducer ─────────────────────────────────────────────────────────
//
// connect-fi/20261018-1440: the PDD carried `programme` x12, `enrolment` x34,
// `enrol` x2, `organisation` x2 (counted with `grep -o -w <word> | wc -l`), and
// the apps built from it shipped "Enrol adults", "Adult Enrolment" and "The
// programme and the four items" to workers. The PDD is upstream of every app
// label and training artifact, so this scan runs on the PDD (idea-to-pdd-qa
// `us_spelling`), where a fix is one find-and-replace.
//
// ── What it predicts ───────────────────────────────────────────────────────
//
// Nothing about an external system: it scans ACE's own prose against a fixed
// word list. Intra-record, so the predictive-guard citation rule does not apply.
//
// ── What it deliberately does NOT flag ─────────────────────────────────────
//
// Identifiers are never rewritten (`_terminology.md`: code identifiers, config
// keys, SQL/registry property names stay as they are). So a word is skipped
// when it sits inside:
//   - a backtick code span;
//   - a token containing `_`, `/` or `.` (snake_case property names like
//     `days_to_enrolment`, paths, URLs, file names) — `\b` already treats `_`
//     as a word character, the explicit token check covers the rest;
//   - a lower-case slug with two or more hyphens (`connect-fi-programme-cascade`,
//     a Drive narrative slug). A single hyphen ("programme-level") is prose and
//     IS flagged.
//
// ── Proper names ───────────────────────────────────────────────────────────
//
// An organization's registered name ("Centre for Global Development") keeps
// its own spelling — it is a name, not our prose. A scan cannot tell a proper
// name from a capitalized heading word, so findings are split by case:
// a LOWER-CASE occurrence is never a proper name and is a hard finding; a
// capitalized one is reported as `capitalized` for the writer to judge. The
// QA check fails on the first and lists the second.

export interface UkSpellingRule {
  /** Matches the UK form, case-insensitive, whole word. */
  pattern: RegExp;
  /** US replacement for the lower-case form. */
  us: (uk: string) => string;
}

/**
 * UK → US word list, each entry whole-word. Deliberately absent: `analyses` (also
 * the US plural of "analysis"), `programmed` (same in both), `licence` (a noun in
 * UK English only, but too often a quoted licence name to judge by scan).
 */
const PAIRS: Array<[string, string]> = [
  ['programme', 'program'],
  ['programmes', 'programs'],
  ['enrol', 'enroll'],
  ['enrols', 'enrolls'],
  ['enrolment', 'enrollment'],
  ['enrolments', 'enrollments'],
  ['organisation', 'organization'],
  ['organisations', 'organizations'],
  ['organisational', 'organizational'],
  ['organise', 'organize'],
  ['organised', 'organized'],
  ['organises', 'organizes'],
  ['organising', 'organizing'],
  ['behaviour', 'behavior'],
  ['behaviours', 'behaviors'],
  ['behavioural', 'behavioral'],
  ['colour', 'color'],
  ['colours', 'colors'],
  ['centre', 'center'],
  ['centres', 'centers'],
  ['catalogue', 'catalog'],
  ['catalogues', 'catalogs'],
  ['analyse', 'analyze'],
  ['analysed', 'analyzed'],
  ['analysing', 'analyzing'],
  ['prioritise', 'prioritize'],
  ['prioritised', 'prioritized'],
  ['prioritising', 'prioritizing'],
  ['prioritisation', 'prioritization'],
  ['recognise', 'recognize'],
  ['recognised', 'recognized'],
  ['minimise', 'minimize'],
  ['maximise', 'maximize'],
  ['utilise', 'utilize'],
  ['utilisation', 'utilization'],
  ['standardise', 'standardize'],
  ['standardised', 'standardized'],
  ['favour', 'favor'],
  ['favourable', 'favorable'],
  ['labour', 'labor'],
  ['neighbour', 'neighbor'],
  ['neighbours', 'neighbors'],
  ['neighbourhood', 'neighborhood'],
  ['counselling', 'counseling'],
  ['travelled', 'traveled'],
  ['fulfil', 'fulfill'],
  ['fulfilment', 'fulfillment'],
  ['cheque', 'check'],
  ['paediatric', 'pediatric'],
  ['anaemia', 'anemia'],
  ['diarrhoea', 'diarrhea'],
];

/** The UK → US map enforced. */
export const UK_TO_US: ReadonlyMap<string, string> = new Map(PAIRS);

const WORD_RE = new RegExp(`\\b(${[...UK_TO_US.keys()].join('|')})\\b`, 'gi');

export interface UkSpellingFinding {
  /** The word exactly as written. */
  word: string;
  /** Suggested US spelling, matching the original's leading case. */
  suggestion: string;
  /** 1-based line number. */
  line: number;
  /** True when the word starts upper-case (may be a proper name — judge it). */
  capitalized: boolean;
}

function matchCase(original: string, us: string): string {
  if (original === original.toUpperCase()) return us.toUpperCase();
  if (original[0] === original[0].toUpperCase()) return us[0].toUpperCase() + us.slice(1);
  return us;
}

/** The identifier-shaped token around [start, end) in `line`, if any. */
function enclosingToken(line: string, start: number, end: number): string {
  let a = start;
  let b = end;
  while (a > 0 && /[A-Za-z0-9_./:-]/.test(line[a - 1])) a--;
  while (b < line.length && /[A-Za-z0-9_./:-]/.test(line[b])) b++;
  // Trailing sentence punctuation is not part of the token.
  return line.slice(a, b).replace(/[.:]+$/, '');
}

function isIdentifierToken(token: string): boolean {
  if (/[_/]/.test(token)) return true;
  if (/\.[A-Za-z0-9]/.test(token)) return true; // file.ext, a.b.c
  if (token === token.toLowerCase() && (token.match(/-/g) ?? []).length >= 2) return true;
  return false;
}

/** Ranges of backtick code spans in a line (inline only; fenced blocks handled by the caller). */
function codeSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /`[^`]*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

/**
 * Every UK spelling in `text` that is prose (not an identifier, code span or
 * fenced code block). Order: by line, then position.
 */
export function findUkSpellings(text: string): UkSpellingFinding[] {
  const findings: UkSpellingFinding[] = [];
  let inFence = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const spans = codeSpans(line);
    WORD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD_RE.exec(line)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (spans.some(([a, b]) => start >= a && end <= b)) continue;
      if (isIdentifierToken(enclosingToken(line, start, end))) continue;
      const us = UK_TO_US.get(m[0].toLowerCase())!;
      findings.push({
        word: m[0],
        suggestion: matchCase(m[0], us),
        line: i + 1,
        capitalized: m[0][0] !== m[0][0].toLowerCase(),
      });
    }
  });
  return findings;
}

/** "programme→program x12 (lines 3, 9, …)" grouped per word, for a QA detail line. */
export function describeUkSpellings(findings: UkSpellingFinding[], maxLines = 5): string {
  const groups = new Map<string, UkSpellingFinding[]>();
  for (const f of findings) {
    const k = `${f.word}→${f.suggestion}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  return [...groups.entries()]
    .map(([k, fs]) => {
      const lines = fs.slice(0, maxLines).map((f) => f.line).join(', ');
      return `${k} x${fs.length} (line${fs.length > 1 ? 's' : ''} ${lines}${fs.length > maxLines ? ', …' : ''})`;
    })
    .join('; ');
}
