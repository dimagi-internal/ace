/**
 * Does a select draw its options from the PARTNER's register, or from a list
 * the architect made up?
 *
 * Why this exists (dimagi-internal/ace#1621). `fixed_instrument_fidelity`
 * (ace#1527) diffs a `[FIXED]` instrument's CONSTANTS against a source file;
 * `entity_state_fidelity` (ace#1564) diffs the entity's STATE vocabulary
 * against a taxonomy the PDD declares inline. Neither covers the third shape:
 * a select whose OPTIONS come from a partner register that exists as a FILE in
 * the run's frozen `inputs/`.
 *
 * On `spark-facilitator/20260820-0817` the PDD required the meeting-activity
 * options to be drawn from Spark's `malawi_activities` register — 78 activities
 * across 24 FCAP steps — and filtered by the step the facilitator selected.
 * Spark's own published register was in the run's `inputs/` the whole time,
 * alongside their production app CCZ carrying the register's real value codes
 * as fixture XML. The Deliver app shipped **11 ACE-authored placeholders**
 * (`attendance_register`, `facilitated_discussion`, `savings_collection`, …),
 * identical on all 24 steps, and `get_lookup_tables` returned `[]`.
 *
 * Two failures, and the second is the one that let it through:
 *
 *  1. The options were invented — `no-inferred-backstory` on a real partner's
 *     own published process, reaching real field workers and, via the training
 *     deck, the partner.
 *  2. It was recorded as a RESIDUAL and the build proceeded. #1564's doctrine
 *     is the opposite: "The build was supposed to HALT here; a build that
 *     proceeded shipped an invented vocabulary by construction." A residual
 *     defers to a human who may not read it.
 *
 * Like its two siblings the failure has no downstream symptom: the app is
 * complete, internally consistent with its own invention, and passes every
 * structural gate. Only a diff against the declared register can see it.
 *
 * ## What this module deliberately does NOT do
 *
 * It ships **no canonical register** — no default activity list, no fallback
 * vocabulary, and no normalisation of a partner's codes toward ACE's.
 * Hard-coding one would be the mirror image of the reported defect and worse,
 * because it would be systematic. The only authority is the register the PDD
 * names; when the PDD names none, `parseRegisterDeclaration` returns
 * `declared: false` and the caller HALTS with a Phase-1 gap rather than
 * filling it.
 *
 * It also does **not** decide that an unverifiable register is fine. If the
 * declared source file is absent from the run's manifest the result is a
 * blocking finding, never a pass — "I could not check" and "it is correct" are
 * different answers (see `lib/deployment/lookupResourcePlan.ts` upstream for
 * the same rule: a read failure is not permission).
 */

/** One row of the partner's register, as the app must ship it. */
export interface RegisterRow {
  /** The option VALUE — what the app stores. The partner's own code. */
  value: string;
  /** The partner's own label for that option, verbatim. */
  label: string;
  /**
   * The filter key this row belongs to (e.g. the FCAP step). Null when the
   * register is flat — a legitimate shape; not every register is partitioned.
   */
  filterKey: string | null;
}

export interface RegisterDeclaration {
  /**
   * False when the PDD declares no register for this field — an unfilled
   * template placeholder, an empty cell, or an explicit `n/a`. This is the
   * HALT signal: absence is a Phase-1 gap to surface, never a licence to
   * invent an option list.
   */
  declared: boolean;
  /** The lookup table tag the register must land under (e.g. `malawi_activities`). */
  tag: string | null;
  /**
   * The source document the PDD names as the authority. The build must READ
   * this out of the run's frozen `inputs/` — never enumerate from a summary
   * table in the PDD, which is how #1527 shipped 9 wrong point values.
   */
  source: string | null;
  /**
   * The field whose options the register supplies, as the PDD names it.
   */
  field: string | null;
  /**
   * The column the options are filtered by, when the register is partitioned.
   * Null for a flat register.
   */
  filterBy: string | null;
  /** Every way the declaration itself is malformed. Non-empty => do not build. */
  problems: string[];
}

const ABSENT = new Set(['', 'n/a', 'na', 'none', 'tbd', 'unknown', '-', '—']);

