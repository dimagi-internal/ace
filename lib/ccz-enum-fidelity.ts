/**
 * ace#1688 — the case-list tile and the form that writes the value shipped two
 * different taxonomies for the same case property, and no gate compared them.
 *
 * `lib/choice-label-integrity.ts § checkCaseListEnumDrift` is the pure diff:
 * hand it two `value -> label` maps and it tells you where they disagree. This
 * module is the half that makes it RUNNABLE — it pulls both maps out of a
 * released CCZ, which is the only artifact that carries the two surfaces side
 * by side. Without it the diff is a library nothing calls, which is how the
 * defect survived its own fix.
 *
 * ## What a case-list id-mapping column looks like in a CCZ
 *
 * Recorded, verbatim, from released Deliver CCZ `ccz-20260729-0002-deliver`
 * (`suite.xml`, module 0's short detail) — the fixture in
 * `test/fixtures/ccz-enum-fidelity/bednet-suite.xml` is this text unmodified:
 *
 * ```xml
 * <field>
 *   <template>
 *     <text>
 *       <xpath function="replace(join(' ', if(selected(slept_under_bednet, 'yes'), $kyes, ''), if(selected(slept_under_bednet, 'no'), $kno, '')), '\s+', ' ')">
 *         <variable name="kno">
 *           <locale id="m0.case_short.case_slept_under_bednet_2.enum.kno"/>
 *         </variable>
 *         <variable name="kyes">
 *           <locale id="m0.case_short.case_slept_under_bednet_2.enum.kyes"/>
 *         </variable>
 *       </xpath>
 *     </text>
 *   </template>
 * </field>
 * ```
 *
 * and `en/app_strings.txt` resolves the locale ids:
 *
 * ```
 * m0.case_short.case_slept_under_bednet_2.enum.kno=No
 * m0.case_short.case_slept_under_bednet_2.enum.kyes=Yes
 * ```
 *
 * So the STORED VALUE comes from the `selected(prop, 'value')` branch — the
 * xpath itself, which is authoritative — and the LABEL from the locale that
 * branch's `$var` resolves to. The property name is read off the same branch
 * rather than inferred from the locale id, because a locale id like
 * `case_phase_2` cannot be split back into name and index without guessing.
 *
 * ## And the form side
 *
 * ```xml
 * <select1 ref="/data/slept_under_bednet">
 *   <item>
 *     <label ref="jr:itext('slept_under_bednet-opt0-label')"/>
 *     <value>yes</value>
 *   </item>
 * </select1>
 * ```
 *
 * with the label in the form's own `<itext>`. The non-markdown `<value>` is
 * the authored text; the `form="markdown"` twin is what the device renders,
 * and that difference is ace#1689's job, not this one's. This check compares
 * AUTHORED to AUTHORED — the taxonomies must agree before rendering is even a
 * question.
 *
 * ## Pairing (ace#1808 — the question id is NOT the case property)
 *
 * A column renders a CASE PROPERTY; a select is named by its QUESTION ID. The
 * two are independent names, and a Nova app where they coincide is the
 * coincidence, not the rule. So pairing reads the form's own `<case>`
 * transaction binds first — `extractCaseWriteMap` — and falls back to the
 * question-id tail only for a select with no bare-path case write.
 *
 * The original code paired on the question-id tail alone. On released Deliver
 * build `b08533bdf26a48a295a362ff204fb88d` (spark-facilitator/20260828-0703)
 * the enrolment form's question is `starting_fcap_step`, it writes
 * `village.pilot_fcap_step`, and both case-list columns render
 * `pilot_fcap_step` — so nothing paired, `columnsCompared` stayed 0, and this
 * `[BLOCKER]`-severity gate reported `unable` on the exact app family it was
 * written for. `unable` is correctly not a pass, so nothing shipped green; the
 * failure was that the check silently did not run, reading as "not applicable
 * here" rather than "I could not do my job."
 *
 * A column with no such select is still NOT a finding — plenty of id-mapping
 * columns render properties no form select writes — it is reported as unpaired
 * so the report says what was and was not compared.
 *
 * ## Pairing, part two (ace#2188 — the writer is often not a question at all)
 *
 * #1808 resolves case property -> writing QUESTION. That resolution runs on a
 * whole class of ACE Deliver apps and still finds nothing, because the thing at
 * the end of the chain is not a question: it is a hidden `calculate`. The
 * `entity-state-taxonomy` component (`skills/_app-component-library.md`) is
 * built exactly this way — a state the worker never picks, fully determined by
 * other answers — so the shape is standard ACE output, not an exotic app.
 *
 * Recorded verbatim from released Deliver build
 * `1fcc4b819ff74ccf96a7972b550e887f` (bednet-check-2-visit/20260907-1126):
 *
 * ```xml
 * <!-- modules-0/forms-0.xml, Register Household -->
 * <bind nodeset="/data/household_state" type="xsd:string"
 *       calculate="if(/data/consent_intro/consent_given = 'yes', 'registered', 'declined')"/>
 * <bind nodeset="/data/case/update/household_state" calculate="/data/household_state" .../>
 * <!-- modules-1/forms-0.xml, Follow-Up Visit -->
 * <bind nodeset="/data/household_state" type="xsd:string" calculate="'checked'"/>
 * ```
 *
 * So the case write points at a hidden node whose own bind carries the
 * taxonomy. `extractCalculateWrittenValues` follows that chain and recovers the
 * value set from the calculate's string literals, and the comparison is against
 * the UNION across every form: `declined` is only ever written by Register and
 * `checked` only by Follow-Up, so a per-form compare would false-fail both.
 *
 * **What a calculate can and cannot settle.** A select supplies
 * `value -> label`, so a column paired to one is diffed on both. A calculate
 * supplies VALUES ONLY — nothing in the CCZ labels them a second time — so a
 * calculate-paired column is checked for value-set membership and nothing
 * else. A wrong LABEL on a calculate-written enum is invisible here BY
 * CONSTRUCTION, and that is not this gate's hole to fill: the authority for a
 * state taxonomy's words is the PDD's `program_parameters.entity_state_taxonomy`,
 * gated at build time by `pdd-to-deliver-app § Step 4l` and
 * `pdd-to-deliver-app-eval § entity_state_fidelity` (`lib/entity-state-taxonomy.ts`).
 *
 * And where the literals genuinely cannot be enumerated — a `concat()`, a
 * lookup, an expression returning another node's value — the answer stays
 * `unable` with a reason naming the expression. Widening the extractor to
 * invent a value set would be worse than the hole it closes: a fabricated
 * comparison reads as a pass.
 */
