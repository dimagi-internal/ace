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

/* ------------------------------------------------------------------------ *
 * Proving a lookup bind actually landed (ace#1886)
 *
 * `renderRegisterCsv` used to live here: it rendered the register as CSV for a
 * human to import by hand, because Nova had no create atom, and later because
 * Nova refused to BIND a select to a table it had happily created. Both
 * reasons are gone — the create atom shipped, and the bind was accepted and
 * read back on 2026-09-06 (`voidcraft-labs/commcare-nova#545`, closed
 * COMPLETED 2026-09-02). ACE now performs the whole job, so the CSV is a
 * record of a handoff that no longer happens and the function is deleted.
 *
 * What replaces it is the opposite kind of code: not a way to hand work to a
 * human, but a way to PROVE the work ACE now does autonomously actually
 * happened.
 *
 * ## Why a read-back, and not the write's own response
 *
 * Observed live 2026-09-06 on a throwaway app: `add_fields` accepts a
 * `{kind:'lookup'}` options source and answers
 *
 *   {"message":"Successfully added 1 field …","fields":[{"uuid":"…",
 *    "id":"probe_pick","options":[]}]}
 *
 * — `options: []`, on a field that IS correctly bound. The write response
 * reports the inline options (there are none, by construction) and says
 * nothing about the lookup source. So the two obvious cheap checks are both
 * wrong in opposite directions: trusting "no error" passes a bind that never
 * landed, and reading `options` from the write response fails a bind that did.
 * Only `get_field` shows the truth:
 *
 *   "optionsSource":{"kind":"lookup","tableId":"…","valueColumnId":"…",
 *                    "labelColumnId":"…"}
 *
 * This is the whole reason the function exists. The failure it guards has no
 * downstream symptom — a select with an unbound source renders empty to a
 * field worker and passes every structural gate ACE runs, exactly like the
 * invented-options defect the Step 4f halt was built for (ace#1621/#1564).
 *
 * ## Why the bound table's ROWS are part of the same verification (ace#2143)
 *
 * A bind that lands on a table whose value column REPEATS a code is not a
 * working select. Nova's `upload_app_to_hq` preflight refuses the whole app
 * for it, verbatim:
 *
 *   "This app isn't ready to upload. Fix these first: A lookup-powered choice
 *    list uses activity_id for its saved values, but malawi_activities repeats
 *    the same value in several rows. Make the values unique or choose another
 *    value column."
 *
 * On `spark-facilitator/20260906-2233` that refusal was the FIRST thing in the
 * run that noticed. `malawi_activities` carried `other` on seven rows — one
 * per FCAP step — which is unique inside each filter partition and not unique
 * across the table, and Nova requires the latter. Phase 3 had by then spent a
 * full Nova build, media coverage and two translation layers, and every ACE
 * artifact recorded the register as "BOUND and read-back-verified", because
 * the read-back this function performs looks only at the field's
 * `optionsSource` and never at the table behind it.
 *
 * ACE did own the uniqueness rule — `diffOptionRegister` has carried it since
 * ace#1621 — but only on the PARTNER-REGISTER path, where the PDD names a
 * register file in the run's `inputs/`. `malawi_activities` was authored by
 * the build from the PDD itself, so that path never fired. One of the two ways
 * ACE creates a lookup table was guarded and the other was not, and the
 * unguarded one shipped.
 *
 * So the check moves to where BOTH paths funnel: every bind ACE performs is
 * required to prove itself through `verifyLookupBind`
 * (`pdd-to-deliver-app § Step 4f` step 4, `_app-component-library §
 * structured-capture` rung 1), and `verifyLookupBind` now cannot answer
 * `verified: true` without having seen the bound table's rows. `rows` is a
 * REQUIRED property for exactly that reason — an optional one is a check a
 * caller can skip by forgetting, which is the shape of the defect being fixed.
 * Absent rows, a partial page, and an empty table are all `verified: false`,
 * on this module's standing rule that "I could not check" and "it is correct"
 * are different answers.
 * ------------------------------------------------------------------------ */

