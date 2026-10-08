/**
 * Structural QA for a semantic registry ACE authors from a PDD (ace#2510).
 *
 * Labs validates a registry's GRAMMAR on every save — every reference
 * resolves, every SQL fragment is allow-listed, the whole thing compiles at
 * every scope (`semantic_registry_validate`). It cannot know whether the
 * registry is FAITHFUL to the design it came from: whether an indicator has a
 * PDD section behind it, whether a target was stated by the PDD or invented,
 * whether the report will read in the programme's own nouns, whether every
 * partner opportunity is mapped to its organisation. Those are ACE's to check,
 * and this module checks them — `skills/semantic-registry-author-qa` runs it
 * beside the live labs validation.
 *
 * Pure: no I/O. The registry is the exact `{properties_doc, indicators_doc,
 * deployment}` triple ACE sends to `semantic_registry_create`.
 */

import { checkRegistryDisplayText, DISPLAY_TEXT_FIX } from './registry-display-text.js';

export interface RegistryDocs {
  properties_doc: Record<string, unknown>;
  indicators_doc: Record<string, unknown>;
  deployment?: Record<string, unknown>;
}

export type FindingSeverity = 'fail' | 'warn';

export interface AuthoringFinding {
  check: string;
  severity: FindingSeverity;
  indicator?: string;
  detail: string;
}

export interface AuthoringReport {
  verdict: 'pass' | 'fail';
  indicators: string[];
  findings: AuthoringFinding[];
}

export interface AuthoringOptions {
  /**
   * Sections that exist in the PDD (`pddSectionIds(pdd)`): numbered ids AND heading
   * texts, so `§8.1` and `§ Success Metrics` both resolve. Enables the anchor check.
   */
  pddSections?: readonly string[];
  /** Every synthetic partner opportunity id; each must appear in `deployment.llo_map`. */
  opportunityIds?: readonly number[];
  /** Fewest distinct organisations `llo_map` must name. Default: 3 for invented partners, 2 for a programme's own. */
  minOrganisations?: number;
  /**
   * Where the partners come from. `invented` (the default): ACE made them up, so it
   * can always make three. `programme`: they are the programme's real partners, and a
   * programme with two partners has two -- the floor drops to 2 (a comparison needs
   * two) and fewer than 3 is a warning, because a benchmark then shows each partner
   * its one peer's exact figures.
   */
  partnerSource?: 'invented' | 'programme';
  /**
   * When there is NO PDD: the released Deliver app's form names. An indicator may
   * then anchor on the app instead -- its `scope_note` names `Deliver app` and one of
   * these forms. Ignored when `pddSections` is supplied: a PDD, when it exists, is
   * the only menu.
   */
  appForms?: readonly string[];
}

const CASE_FIELD_FORMATS = new Set(['date', 'count', 'number', 'text']);
const DIRECTIONS = new Set(['higher', 'lower', 'mid2', 'none']);
/**
 * `PDD §8.1`, `§5.4`, `§ 7.2` — a numbered citation; `PDD § Success Metrics` — a
 * named one. ACE's own PDD template has unnumbered headings (ace#2803), so both
 * forms are citations; a named one resolves only against a real heading.
 */
const SECTION_CITE = /§\s*(?:(\d+(?:\.\d+)*)|(?=\p{L}))/gu;
/** Where an unresolved named citation ends, for reporting it. */
const NAMED_CITE_END = /[;,.()\n]|\s[—–-]\s/;

type Measure = { name?: string; title?: string; sql?: string; meta?: Record<string, unknown> };

/**
 * The form names of a released Deliver app, for `appForms`. Accepts the
 * `get_opportunity_apps` response (`{deliver_app: {...}}`) or a bare app JSON
 * (`{modules: [{forms: [{name: {en}}]}]}`).
 */
export function appFormNames(app: unknown): string[] {
  const root = asObj(app);
  const deliver = asObj(root.deliver_app ?? root);
  const names: string[] = [];
  for (const m of Array.isArray(deliver.modules) ? deliver.modules : []) {
    for (const f of Array.isArray(asObj(m).forms) ? (asObj(m).forms as unknown[]) : []) {
      const n = asObj(asObj(f).name).en ?? asObj(f).name;
      if (typeof n === 'string' && n.trim() && !names.includes(n.trim())) names.push(n.trim());
    }
  }
  return names;
}

