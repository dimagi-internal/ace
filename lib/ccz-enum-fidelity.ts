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

export interface CczEnumFidelityFinding extends EnumDriftFinding {
  /** Case property the disagreement is about. */
  property: string;
  /** Every detail that renders this property through the drifted enum. */
  detailIds: string[];
  /** The form whose choice list is the authority for it. */
  formPath: string;
}

export interface CczEnumFidelityExtras {
  /** Columns actually diffed against a form choice list. */
  columnsCompared: number;
  /** Stored values compared across all those columns. */
  valuesCompared: number;
  /** `detailId.property` for id-mapping columns no form select writes. */
  unpaired: string[];
  /** `property` -> values the form can store that the tile has no label for. */
  unlabelledInCaseList: Record<string, string[]>;
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

  const findings: CczEnumFidelityFinding[] = [];
  const seen = new Map<string, CczEnumFidelityFinding>();
  const unpaired: string[] = [];
  const unlabelledInCaseList: Record<string, string[]> = {};
  let columnsCompared = 0;
  let valuesCompared = 0;

  for (const column of columns) {
    const list = byProperty.get(column.property);
    if (!list) {
      unpaired.push(`${column.detailId}.${column.property}`);
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
      // up twice. Report it once, naming every detail that renders it.
      const key = `${column.property}|${f.value}|${f.kind}`;
      const already = seen.get(key);
      if (already) {
        if (!already.detailIds.includes(column.detailId)) {
          already.detailIds.push(column.detailId);
        }
        continue;
      }
      const finding: CczEnumFidelityFinding = {
        ...f,
        property: column.property,
        detailIds: [column.detailId],
        formPath: list.formPath,
      };
      seen.set(key, finding);
      findings.push(finding);
    }
  }

  if (columnsCompared === 0) {
    // State what was OBSERVED, not a conclusion about the app. The old wording
    // asserted "no form select writes any of those properties" — a fact about
    // the app that was never established, and was false on the very build that
    // surfaced it (ace#1808).
    return unable(
      `pairing failed on all ${columns.length} id-mapping case-list column(s) ` +
        `(${unpaired.join(', ')}): none matched a case property written by any of the ` +
        `${lists.length} form choice list(s) in this CCZ, nor any of their question ids ` +
        `(${lists.map((l) => l.property).join(', ') || 'none'}). Nothing was compared, so ` +
        'this is NOT a pass — if a select does write one of these properties, the pairing ' +
        'is the bug',
    );
  }

  return {
    ...checked(findings.length === 0, findings),
    columnsCompared,
    valuesCompared,
    unpaired,
    unlabelledInCaseList,
  };
}

/** Render the findings as the lines a build memo / QA verdict should carry. */
export function describeCczEnumFidelity(findings: CczEnumFidelityFinding[]): string[] {
  return findings.map((f) =>
    f.kind === 'missing-from-form'
      ? `${f.property}="${f.value}": tile shows "${f.caseListLabel}" ` +
        `(${f.detailIds.join(', ')}) but ${f.formPath} offers no such option`
      : `${f.property}="${f.value}": tile shows "${f.caseListLabel}" ` +
        `(${f.detailIds.join(', ')}) but ${f.formPath} offers "${f.formLabel}"`,
  );
}