import {
  type EnumDriftFinding,
  checkCaseListEnumDrift,
} from './choice-label-integrity.js';
import { type CheckOutcome, checked, unable } from './check-outcome.js';

/** One id-mapping column, as it exists in a built CCZ. */
export interface CaseListEnumColumn {
  /** The `<detail>` it lives in, e.g. `m0_case_short`. */
  detailId: string;
  /** The case property it renders, read off the `selected(...)` branch. */
  property: string;
  /** Stored value -> the label the tile shows for it. */
  enums: Record<string, string>;
}

/** One form choice list, as it exists in a built CCZ's form XML. */
export interface FormChoiceList {
  /** The form the select lives in, for the finding message. */
  formPath: string;
  /** Last segment of the select's `ref` — the QUESTION id, not the case property. */
  property: string;
  /**
   * Case properties this select's answer is actually written to, read off the
   * form's own `<case>` transaction binds (ace#1808). Authoritative where the
   * question id and the case property differ, which is the normal case — a
   * Nova question id matching its case property exactly is the coincidence,
   * not the rule.
   */
  caseProperties: string[];
  /** Stored value -> the authored (non-markdown) label. */
  choices: Record<string, string>;
}

/** One case property whose value set a hidden `calculate` determines (ace#2188). */
export interface CalculateWriter {
  /** The form the calculate lives in. */
  formPath: string;
  /** Case property the `<update>` bind writes. */
  property: string;
  /** The calculate expression the values were recovered from, verbatim. */
  expression: string;
  /** Literal values that expression can store, sorted, empties dropped. */
  values: string[];
}

/**
 * A calculate-written case property whose value set could NOT be enumerated.
 * Carried so the `unable` reason can say WHICH shape defeated it — "the writer
 * is a calculate I could not parse" and "nothing writes it at all" need
 * different follow-ups, and a fabricated value set would be worse than either.
 */