/** True when `note` names the Deliver app and one of its released forms (case-insensitive). */
export function citesAppForm(note: string, appForms: readonly string[]): boolean {
  const n = note.toLowerCase();
  return n.includes('deliver app') && appForms.some((f) => f.trim() && n.includes(f.trim().toLowerCase()));
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Every section a PDD declares, from its markdown headings — the number AND the
 * heading text: `## 8. Success Metrics` → `8`, `Success Metrics`;
 * `### 8.1 Primary metrics` → `8.1`, `Primary metrics`; ACE's template's unnumbered
 * `## Success Metrics` → `Success Metrics` (ace#2803). A citation resolves iff it
 * names one of these.
 */
export function pddSectionIds(pddMarkdown: string): string[] {
  const out = new Set<string>();
  for (const line of pddMarkdown.split('\n')) {
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!h) continue;
    const m = /^(\d+(?:\.\d+)*)\.?(?:\s+|$)(.*)$/.exec(h[1]);
    if (m) out.add(m[1]);
    const name = (m ? m[2] : h[1]).trim();
    if (name && /\p{L}/u.test(name)) out.add(name);
  }
  return [...out];
}

/**
 * The PDD sections a piece of text cites, in order, de-duplicated. Numbered
 * citations (`§8.1`) come back as the number. A named citation (`§ Success
 * Metrics`) comes back as the longest of `headings` it starts with (matched
 * case-insensitively, on a word boundary), in the PDD's own spelling — or, when
 * no heading matches, as the citation text itself, so it reports as missing.
 */
export function citedSections(text: string, headings: readonly string[] = []): string[] {
  const out: string[] = [];
  const named = headings.filter((h) => /\p{L}/u.test(h)).sort((a, b) => b.length - a.length);
  const norm = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
  for (const m of text.matchAll(SECTION_CITE)) {
    let id: string | undefined = m[1];
    if (id === undefined) {
      const rest = text.slice((m.index ?? 0) + m[0].length);
      const restN = norm(rest);
      id = named.find((h) => {
        const hN = norm(h);
        return restN.startsWith(hN) && !/[\p{L}\d]/u.test(restN.charAt(hN.length));
      });
      if (id === undefined) {
        const end = rest.search(NAMED_CITE_END);
        id = (end >= 0 ? rest.slice(0, end) : rest).trim();
      }
    }
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The top-level indicators of a registry: measures carrying `meta.indicator`. */
export function registryIndicators(indicatorsDoc: Record<string, unknown>): Measure[] {
  const measures = Array.isArray(indicatorsDoc.measures) ? (indicatorsDoc.measures as Measure[]) : [];
  return measures.filter((m) => asObj(m.meta).indicator);
}

export function checkRegistryAuthoring(reg: RegistryDocs, opts: AuthoringOptions = {}): AuthoringReport {
  const findings: AuthoringFinding[] = [];
  const add = (check: string, detail: string, indicator?: string, severity: FindingSeverity = 'fail') =>
    findings.push({ check, severity, detail, ...(indicator ? { indicator } : {}) });

  // ── The model: what one row is, and where its visits come from ──────────
  const props = asObj(reg.properties_doc);
  const entity = asObj(props.entity);
  if (!entity.name || !entity.plural || !entity.key) {
    add('model', '`entity` must declare `name`, `plural` and `key` — a registry without a model is silently read as KMC by labs');
  }
  if (!asObj(props.pipelines).entity) {
    add('model', '`pipelines.entity` must name the pipeline alias Layer 1 reads (the programme report\'s visit-level pipeline)');
  }

  // ── Indicators ─────────────────────────────────────────────────────────
  const doc = asObj(reg.indicators_doc);
  const measures = Array.isArray(doc.measures) ? (doc.measures as Measure[]) : [];
  const byName = new Map(measures.filter((m) => m.name).map((m) => [m.name as string, m]));
  const inds = registryIndicators(doc);
  if (inds.length === 0) add('indicators', 'the registry defines no indicator (no measure carries `meta.indicator`)');

  const headlinePositions = new Map<number, string>();
  const categories = new Set<string>();
  const pdd = opts.pddSections ? new Set(opts.pddSections) : null;

  for (const m of inds) {
    const meta = asObj(m.meta);
    const id = String(meta.indicator);
    for (const key of ['label', 'plain', 'category', 'direction', 'scope_note'] as const) {
      if (typeof meta[key] !== 'string' || !(meta[key] as string).trim()) {
        add('indicator-meta', `\`meta.${key}\` is missing`, id);
      }
    }
    if (typeof meta.direction === 'string' && !DIRECTIONS.has(meta.direction)) {
      add('indicator-meta', `\`direction: ${meta.direction}\` is not one of higher | lower | mid2 | none`, id);
    }
    if (typeof meta.plain === 'string' && meta.plain.length > 240) {
      add('indicator-meta', '`plain` must be ONE plain-English sentence (≤ 240 chars) — it is a tooltip, not a definition document', id, 'warn');
    }
    if (typeof meta.category === 'string') categories.add(meta.category);

    // Numerator and denominator exist as measures, and the value reads both.
    const name = m.name ?? '';
    for (const part of ['numerator', 'denominator']) {
      const partName = `${name}_${part}`;
      if (!byName.has(partName)) add('measures', `\`${partName}\` is not defined — every indicator is a value over a numerator and a denominator`, id);
      else if (!(m.sql ?? '').includes(`{${partName}}`)) add('measures', `the value's \`sql\` does not read \`{${partName}}\``, id);
    }

    // PDD anchor: every indicator cites the section it comes from (No inferred backstory).
    const note = String(meta.scope_note ?? '');
    const cites = citedSections(note, pdd ? [...pdd] : []);
    if (!pdd && opts.appForms?.length) {
      // No PDD: the released app is the source of truth, so the anchor is a form it ships.
      if (!citesAppForm(note, opts.appForms)) {
        add('pdd-anchor', '`scope_note` names no form of the released Deliver app (`Deliver app — <form name>`) — with no PDD, an indicator not anchored in the app is an invented metric', id);
      }
    } else if (cites.length === 0) {
      add('pdd-anchor', '`scope_note` cites no PDD section (`PDD §N.M` or `PDD § <Heading>`) — an indicator without a PDD anchor is an invented metric', id);
    } else if (pdd) {
      const missing = cites.filter((c) => !pdd.has(c));
      if (missing.length === cites.length) add('pdd-anchor', `cites § ${missing.join(', § ')}, which the PDD does not have`, id);
    }

    // Targets: only where the PDD states one, and in the bands' own units.
    if (meta.target !== undefined && meta.target !== null) {
      if (!isNum(meta.target)) add('target', '`target` must be a number in the bands\' units', id);
      else {
        if (meta.direction !== 'higher' && meta.direction !== 'lower') {
          add('target', '`target` needs `direction: higher|lower` to grade against', id);
        }
        if (meta.unit === '%' && (meta.target < 0 || meta.target > 100)) add('target', `a % target must lie in 0–100 (got ${meta.target})`, id);
        if (!String(meta.scope_note ?? '').includes(String(meta.target))) {
          add('target', `\`target: ${meta.target}\` is not quoted in \`scope_note\` — a target must be the PDD's own number, cited where it is declared`, id);
        }
      }
    }
    if (Array.isArray(meta.bands)) {
      const bands = meta.bands as unknown[];
      if (meta.unit === '%' && bands.every((b) => isNum(b) && b > 0 && b <= 1)) {
        add('bands', 'bands written as fractions for a % indicator — every cell grades green (labs "Everything green" symptom); write 80, not 0.8', id);
      }
      if (!isNum(meta.target) && (meta.direction === 'higher' || meta.direction === 'lower')) {
        // Labs defaults the target to bands[0], which prints a goal the PDD never set.
        add('target', 'bands without a declared `target` — labs prints bands[0] as the target; either cite the PDD target or drop the bands', id, 'warn');
      }
    }

    if (meta.headline !== undefined && meta.headline !== false && meta.headline !== true) {
      if (!isNum(meta.headline)) add('headline', '`headline` must be true or a 1-based position', id);
      else if (headlinePositions.has(meta.headline)) {
        add('headline', `headline position ${meta.headline} is also used by ${headlinePositions.get(meta.headline)}`, id);
      } else headlinePositions.set(meta.headline, id);
    }
  }

  // ── Display contract: the programme's own nouns ────────────────────────
  const display = asObj(doc.display);
  if (!display.title) add('display', '`display.title` is missing — the report heading');
  for (const noun of ['entity', 'worker', 'organisation'] as const) {
    const n = asObj(display[noun]);
    if (!n.name || !n.plural) add('display', `\`display.${noun}\` must carry {name, plural} from the PDD's own vocabulary`);
  }
  if (Array.isArray(display.categories)) {
    const declared = new Set((display.categories as unknown[]).map(String));
    for (const c of categories) if (!declared.has(c)) add('display', `category "${c}" is used by an indicator but missing from \`display.categories\``);
  }
  const headlineCount = isNum(display.headline_count) ? display.headline_count : 5;
  for (const [pos, id] of headlinePositions) {
    if (pos > headlineCount) add('headline', `headline position ${pos} exceeds \`display.headline_count\` (${headlineCount})`, id);
  }
  if (Array.isArray(display.case_fields)) {
    for (const f of display.case_fields as unknown[]) {
      const cf = asObj(f);
      if (!cf.field || !cf.label) add('display', `a \`case_fields\` entry needs {field, label}: ${JSON.stringify(f)}`);
      if (cf.format !== undefined && !CASE_FIELD_FORMATS.has(String(cf.format))) {
        add('display', `case field "${cf.field}" has format "${cf.format}" — one of date | count | number | text`);
      }
    }
  } else {
    add('display', '`display.case_fields` is missing — the case table falls back to first/last visit and visit count', undefined, 'warn');
  }

  // ── Reader-facing text reads plainly (ace#2748) ────────────────────────
  // The registry text the cascade RENDERS is for a programme manager: no PDD
  // section numbers, no metric codes, no ≥, no column names. scope_note stays
  // the place for the citation.
  for (const f of checkRegistryDisplayText(doc).findings) {
    add('display-text', `${f.path}: "${f.match}" in "${f.text}" — ${DISPLAY_TEXT_FIX[f.rule]}`);
  }

  // ── Organisation level: every partner opportunity mapped ────────────────
  const lloMap = asObj(asObj(reg.deployment).llo_map);
  const mapped = new Map(Object.entries(lloMap).map(([k, v]) => [Number(k), String(v)]));
  if (opts.opportunityIds) {
    for (const opp of opts.opportunityIds) {
      if (!mapped.has(opp)) add('llo-map', `opportunity ${opp} is not in \`deployment.llo_map\` — its cases have no partner and vanish from the partner level`);
    }
  }
  const programme = opts.partnerSource === 'programme';
  const minOrgs = opts.minOrganisations ?? (programme ? 2 : 3);
  const orgs = new Set(mapped.values());
  if (orgs.size < minOrgs) {
    add('llo-map', `\`deployment.llo_map\` names ${orgs.size} organisation(s); the cascade story needs at least ${minOrgs}`);
  } else if (programme && orgs.size < 3) {
    add('llo-map', `the programme has ${orgs.size} partners — a benchmark cohort can only run with \`min_peers\` below 3, which shows each partner its peer's exact figures; decide that knowingly`, undefined, 'warn');
  }

  const verdict = findings.some((f) => f.severity === 'fail') ? 'fail' : 'pass';
  return { verdict, indicators: inds.map((m) => String(asObj(m.meta).indicator)), findings };
}

// ---------------------------------------------------------------------------
// As QA outcomes — what `semantic-registry-author-qa` writes
// ---------------------------------------------------------------------------

/** Every check `checkRegistryAuthoring` can report, in table order. */
export const REGISTRY_AUTHORING_CHECKS = [
  'model',
  'indicators',
  'indicator-meta',
  'measures',
  'pdd-anchor',
  'target',
  'bands',
  'headline',
  'display',
  'display-text',
  'llo-map',
] as const;

export interface LabsValidateResult {
  valid?: unknown;
  errors?: unknown;
}

/**
 * The gate's result as one outcome PER CHECK, so the result file counts what
 * was checked. spark-facilitator/20260926-1800 wrote `{verdict, findings: []}`
 * — every check ran and passed, but the result carried no `stats`, and ace-web
 * displayed "Passed (0/0 checks)". `warn` findings never fail a check.
 *
 * `pdd-anchor` and `llo-map` only run with their inputs; without them the
 * check FAILS (an input the gate needs is not a reason to skip it), and a
 * missing labs validation fails `labs-validate`.
 */
export function registryQAOutcomes(
  report: AuthoringReport,
  labs: LabsValidateResult | null | undefined,
  inputs: { pddSections?: readonly string[]; opportunityIds?: readonly number[]; appForms?: readonly string[]; pddSupplied?: boolean },
): Array<{ check: string; type: 'static'; result: { pass: boolean; detail?: string; auto_fix_hint?: string } }> {
  const out: Array<{ check: string; type: 'static'; result: { pass: boolean; detail?: string; auto_fix_hint?: string } }> = [];
  const labsErrors = Array.isArray(labs?.errors) ? (labs!.errors as unknown[]) : [];
  out.push({
    check: 'labs-validate',
    type: 'static',
    result: !labs
      ? { pass: false, detail: 'semantic_registry_validate was not run', auto_fix_hint: 'call mcp__connect-labs__semantic_registry_validate({properties_doc, indicators_doc, deployment}) and pass its result' }
      : labs.valid === true
        ? { pass: true, detail: 'labs validated the registry at every scope' }
        : { pass: false, detail: `labs rejected the registry: ${labsErrors.map((e) => JSON.stringify(e)).join('; ') || 'valid != true'}`, auto_fix_hint: 'fix each labs error in the registry and re-validate' },
  });
  for (const check of REGISTRY_AUTHORING_CHECKS) {
    if (check === 'pdd-anchor' && !inputs.pddSections?.length && !inputs.appForms?.length) {
      if (inputs.pddSupplied) {
        out.push({ check, type: 'static', result: { pass: false, detail: 'the PDD was supplied but no section headings parsed from it, so no indicator anchor could be resolved', auto_fix_hint: 'read the PDD as text/markdown (the text/plain export drops the `#` heading markers) and normalise it before pddSectionIds' } });
        continue;
      }
      out.push({ check, type: 'static', result: { pass: false, detail: 'neither the PDD nor the released app was supplied, so no indicator anchor was checked', auto_fix_hint: 'pass the PDD markdown (pddSectionIds), or with no PDD the Deliver app structure (--app)' } });
      continue;
    }
    if (check === 'llo-map' && !inputs.opportunityIds?.length) {
      out.push({ check, type: 'static', result: { pass: false, detail: 'no partner opportunity ids were supplied, so llo_map was not checked', auto_fix_hint: 'pass the cascade partner opportunity ids' } });
      continue;
    }
    const fails = report.findings.filter((f) => f.check === check && f.severity === 'fail');
    const warns = report.findings.filter((f) => f.check === check && f.severity === 'warn');
    out.push({
      check,
      type: 'static',
      result: fails.length
        ? { pass: false, detail: fails.map((f) => `${f.indicator ? `${f.indicator}: ` : ''}${f.detail}`).join('; '), auto_fix_hint: 'see skills/semantic-registry-author-qa § Checks for this row\'s auto-fix' }
        : { pass: true, detail: warns.length ? `pass with ${warns.length} warning(s): ${warns.map((f) => f.detail).join('; ')}` : `ok over ${report.indicators.length} indicator(s)` },
    });
  }
  return out;
}