/** The lookup source a build ASKED Nova for. */
export interface LookupBindRequest {
  tableId: string;
  valueColumnId: string;
  labelColumnId: string;
}

/** `optionsSource` as `get_field` returns it. Every field optional: the point
 *  is to survive a shape that is missing, partial, or a different kind. */
export interface LookupBindReadBack {
  kind?: string | null;
  tableId?: string | null;
  valueColumnId?: string | null;
  labelColumnId?: string | null;
}

/**
 * One cell of a Project data-table row.
 *
 * Shape observed live 2026-09-17 against Nova
 * `get_lookup_table_rows({app_id, tableId})` on the app from ace#2143
 * (`0f7431d8-cbae-4f03-a87f-14b5a5261544`, table `malawi_activities`):
 * `{"rows":[{"id":"…","cells":[{"columnId":"…","value":"step_1"}, …]}]}`.
 * Every field is optional for the same reason `LookupBindReadBack`'s are —
 * the point is to survive a shape that is missing, partial, or drifted.
 */
export interface LookupTableCell {
  columnId?: string | null;
  value?: string | null;
}

/** One row of a Project data table. */
export interface LookupTableRow {
  cells?: LookupTableCell[] | null;
}

/**
 * `get_lookup_table_rows` as a whole — the rows AND whether the read finished.
 *
 * The atom is PAGED (100 rows/page, a `complete` flag plus a cursor), and a
 * duplicate on an unread page is invisible. A caller that pages through the
 * whole table concatenates the pages and passes `complete: true` itself; a
 * caller that reads one page passes what the atom said. Anything other than
 * `complete: true` is `partial-rows-read-back`, never a pass.
 */
export interface LookupRowsReadBack {
  rows?: LookupTableRow[] | null;
  complete?: boolean | null;
}

/** A value code that appears on more than one row, and how many rows. */
export interface DuplicateLookupValue {
  /** The repeated value. The empty string means the cell was blank or absent. */
  value: string;
  count: number;
}

/**
 * Pure. Which values in `valueColumnId` appear on more than one row.
 *
 * A row carrying no cell for that column reads as the empty string — two such
 * rows ARE a duplicate (they are two options that save the same nothing), and
 * a whole read-back whose cells do not carry `columnId` collapses to one loud
 * blank-value duplicate rather than a silent pass. Deterministic order: first
 * appearance of each repeated value.
 */
export function findDuplicateLookupValues(
  rows: readonly LookupTableRow[],
  valueColumnId: string,
): DuplicateLookupValue[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const cell = (row?.cells ?? []).find((c) => c?.columnId === valueColumnId);
    const value = cell?.value ?? '';
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value, count]) => ({ value, count }));
}

export interface BindVerification {
  /**
   * True only when the read-back proves the requested lookup source is live
   * AND the table behind it can actually back a select. Step 4f halts on
   * anything else; this is the field a build memo records.
   */
  verified: boolean;
  /**
   * True when the FIELD's options source read back as the requested lookup —
   * i.e. the bind itself landed — whatever the table's rows then say.
   *
   * Split out for `scripts/probe-nova-fixtures.ts` (ace#2143): that probe is
   * the upstream-regression tripwire for Nova's BINDING capability, and a
   * table-CONTENT finding must never be reported as "the bind regressed".
   * Nothing in a run should key on this — a run wants `verified`.
   */
  bindLanded: boolean;
  /** Machine-readable class, so a caller can route rather than string-match. */
  code:
    | 'ok'
    | 'no-read-back'
    | 'not-a-lookup-source'
    | 'wrong-table'
    | 'wrong-columns'
    | 'no-rows-read-back'
    | 'partial-rows-read-back'
    | 'empty-table'
    | 'duplicate-values';
  /** Human-readable, quoted into the build memo. */
  message: string;
}