export interface OpaqueCalculateWriter {
  formPath: string;
  property: string;
  expression: string;
  /** What about the expression defeated enumeration. */
  reason: string;
}

export interface CczEnumFidelityFinding extends EnumDriftFinding {
  /** Case property the disagreement is about. */
  property: string;
  /** Every detail that renders this property through the drifted enum. */
  detailIds: string[];
  /**
   * The form whose choice list is the authority for it. For a calculate writer
   * this is every form that writes the property, comma-joined — the value set
   * is their union.
   */
  formPath: string;
  /**
   * What the column was paired to. `calculate` compares VALUES ONLY: a
   * calculate carries no labels, so `formLabel` is always null and
   * `label-mismatch` is unreachable on that branch.
   */
  writer: 'select' | 'calculate';
}

export interface CczEnumFidelityExtras {
  /** Columns actually diffed against a form choice list. */
  columnsCompared: number;
  /** Stored values compared across all those columns. */
  valuesCompared: number;
  /** `detailId.property` for id-mapping columns nothing in the CCZ writes. */
  unpaired: string[];
  /** `property` -> values the form can store that the tile has no label for. */
  unlabelledInCaseList: Record<string, string[]>;
  /**
   * `property` -> the union of literals recovered from calculate writers, for
   * columns paired that way. Reported so a memo can show the value set that was
   * compared rather than only that a comparison happened.
   */
  calculateWritten: Record<string, string[]>;
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function unescapeXml(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m]);
}

/** `key=value` lines. The first `=` splits; labels may contain more. */
export function parseAppStrings(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/**
 * Pull every id-mapping column out of `suite.xml`, resolving labels through
 * `app_strings.txt`.
 *
 * A field with no `selected(prop, 'value')` branch is not an id-mapping column
 * (a plain `case_name` field, a date, a calculated cell) and is skipped.
 */
export function extractCaseListEnums(
  suiteXml: string,
  appStrings: Record<string, string>,
): CaseListEnumColumn[] {
  const columns: CaseListEnumColumn[] = [];
  for (const detail of suiteXml.matchAll(
    /<detail\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/detail>/g,
  )) {
    const detailId = detail[1];
    for (const field of detail[2].matchAll(/<field\b[^>]*>([\s\S]*?)<\/field>/g)) {
      const body = field[1];
      const xpath = /<xpath\s+function="([^"]*)"/.exec(body);
      if (!xpath) continue;
      const fn = unescapeXml(xpath[1]);

      // value -> variable name, straight off the branch that renders it.
      const branches = [
        ...fn.matchAll(/selected\(\s*([^,\s()]+)\s*,\s*'([^']*)'\s*\)\s*,\s*\$([A-Za-z_][\w]*)/g),
      ];
      if (branches.length === 0) continue;

      // variable name -> locale id.
      const locales: Record<string, string> = {};
      for (const v of body.matchAll(
        /<variable\s+name="([^"]+)"\s*>\s*<locale\s+id="([^"]+)"\s*\/>\s*<\/variable>/g,
      )) {
        locales[v[1]] = v[2];
      }

      const property = branches[0][1];
      const enums: Record<string, string> = {};
      for (const [, prop, value, varName] of branches) {
        if (prop !== property) continue;
        const localeId = locales[varName];
        if (localeId === undefined) continue;
        const label = appStrings[localeId];
        if (label === undefined) continue;
        enums[value] = label;
      }
      if (Object.keys(enums).length > 0) columns.push({ detailId, property, enums });
    }
  }
  return columns;
}

/** Resolve a form's `<itext>` ids to their authored (non-markdown) text. */
function parseItext(formXml: string): Record<string, string> {
  const translations = [
    ...formXml.matchAll(/<translation\b([^>]*)>([\s\S]*?)<\/translation>/g),
  ];
  if (translations.length === 0) return {};
  const chosen =
    translations.find((t) => /\bdefault\s*=/.test(t[1])) ??
    translations.find((t) => /\blang\s*=\s*"en"/.test(t[1])) ??
    translations[0];
  const out: Record<string, string> = {};
  for (const text of chosen[2].matchAll(/<text\s+id="([^"]+)"\s*>([\s\S]*?)<\/text>/g)) {
    // The bare <value> is the authored text; the form="markdown" twin is what
    // the device renders (ace#1689) and is deliberately not what we compare.
    const plain = /<value\s*>([\s\S]*?)<\/value>/.exec(text[2]);
    if (plain) out[text[1]] = unescapeXml(plain[1].trim());
  }
  return out;
}

