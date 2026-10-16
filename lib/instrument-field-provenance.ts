/**
 * Do the field identifiers a PDD lists beside a partner instrument's fields
 * actually exist in that instrument?
 *
 * Why this exists (dimagi-internal/ace#2197). On `spark-facilitator/20260907-1120`
 * the PDD's § 5.3 screen 8 listed three fields together:
 *
 *     | 8 | `male_leader_attendence`, `female_leader_attendence`, `partner_staff_attendance` | required |
 *
 * The first two are verbatim from Spark's shipped app (v1392, `forms-4.xml`) —
 * typo and all — and the third exists nowhere in it: 0 hits across all 19 form
 * XMLs. Co-listed with two genuinely reused names, it read as equally
 * authoritative, and flowed into the Deliver build, the Work Order and the
 * training materials as though it were the partner's own field.
 *
 * `lib/instrument-constants.ts` covers a `[FIXED]` instrument's scoring
 * CONSTANTS; nothing covered field IDENTIFIERS. This module classifies every
 * identifier a PDD field spec names against the instrument's XForm binds:
 *
 *  - `reused`    — the identifier is a bind (or option value) in the instrument;
 *  - `net-new`   — absent, and the PDD does not present it as reused;
 *  - `claimed-reused-but-absent` — absent, but presented as reused: listed on a
 *    line beside an identifier that IS reused, or on a line that says
 *    "reused" / "verbatim", and not declared net-new anywhere.
 *
 * Only the third is a finding. Its fix is never to guess: either the PDD names
 * the instrument's real field, or it declares the identifier NET-NEW in its
 * reused-vs-net-new split so the provenance is explicit.
 *
 * Pure — the caller reads the PDD and the instrument XForm(s).
 */

import { DOMParser } from '@xmldom/xmldom';

export type FieldProvenance = 'reused' | 'net-new' | 'claimed-reused-but-absent';

export interface FieldProvenanceRow {
  identifier: string;
  provenance: FieldProvenance;
  /** The PDD line the identifier was read from, trimmed. */
  line: string;
  /** Why an absent identifier counts as CLAIMED reused. */
  claimedBy?: 'co-listed-with-reused' | 'line-says-reused';
}

export interface FieldProvenanceFinding {
  identifier: string;
  line: string;
  message: string;
}

export interface FieldProvenanceReport {
  ok: boolean;
  rows: FieldProvenanceRow[];
  findings: FieldProvenanceFinding[];
}

/** Every bind leaf name and every option `<value>` in the instrument's forms. */
export function instrumentVocabulary(forms: readonly string[]): Set<string> {
  const vocab = new Set<string>();
  for (const xml of forms) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
    for (const b of Array.from(doc.getElementsByTagName('bind'))) {
      const leaf = (b.getAttribute('nodeset') ?? '').split('/').pop();
      if (leaf) vocab.add(leaf);
    }
    for (const item of Array.from(doc.getElementsByTagName('item'))) {
      for (const v of Array.from(item.getElementsByTagName('value'))) {
        const t = (v.textContent ?? '').trim();
        if (t) vocab.add(t);
      }
    }
  }
  return vocab;
}

/**
 * Backticked tokens shaped like a field identifier. An underscore is required
 * so bare option codes (`yes`, `no`, `1`) are not read as field names.
 */
function identifiersIn(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/`([^`\n]+)`/g)) {
    const t = m[1].trim();
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(t) && t.includes('_') && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Identifiers a PDD explicitly declares NET-NEW: backticked identifiers on any
 * line (typically a row of the § "Reused vs net-new" split table) that says
 * `NET-NEW` / `net-new`.
 */
export function declaredNetNewIdentifiers(pddMarkdown: string): Set<string> {
  const out = new Set<string>();
  for (const line of pddMarkdown.split(/\r?\n/)) {
    if (!/\bnet-new\b/i.test(line)) continue;
    for (const id of identifiersIn(line)) out.add(id);
  }
  return out;
}

/**
 * The identifiers a line LISTS as fields. On a table row that is the first
 * cell carrying any identifier — later cells are relevance and constraint
 * expressions that REFERENCE fields (`pilot_fcap_step ≥ 5` beside the savings
 * block), and reading those as claims co-listed with the row's fields would
 * flag every cross-reference.
 */
function listedIdentifiers(line: string): string[] {
  if (!line.trim().startsWith('|')) return identifiersIn(line);
  for (const cell of line.trim().replace(/^\|/, '').split('|')) {
    const ids = identifiersIn(cell);
    if (ids.length) return ids;
  }
  return [];
}

const SAYS_REUSED = /\b(reused|verbatim)\b/i;

/**
 * Classify every identifier the PDD field spec names against the partner
 * instrument. See the module header for the three classes.
 */
export function checkInstrumentFieldProvenance(input: {
  /** The PDD's field-spec text — e.g. the screen-by-screen table — one row per line. */
  fieldSpec: string;
  /** The partner instrument's form XML(s), as shipped (from the manifest-named file in `inputs/`). */
  instrumentForms: readonly string[];
  /** Identifiers the PDD declares net-new (see `declaredNetNewIdentifiers`). */
  declaredNetNew?: ReadonlySet<string>;
}): FieldProvenanceReport {
  const vocab = instrumentVocabulary(input.instrumentForms);
  const netNew = input.declaredNetNew ?? new Set<string>();
  const rows: FieldProvenanceRow[] = [];
  const findings: FieldProvenanceFinding[] = [];
  const seen = new Set<string>();

  for (const raw of input.fieldSpec.split(/\r?\n/)) {
    const ids = listedIdentifiers(raw);
    if (ids.length === 0) continue;
    const line = raw.trim();
    const lineHasReused = ids.some((id) => vocab.has(id));
    const lineSaysReused = SAYS_REUSED.test(line) && !/\bnet-new\b/i.test(line);

    for (const identifier of ids) {
      if (seen.has(identifier)) continue;
      seen.add(identifier);
      if (vocab.has(identifier)) {
        rows.push({ identifier, provenance: 'reused', line });
        continue;
      }
      const claimedBy = netNew.has(identifier)
        ? undefined
        : lineHasReused
          ? ('co-listed-with-reused' as const)
          : lineSaysReused
            ? ('line-says-reused' as const)
            : undefined;
      if (!claimedBy) {
        rows.push({ identifier, provenance: 'net-new', line });
        continue;
      }
      rows.push({ identifier, provenance: 'claimed-reused-but-absent', line, claimedBy });
      findings.push({
        identifier,
        line,
        message:
          claimedBy === 'co-listed-with-reused'
            ? `\`${identifier}\` is listed beside fields reused from the partner instrument but does not exist in it. Name the instrument's real field, or declare \`${identifier}\` NET-NEW in the PDD's reused-vs-net-new split.`
            : `\`${identifier}\` is on a line that says it is reused, but does not exist in the partner instrument. Name the instrument's real field, or declare it NET-NEW.`,
      });
    }
  }

  return { ok: findings.length === 0, rows, findings };
}