/** Template placeholders read as `[...]`; an unfilled row is an absent row. */
function isPlaceholder(raw: string): boolean {
  return /^\[.*\]$/.test(raw.trim());
}

function normaliseLabel(label: string): string {
  return label
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.;,]+$/, '')
    .toLowerCase();
}

/**
 * Parse the PDD's declared option-register handoff.
 *
 * Grammar (one line, so it fits the § Program Parameters `| key | value |`
 * table — prose is exactly where #1564's taxonomy got lost):
 *
 *   `<field> from <tag> [source: <file>] [filtered by <column>]`
 *
 * e.g. `meeting_activity from malawi_activities [source: FCAP Structure,
 * Phases, and Activities.pdf] [filtered by step]`
 *
 * Everything after `<field> from <tag>` is optional, because a flat register
 * with no named source is still a declaration — it just constrains less.
 */
export function parseRegisterDeclaration(
  raw: string | null | undefined,
): RegisterDeclaration {
  const empty: RegisterDeclaration = {
    declared: false,
    tag: null,
    source: null,
    field: null,
    filterBy: null,
    problems: [],
  };

  const text = (raw ?? '').trim();
  if (!text || ABSENT.has(text.toLowerCase()) || isPlaceholder(text)) return empty;

  const problems: string[] = [];

  const source = text.match(/\[\s*source\s*:\s*([^\]]+?)\s*\]/i)?.[1]?.trim() ?? null;
  const filterBy = text.match(/\[\s*filtered\s+by\s*:?\s*([^\]]+?)\s*\]/i)?.[1]?.trim() ?? null;

  // Strip the bracketed clauses before reading `<field> from <tag>`, so a file
  // name containing " from " cannot be mistaken for the separator.
  const head = text.replace(/\[[^\]]*\]/g, ' ').trim();
  const m = head.match(/^(.+?)\s+from\s+(.+?)$/i);
  if (!m) {
    return {
      ...empty,
      declared: true,
      source,
      filterBy,
      problems: [`unparseable register declaration "${text}" — expected "<field> from <tag>"`],
    };
  }

  const field = m[1].trim();
  const tag = m[2].trim();

  // Nova's lookup tag grammar, from the lookup_tables CHECK constraint:
  // ^[A-Za-z_][A-Za-z0-9_]*$, 1-32 chars, must not start with `xml`.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tag)) {
    problems.push(`register tag "${tag}" is not a legal lookup tag (^[A-Za-z_][A-Za-z0-9_]*$)`);
  } else if (tag.length > 32) {
    problems.push(`register tag "${tag}" exceeds the 32-character lookup-tag limit`);
  } else if (/^xml/i.test(tag)) {
    problems.push(`register tag "${tag}" may not start with "xml"`);
  }
  if (!field) problems.push('register declaration names no field');

  return { declared: true, tag, source, field, filterBy, problems };
}

/**
 * How the built field actually sources its options.
 *
 * `inline` is the defect: a literal option list on a field the PDD said draws
 * from a register. That is what shipped on spark-facilitator, and it is
 * indistinguishable from a correct build by every structural gate.
 */
export type BuiltOptionSource =
  | { kind: 'lookup'; tag: string; filteredBy: string | null }
  | { kind: 'inline'; values: string[] }
  | { kind: 'absent' };

export interface RegisterFinding {
  /** Machine-readable class, for the eval's verdict routing. */
  code:
    | 'undeclared-register'
    | 'malformed-declaration'
    | 'source-unavailable'
    | 'unbound-register'
    | 'unfiltered-register'
    | 'wrong-table'
    | 'invented-option'
    | 'missing-option'
    | 'relabelled-option';
  message: string;
}

export interface RegisterDiff {
  /** True iff `findings` is empty. */
  ok: boolean;
  findings: RegisterFinding[];
}

/**
 * Diff how a built field sources its options against what the PDD declared and
 * what the partner's register actually contains.
 *
 * Pure comparison — no judgement and no tolerance band: these are the
 * partner's own codes and words.
 *
 * `registerRows` is what was extracted FROM THE SOURCE FILE. Pass `null` when
 * the source could not be read; that yields `source-unavailable`, which is a
 * blocking finding rather than a pass, because an unverifiable register and a
 * correct one are not the same answer.
 */