/**
 * `question node path -> case properties that node's answer is written to`,
 * read off the form's own `<case>` transaction binds (ace#1808).
 *
 * Nova emits the case write as a bind on the case block, whose `calculate` is
 * the question node. Recorded verbatim from released Deliver build
 * `b08533bdf26a48a295a362ff204fb88d` (spark-facilitator/20260828-0703),
 * `modules-0/forms-0.xml:485`:
 *
 * ```xml
 * <bind nodeset="/data/case/update/pilot_fcap_step"
 *       calculate="/data/starting_step/starting_fcap_step"
 *       relevant="count(/data/starting_step/starting_fcap_step) &gt; 0"/>
 * ```
 *
 * So the select whose `ref` is `/data/starting_step/starting_fcap_step` writes
 * the case property `pilot_fcap_step`, and the case-list column renders
 * `pilot_fcap_step`. Pairing on the question id alone found nothing.
 *
 * Only a **bare node path** calculate is mapped. An expression (`if(...)`,
 * `concat(...)`) mentions several nodes and mapping it would be a guess; the
 * name fallback still applies there. Every one of the 21 case-write binds in
 * the two released forms of the repro app is a bare path.
 */
export function extractCaseWriteMap(formXml: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const bind of formXml.matchAll(/<bind\b([^>]*?)\/?>/g)) {
    const attrs = bind[1];
    const nodeset = /\bnodeset="([^"]*)"/.exec(attrs)?.[1];
    const calculate = /\bcalculate="([^"]*)"/.exec(attrs)?.[1];
    if (!nodeset || !calculate) continue;
    const prop = /^\/data\/case\/(?:create|update)\/([^/]+)$/.exec(nodeset)?.[1];
    if (!prop) continue;
    const source = unescapeXml(calculate).trim();
    if (!/^\/data\/[\w/-]+$/.test(source)) continue;
    (out[source] ??= []).push(prop);
  }
  return out;
}

/** `nodeset -> calculate`, unescaped, for every bind in a form. */
function bindCalculates(formXml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const bind of formXml.matchAll(/<bind\b([^>]*?)\/?>/g)) {
    const attrs = bind[1];
    const nodeset = /\bnodeset="([^"]*)"/.exec(attrs)?.[1];
    const calculate = /\bcalculate="([^"]*)"/.exec(attrs)?.[1];
    if (!nodeset || calculate === undefined) continue;
    out[nodeset] = unescapeXml(calculate).trim();
  }
  return out;
}

const BARE_NODE_PATH = /^\/data\/[\w/-]+$/;

/**
 * Split a function's argument list on TOP-LEVEL commas, respecting nesting and
 * quotes. `null` when the parentheses are unbalanced — an expression we cannot
 * even tokenise is one we must not claim to have read.
 */
function splitTopLevelArgs(inner: string): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth < 0) return null;
    } else if (ch === ',' && depth === 0) {
      args.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0 || quote !== null) return null;
  args.push(inner.slice(start));
  return args;
}

/**
 * The value set an XPath expression can store, when that is knowable STATICALLY.
 *
 * Two shapes are recognised, and deliberately only two — they are the shapes
 * ACE's own `entity-state-taxonomy` builds emit:
 *
 *  - a string literal: `'checked'`
 *  - `if(cond, then, else)` where both branches are themselves enumerable,
 *    nested to any depth. The CONDITION is not read: which branch fires is a
 *    runtime question, and the value set is the union either way.
 *
 * Anything else returns a `reason`. That is the honest answer, and the
 * important one: a fabricated value set would turn an uncomparable column into
 * a green comparison, which is strictly worse than the coverage hole ace#2188
 * reports.
 */