/**
 * Verify a lookup bind against what Nova reads back — never against the write.
 *
 * Pure. `readBack` is `get_field(...).field.optionsSource`; pass `null` when
 * the read-back could not be performed at all, which is NOT a pass ("I could
 * not check" and "it is correct" are different answers — the same rule
 * `diffOptionRegister` applies to an unreadable register source).
 *
 * `rows` is `get_lookup_table_rows({app_id, tableId: requested.tableId})` for
 * the table the field is bound to, and is REQUIRED (ace#2143): a bind onto a
 * table whose value column repeats a code is refused by Nova's
 * `upload_app_to_hq` preflight one skill later, and before ace#2143 nothing on
 * ACE's side looked. Pass `null` when the read could not be performed, which
 * is `verified: false` by the same rule as above.
 */
export function verifyLookupBind(input: {
  requested: LookupBindRequest;
  readBack: LookupBindReadBack | null | undefined;
  rows: LookupRowsReadBack | null | undefined;
}): BindVerification {
  const { requested, readBack, rows } = input;

  if (!readBack) {
    return {
      verified: false,
      bindLanded: false,
      code: 'no-read-back',
      message:
        'no options source was read back for this field — an unverified bind is not a bind; ' +
        'call get_field and pass its field.optionsSource',
    };
  }

  if (readBack.kind !== 'lookup') {
    return {
      verified: false,
      bindLanded: false,
      code: 'not-a-lookup-source',
      message:
        `field reads back with options source kind "${readBack.kind ?? 'absent'}", not "lookup" — ` +
        'the bind did not land, whatever the write response said',
    };
  }

  if (readBack.tableId !== requested.tableId) {
    return {
      verified: false,
      bindLanded: false,
      code: 'wrong-table',
      message:
        `field is bound to lookup table "${readBack.tableId ?? 'absent'}", but the register was ` +
        `created as "${requested.tableId}" — the select draws from the wrong table`,
    };
  }

  if (
    readBack.valueColumnId !== requested.valueColumnId ||
    readBack.labelColumnId !== requested.labelColumnId
  ) {
    return {
      verified: false,
      bindLanded: false,
      code: 'wrong-columns',
      message:
        'field is bound to the right table through the wrong columns ' +
        `(value "${readBack.valueColumnId ?? 'absent'}" vs "${requested.valueColumnId}", ` +
        `label "${readBack.labelColumnId ?? 'absent'}" vs "${requested.labelColumnId}") — ` +
        'workers would see the wrong codes or the wrong words',
    };
  }

  // The bind itself is proven from here down. Everything that follows is about
  // the TABLE it points at — which is a different failure with the same
  // invisibility, so it shares the verdict but not `bindLanded` (ace#2143).
  if (!rows || !Array.isArray(rows.rows)) {
    return {
      verified: false,
      bindLanded: true,
      code: 'no-rows-read-back',
      message:
        `the bind landed, but no rows were read back for lookup table "${requested.tableId}" — ` +
        'a table whose value column repeats a code is refused by Nova\'s upload preflight ' +
        'one skill later; call get_lookup_table_rows({app_id, tableId}) and pass its result',
    };
  }

  if (rows.complete !== true) {
    return {
      verified: false,
      bindLanded: true,
      code: 'partial-rows-read-back',
      message:
        `the rows read back for lookup table "${requested.tableId}" are INCOMPLETE ` +
        `(${rows.rows.length} row(s), complete=${String(rows.complete)}) — the atom pages at ` +
        '100 rows, and a duplicate value on an unread page is invisible; page to the end and ' +
        'pass the concatenated rows with complete: true',
    };
  }

  if (rows.rows.length === 0) {
    return {
      verified: false,
      bindLanded: true,
      code: 'empty-table',
      message:
        `field is bound to lookup table "${requested.tableId}", which has NO rows — ` +
        'the select renders empty on the device while every structural gate passes',
    };
  }

  const dupes = findDuplicateLookupValues(rows.rows, requested.valueColumnId);
  if (dupes.length > 0) {
    const shown = dupes
      .slice(0, 5)
      .map((d) => (d.value === '' ? `"" (blank) ×${d.count}` : `"${d.value}" ×${d.count}`))
      .join(', ');
    return {
      verified: false,
      bindLanded: true,
      code: 'duplicate-values',
      message:
        `field is bound to lookup table "${requested.tableId}" through value column ` +
        `"${requested.valueColumnId}", but that column repeats ${dupes.length} value(s) ` +
        `across ${rows.rows.length} rows (${shown}${dupes.length > 5 ? ', …' : ''}) — ` +
        'Nova\'s upload preflight refuses the whole app for this ("…repeats the same value in ' +
        'several rows. Make the values unique or choose another value column."), and uniqueness ' +
        'WITHIN a filter partition is not enough (ace#2143)',
    };
  }

  return {
    verified: true,
    bindLanded: true,
    code: 'ok',
    message:
      `field is bound to lookup table "${requested.tableId}" on the declared value/label columns, ` +
      `over ${rows.rows.length} rows with unique values in "${requested.valueColumnId}"`,
  };
}