export function diffOptionRegister(input: {
  declaration: RegisterDeclaration;
  built: BuiltOptionSource;
  registerRows: RegisterRow[] | null;
}): RegisterDiff {
  const { declaration, built, registerRows } = input;
  const findings: RegisterFinding[] = [];
  const add = (code: RegisterFinding['code'], message: string) =>
    findings.push({ code, message });

  if (!declaration.declared) {
    add(
      'undeclared-register',
      'the PDD declares no option register for this field — Phase-1 gap; the build must HALT rather than invent an option list',
    );
    return { ok: false, findings };
  }

  for (const p of declaration.problems) add('malformed-declaration', p);

  // How the build sources its options — checked before row content, because an
  // inline list makes row comparison meaningless.
  if (built.kind === 'absent') {
    add('unbound-register', `field "${declaration.field}" has no option source at all`);
  } else if (built.kind === 'inline') {
    add(
      'unbound-register',
      `field "${declaration.field}" ships ${built.values.length} INLINE options ` +
        `(${built.values.slice(0, 5).join(', ')}${built.values.length > 5 ? ', …' : ''}) ` +
        `where the PDD declares they come from register "${declaration.tag}" — ` +
        'these are the build\'s own invention, not the partner\'s data',
    );
  } else {
    if (declaration.tag && built.tag !== declaration.tag) {
      add(
        'wrong-table',
        `field "${declaration.field}" is bound to lookup "${built.tag}", declared "${declaration.tag}"`,
      );
    }
    if (declaration.filterBy && !built.filteredBy) {
      add(
        'unfiltered-register',
        `register "${declaration.tag}" is declared filtered by "${declaration.filterBy}" ` +
          'but the built option source carries no filter — every partition would show every option',
      );
    } else if (
      declaration.filterBy &&
      built.filteredBy &&
      built.filteredBy !== declaration.filterBy
    ) {
      add(
        'unfiltered-register',
        `register filter mismatch: declared "${declaration.filterBy}", built "${built.filteredBy}"`,
      );
    }
  }

  if (registerRows === null) {
    add(
      'source-unavailable',
      `the declared register source ${declaration.source ? `"${declaration.source}" ` : ''}` +
        'could not be read from the run\'s inputs — unverifiable is not the same as correct',
    );
    return { ok: false, findings };
  }

  // Row-level comparison only when the build is actually bound to a lookup;
  // for an inline list the `unbound-register` finding above is the whole story
  // and enumerating 78 "missing option" lines would bury it.
  if (built.kind === 'lookup') {
    const byValue = new Map(registerRows.map((r) => [r.value, r]));
    const dupes = registerRows.length - byValue.size;
    if (dupes > 0) {
      add(
        'malformed-declaration',
        `register source carries ${dupes} duplicate value code(s) — the partner's register must key uniquely`,
      );
    }
  }

  return { ok: findings.length === 0, findings };
}

/**
 * Diff the option rows the app SHIPPED against the partner's register.
 *
 * Separate from `diffOptionRegister` because it needs the bound table's actual
 * rows, which the caller reads back from Nova after binding — a different
 * round-trip from reading the blueprint's option source.
 */
export function diffRegisterRows(input: {
  registerRows: RegisterRow[];
  builtRows: RegisterRow[];
}): RegisterDiff {
  const findings: RegisterFinding[] = [];
  const declaredBy = new Map(input.registerRows.map((r) => [r.value, r]));
  const builtBy = new Map(input.builtRows.map((r) => [r.value, r]));

  for (const r of input.builtRows) {
    if (!declaredBy.has(r.value)) {
      findings.push({
        code: 'invented-option',
        message: `invented option value "${r.value}" ("${r.label}") — not in the partner's register`,
      });
    }
  }
  for (const r of input.registerRows) {
    if (!builtBy.has(r.value)) {
      findings.push({
        code: 'missing-option',
        message: `register option "${r.value}" ("${r.label}") missing from the build`,
      });
    }
  }
  for (const [value, declared] of declaredBy) {
    const built = builtBy.get(value);
    if (!built) continue;
    if (normaliseLabel(declared.label) !== normaliseLabel(built.label)) {
      findings.push({
        code: 'relabelled-option',
        message: `option "${value}" relabelled: register "${declared.label}", built "${built.label}"`,
      });
    }
    if (declared.filterKey !== null && built.filterKey !== null && declared.filterKey !== built.filterKey) {
      findings.push({
        code: 'relabelled-option',
        message:
          `option "${value}" re-partitioned: register filter "${declared.filterKey}", ` +
          `built "${built.filterKey}"`,
      });
    }
  }

  return { ok: findings.length === 0, findings };
}