function enumerateCalculateLiterals(expr: string): { values: string[] } | { reason: string } {
  const e = expr.trim();
  const literal = /^'([^']*)'$/.exec(e) ?? /^"([^"]*)"$/.exec(e);
  if (literal) return { values: [literal[1]] };

  const conditional = /^if\s*\(([\s\S]*)\)$/.exec(e);
  if (conditional) {
    const args = splitTopLevelArgs(conditional[1]);
    if (args === null) return { reason: `unbalanced expression "${e}"` };
    if (args.length !== 3) {
      return { reason: `if() with ${args.length} arguments in "${e}"` };
    }
    const values = new Set<string>();
    for (const branch of [args[1], args[2]]) {
      const inner = enumerateCalculateLiterals(branch);
      if ('reason' in inner) return inner;
      for (const v of inner.values) values.add(v);
    }
    return { values: [...values] };
  }

  return { reason: `not a literal or an if() of literals: "${e}"` };
}

/**
 * Every case property in one form whose value is written by a hidden
 * `calculate`, with the literal value set that calculate can store (ace#2188).
 *
 * Follows the chain the artifact actually uses: the `<case>` transaction bind
 * copies a hidden node (`calculate="/data/household_state"`), and THAT node's
 * bind carries the taxonomy. Bare-path hops are followed until an expression is
 * reached; a chain ending at a node with no calculate of its own is a plain
 * QUESTION and is not claimed here — that is the select path's job, and
 * inventing a value set for a free-text answer is the failure mode this guards.
 */
export function extractCalculateWrittenValues(
  formXml: string,
  formPath: string,
): { writers: CalculateWriter[]; opaque: OpaqueCalculateWriter[] } {
  const calculates = bindCalculates(formXml);
  const writers: CalculateWriter[] = [];
  const opaque: OpaqueCalculateWriter[] = [];

  for (const [nodeset, calculate] of Object.entries(calculates)) {
    const property = /^\/data\/case\/(?:create|update)\/([^/]+)$/.exec(nodeset)?.[1];
    if (!property) continue;

    let expression = calculate;
    const visited = new Set<string>([nodeset]);
    while (BARE_NODE_PATH.test(expression)) {
      if (visited.has(expression)) {
        expression = '';
        break;
      }
      visited.add(expression);
      const next = calculates[expression];
      // Terminal node with no calculate = a question, not a taxonomy.
      if (next === undefined) {
        expression = '';
        break;
      }
      expression = next;
    }
    if (expression === '') continue;

    const enumerated = enumerateCalculateLiterals(expression);
    if ('reason' in enumerated) {
      opaque.push({ formPath, property, expression, reason: enumerated.reason });
      continue;
    }
    // An empty stored value is "no state yet", not a value a tile can label.
    // A calculate whose literals are ALL empty enumerates to nothing, and
    // comparing a tile against an empty set would fail every row on no
    // evidence — report it as opaque instead.
    const values = enumerated.values.filter((v) => v !== '').sort();
    if (values.length === 0) {
      opaque.push({
        formPath,
        property,
        expression,
        reason: `writes only the empty string in "${expression}"`,
      });
      continue;
    }
    writers.push({ formPath, property, expression, values });
  }

  return { writers, opaque };
}

/** Pull every `select` / `select1` choice list out of one form XML. */
export function extractFormChoiceLists(formXml: string, formPath: string): FormChoiceList[] {
  const itext = parseItext(formXml);
  const caseWrites = extractCaseWriteMap(formXml);
  const lists: FormChoiceList[] = [];
  for (const sel of formXml.matchAll(
    /<(select1|select)\b[^>]*\bref="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g,
  )) {
    const ref = sel[2];
    const property = ref.split('/').filter(Boolean).pop() ?? ref;
    const caseProperties = caseWrites[ref] ?? [];
    const choices: Record<string, string> = {};
    for (const item of sel[3].matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
      const value = /<value\s*>([\s\S]*?)<\/value>/.exec(item[1]);
      if (!value) continue;
      const ref = /<label\s+ref="jr:itext\('([^']+)'\)"\s*\/>/.exec(item[1]);
      const inline = /<label\s*>([\s\S]*?)<\/label>/.exec(item[1]);
      const label = ref ? itext[ref[1]] : inline ? unescapeXml(inline[1].trim()) : undefined;
      if (label === undefined) continue;
      choices[unescapeXml(value[1].trim())] = label;
    }
    if (Object.keys(choices).length > 0)
      lists.push({ formPath, property, caseProperties, choices });
  }
  return lists;
}