/* --------------------------------------------------------------------------
 * The whole-app sweep (ace#2143)
 *
 * `verifyLookupBind` answers for ONE bind, and `pdd-to-deliver-app § Step 4f`
 * only reaches it for a field that step itself bound — a field the architect
 * already shipped as a correctly-shaped `single_select` never enters 4f's
 * `degraded[]` list, so nothing on ACE's side ever looked at the table behind
 * it.
 *
 * That is how ace#2143 shipped. `malawi_activities` was authored by the
 * architect from the PDD, bound by the architect, and passed every ACE gate;
 * Nova's `upload_app_to_hq` preflight in `app-deploy` was the first thing in
 * the run that noticed, after Phase 3 had spent a full Nova build, media
 * coverage and two translation layers.
 *
 * Nova's preflight sweeps EVERY lookup-powered choice list in the app, so the
 * only ACE-side check that cannot be bypassed is one with the same scope.
 * Collect every field in the built app whose options source reads back
 * `kind: 'lookup'` — whoever created it — and audit them together.
 * ----------------------------------------------------------------------- */

/** One lookup-backed select in the built app, with everything read back for it. */
export interface LookupBindSite {
  /** How to name it in a halt: `<form id>.<field id>` is enough to act on. */
  field: string;
  requested: LookupBindRequest;
  readBack: LookupBindReadBack | null | undefined;
  rows: LookupRowsReadBack | null | undefined;
}

export interface LookupBindAudit {
  /** True iff every site verified. Anything else is a Step 4f HALT. */
  ok: boolean;
  sites: Array<BindVerification & { field: string }>;
  /** Just the failures, in input order — what the halt message quotes. */
  failures: Array<BindVerification & { field: string }>;
}

/**
 * Pure. Verify EVERY lookup-backed select in the built app at once.
 *
 * An EMPTY site list is `ok: true` — an app with no lookup-backed select has
 * nothing to audit. That is deliberately not the same as "the caller did not
 * look": the caller's obligation to enumerate is stated in
 * `pdd-to-deliver-app § Step 4f` step 8, and a site whose read-back or rows
 * are missing fails HERE rather than being silently dropped.
 */
export function auditLookupBinds(sites: readonly LookupBindSite[]): LookupBindAudit {
  const results = sites.map((s) => ({
    field: s.field,
    ...verifyLookupBind({ requested: s.requested, readBack: s.readBack, rows: s.rows }),
  }));
  const failures = results.filter((r) => !r.verified);
  return { ok: failures.length === 0, sites: results, failures };
}

/** Human-readable halt lines for the build memo / a Step 4f halt. */
export function describeLookupBindAudit(audit: LookupBindAudit): string[] {
  return audit.failures.map((f) => `[${f.code}] ${f.field}: ${f.message}`);
}