/** Human-readable finding lines for the build memo / verdict. */
export function describeRegisterDiff(diff: RegisterDiff): string[] {
  return diff.findings.map((f) => `[${f.code}] ${f.message}`);
}

/**
 * Extract a register from a CommCare fixture XML document — the `<fixture>`
 * body of a partner CCZ.
 *
 * PREFER THIS over a structured prose document. A partner's production CCZ
 * carries the register's REAL value codes, which is what the app stores and
 * what the partner's own M&E joins on; a human-readable structure guide
 * usually carries only labels, so sourcing from it forces the build to mint an
 * identifier scheme the partner has never seen. Same rule as #1527's "trust
 * extraction first".
 *
 * Deliberately tolerant about element naming (partners name their columns
 * whatever they like) and deliberately strict about which child supplies the
 * value: the caller names the columns, because guessing which child is the
 * code is exactly the kind of inference this module exists to prevent.
 */
export function parseFixtureRegister(
  xml: string,
  columns: { value: string; label: string; filterKey?: string },
): RegisterRow[] {
  const rows: RegisterRow[] = [];
  // One `<...>` block per row; the row element name varies by partner, so we
  // cannot anchor on it. Match every element, then keep only those that look
  // like a ROW rather than a wrapper: a row contains the value column exactly
  // once. Without that test the outermost element (`<fixture>`, `<x_list>`)
  // matches first, swallows every row, and yields a single bogus entry.
  const rowRe = /<(\w+)\b[^>]*>([\s\S]*?)<\/\1>/g;
  const childText = (body: string, name: string): string | null => {
    const m = body.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
    return m ? decodeXmlText(m[1]) : null;
  };
  const countTag = (body: string, name: string): number =>
    body.match(new RegExp(`<${name}\\b[^>]*>`, 'gi'))?.length ?? 0;

  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(xml)) !== null) {
    const body = match[2];
    if (countTag(body, columns.value) !== 1) {
      // A wrapper, not a row. `exec` has already advanced lastIndex past the
      // whole element, so a bare `continue` would skip every row INSIDE it and
      // return nothing. Rewind to just after this element's opening `<` so the
      // scan descends into it.
      rowRe.lastIndex = match.index + 1;
      continue;
    }
    const value = childText(body, columns.value);
    const label = childText(body, columns.label);
    if (value === null || label === null) continue;
    rows.push({
      value: value.trim(),
      label: label.trim(),
      filterKey: columns.filterKey ? (childText(body, columns.filterKey)?.trim() ?? null) : null,
    });
  }
  return rows;
}

function decodeXmlText(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Render the register as the CSV Nova's row-import route accepts
 * (`text/csv`, `POST /api/projects/<id>/lookup/tables/<tableId>/import`).
 *
 * This exists because Nova has **no MCP atom that creates a lookup table**, and
 * its import route is browser-session-only (`enableSessionForAPIKeys: false` —
 * "API keys authenticate the MCP route only, never a browser session"). So
 * until that lands upstream, ACE's best terminal behaviour is to extract the
 * register, emit this CSV plus the table spec, and HALT with a two-step
 * operator handoff — never to ship placeholders.
 */
export function renderRegisterCsv(
  rows: RegisterRow[],
  headers: { value: string; label: string; filterKey?: string },
): string {
  const cols = [headers.value, headers.label, ...(headers.filterKey ? [headers.filterKey] : [])];
  const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [cols.join(',')];
  for (const r of rows) {
    const vals = [r.value, r.label, ...(headers.filterKey ? [r.filterKey ?? ''] : [])];
    lines.push(vals.map(cell).join(','));
  }
  return `${lines.join('\n')}\n`;
}