/**
 * The ace#1688 gate: for every id-mapping case-list column whose case property
 * a form `select1` also writes, the column's `value -> label` map must be a
 * SUBSET of that select's.
 *
 * Pure and structural — the CCZ is the only input. No device, no live Nova, no
 * Connect. `unable` (never `ok`) when the CCZ carries no id-mapping column at
 * all, or when none of them pairs with a select: both mean nothing was
 * compared, and a blind check must not read as a pass (`lib/check-outcome.ts`).
 */
export function checkCczCaseListEnumFidelity(input: {
  /** `suite.xml` from the CCZ root. */
  suiteXml: string;
  /** `<lang>/app_strings.txt` — raw text. */
  appStrings: string;
  /** Every form XML in the CCZ, with its in-zip path. */
  forms: Array<{ path: string; xml: string }>;
}): CheckOutcome<CczEnumFidelityFinding, CczEnumFidelityExtras> {
  const strings = parseAppStrings(input.appStrings);
  const columns = extractCaseListEnums(input.suiteXml, strings);
  if (columns.length === 0) {
    return unable(
      'this CCZ declares no id-mapping case-list column, so there is no ' +
        'tile-vs-form taxonomy to compare',
    );
  }

  // Two passes, and the ORDER is the ace#1808 fix. The case-write binds are the
  // form's own declaration of which case property a select writes, so they win;
  // the question-id tail is a fallback for a select with no case write (or one
  // whose write is an expression rather than a bare node path).
  const lists = input.forms.flatMap((f) => extractFormChoiceLists(f.xml, f.path));
  const byProperty = new Map<string, FormChoiceList>();
  for (const list of lists) {
    for (const prop of list.caseProperties) {
      if (!byProperty.has(prop)) byProperty.set(prop, list);
    }
  }
  for (const list of lists) {
    if (!byProperty.has(list.property)) byProperty.set(list.property, list);
  }

  // ace#2188. A select wins where there is one — it carries labels, so it
  // supports the full diff. Where there is none, the taxonomy is usually a
  // hidden calculate, and its value set is the UNION across every form: on the
  // repro build `declined` is written only by Register and `checked` only by
  // Follow-Up, so a per-form comparison would false-fail both.
  const calculateSides = input.forms.map((f) => extractCalculateWrittenValues(f.xml, f.path));
  const calculateWriters = calculateSides.flatMap((s) => s.writers);
  const opaqueWriters = calculateSides.flatMap((s) => s.opaque);
  const calcByProperty = new Map<string, { values: Set<string>; formPaths: string[] }>();
  for (const w of calculateWriters) {
    const entry = calcByProperty.get(w.property) ?? { values: new Set<string>(), formPaths: [] };
    for (const v of w.values) entry.values.add(v);
    if (!entry.formPaths.includes(w.formPath)) entry.formPaths.push(w.formPath);
    calcByProperty.set(w.property, entry);
  }

  const findings: CczEnumFidelityFinding[] = [];
  const seen = new Map<string, CczEnumFidelityFinding>();
  const unpaired: string[] = [];
  const unpairedWhy: string[] = [];
  const unlabelledInCaseList: Record<string, string[]> = {};
  const calculateWritten: Record<string, string[]> = {};
  let columnsCompared = 0;
  let valuesCompared = 0;

  /** Record a finding once, naming every detail that renders it. */
  const record = (column: CaseListEnumColumn, finding: CczEnumFidelityFinding) => {
    const key = `${column.property}|${finding.value}|${finding.kind}`;
    const already = seen.get(key);
    if (already) {
      if (!already.detailIds.includes(column.detailId)) {
        already.detailIds.push(column.detailId);
      }
      return;
    }
    seen.set(key, finding);
    findings.push(finding);
  };

  for (const column of columns) {
    const list = byProperty.get(column.property);
    if (!list) {
      const calc = calcByProperty.get(column.property);
      if (calc) {
        // VALUE-SET comparison only: a calculate carries no labels, so there is
        // no second labelled surface in the CCZ to disagree with. Label
        // fidelity for a state taxonomy is the PDD's authority and is gated at
        // build time (`pdd-to-deliver-app § Step 4l`).
        columnsCompared += 1;
        valuesCompared += Object.keys(column.enums).length;
        const formPath = calc.formPaths.join(', ');
        calculateWritten[column.property] = [...calc.values].sort();
        for (const value of Object.keys(column.enums).sort()) {
          if (calc.values.has(value)) continue;
          record(column, {
            value,
            caseListLabel: column.enums[value],
            formLabel: null,
            kind: 'missing-from-form',
            remediation:
              `The case list renders "${value}" as "${column.enums[value]}", but no ` +
              `calculate in this CCZ writes that value to "${column.property}" — the ` +
              `writers store ${[...calc.values].sort().map((v) => `"${v}"`).join(', ')}, ` +
              `so no worker can ever produce it. Either the enum is stale or the ` +
              `calculate lost a branch; fix it at pdd-to-deliver-app, not at the enum.`,
            property: column.property,
            detailIds: [column.detailId],
            formPath,
            writer: 'calculate',
          });
        }
        const unlabelled = [...calc.values].filter((v) => !(v in column.enums)).sort();
        if (unlabelled.length > 0) unlabelledInCaseList[column.property] = unlabelled;
        continue;
      }
      unpaired.push(`${column.detailId}.${column.property}`);
      const opaqueHere = opaqueWriters.filter((w) => w.property === column.property);
      unpairedWhy.push(
        opaqueHere.length > 0
          ? `${column.detailId}.${column.property} is written by a calculate whose value ` +
            `set could not be enumerated (${opaqueHere
              .map((w) => `${w.formPath}: ${w.reason}`)
              .join('; ')})`
          : `${column.detailId}.${column.property} matched no form choice list and no ` +
            `enumerable case-write calculate in this CCZ`,
      );
      continue;
    }
    columnsCompared += 1;
    valuesCompared += Object.keys(column.enums).length;
    const drift = checkCaseListEnumDrift({
      property: column.property,
      caseListEnums: column.enums,
      formChoices: list.choices,
    });
    if (drift.status !== 'checked') continue;
    if (drift.unlabelledInCaseList.length > 0) {
      unlabelledInCaseList[column.property] = drift.unlabelledInCaseList;
    }
    for (const f of drift.findings) {
      // The short and long details carry the same enum, so the same drift shows
      // up twice. `record` reports it once, naming every detail that renders it.
      record(column, {
        ...f,
        property: column.property,
        detailIds: [column.detailId],
        formPath: list.formPath,
        writer: 'select',
      });
    }
  }

  if (columnsCompared === 0) {
    // State what was OBSERVED, not a conclusion about the app. The old wording
    // asserted "no form select writes any of those properties" — a fact about
    // the app that was never established, and was false on the very build that
    // surfaced it (ace#1808). Per-column, the two shapes are named apart
    // (ace#2188): "nothing writes it" and "a calculate writes it and I could
    // not enumerate the calculate" want different follow-ups.
    return unable(
      `pairing failed on all ${columns.length} id-mapping case-list column(s): ` +
        `${unpairedWhy.join('; ')}. Considered ${lists.length} form choice list(s) ` +
        `(question ids: ${lists.map((l) => l.property).join(', ') || 'none'}) and ` +
        `${calcByProperty.size} calculate-written case propert(ies) ` +
        `(${[...calcByProperty.keys()].join(', ') || 'none'}). Nothing was compared, so ` +
        'this is NOT a pass — if something does write one of these properties, the ' +
        'pairing is the bug',
    );
  }

  return {
    ...checked(findings.length === 0, findings),
    columnsCompared,
    valuesCompared,
    unpaired,
    unlabelledInCaseList,
    calculateWritten,
  };
}

/** Render the findings as the lines a build memo / QA verdict should carry. */
export function describeCczEnumFidelity(findings: CczEnumFidelityFinding[]): string[] {
  return findings.map((f) => {
    const head = `${f.property}="${f.value}": tile shows "${f.caseListLabel}" (${f.detailIds.join(', ')})`;
    if (f.kind === 'label-mismatch') return `${head} but ${f.formPath} offers "${f.formLabel}"`;
    // A calculate has no options to offer, so say what it actually is: nothing
    // in the app can ever store that value.
    return f.writer === 'calculate'
      ? `${head} but no calculate in ${f.formPath} ever writes that value`
      : `${head} but ${f.formPath} offers no such option`;
  });
}
