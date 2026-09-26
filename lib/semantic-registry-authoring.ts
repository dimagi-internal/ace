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
  /** Section ids that exist in the PDD (`pddSectionIds(pdd)`); enables the anchor check. */
  pddSections?: readonly string[];
  /** Every synthetic partner opportunity id; each must appear in `deployment.llo_map`. */
  opportunityIds?: readonly number[];
  /** Fewest distinct organisations `llo_map` must name. Default 3 (the cascade story's partner floor). */
  minOrganisations?: number;
}

const CASE_FIELD_FORMATS = new Set(['date', 'count', 'number', 'text']);
const DIRECTIONS = new Set(['higher', 'lower', 'mid2', 'none']);
/** `PDD §8.1`, `§5.4`, `§ 7.2` — the citation form an indicator's `scope_note` carries. */
const SECTION_CITE = /§\s*(\d+(?:\.\d+)*)/g;

type Measure = { name?: string; title?: string; sql?: string; meta?: Record<string, unknown> };

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Every numbered section a PDD declares, from its markdown headings:
 * `## 8. Success Metrics` → `8`; `### 8.1 Primary metrics` → `8.1`.
 * A cited `§8.1` resolves iff it is in this list.
 */
export function pddSectionIds(pddMarkdown: string): string[] {
  const out = new Set<string>();
  for (const line of pddMarkdown.split('\n')) {
    const m = /^#{1,6}\s+(\d+(?:\.\d+)*)\.?\s/.exec(line);
    if (m) out.add(m[1]);
  }
  return [...out];
}

/** The PDD sections a piece of text cites, in order, de-duplicated. */
export function citedSections(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SECTION_CITE)) if (!out.includes(m[1])) out.push(m[1]);
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
    const cites = citedSections(String(meta.scope_note ?? ''));
    if (cites.length === 0) {
      add('pdd-anchor', '`scope_note` cites no PDD section (`PDD §N.M`) — an indicator without a PDD anchor is an invented metric', id);
    } else if (pdd) {
      const missing = cites.filter((c) => !pdd.has(c));
      if (missing.length === cites.length) add('pdd-anchor', `cites §${missing.join(', §')}, which the PDD does not have`, id);
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

  // ── Organisation level: every partner opportunity mapped ────────────────
  const lloMap = asObj(asObj(reg.deployment).llo_map);
  const mapped = new Map(Object.entries(lloMap).map(([k, v]) => [Number(k), String(v)]));
  if (opts.opportunityIds) {
    for (const opp of opts.opportunityIds) {
      if (!mapped.has(opp)) add('llo-map', `opportunity ${opp} is not in \`deployment.llo_map\` — its cases have no partner and vanish from the partner level`);
    }
  }
  const minOrgs = opts.minOrganisations ?? 3;
  const orgs = new Set(mapped.values());
  if (orgs.size < minOrgs) {
    add('llo-map', `\`deployment.llo_map\` names ${orgs.size} organisation(s); the cascade story needs at least ${minOrgs}`);
  }

  const verdict = findings.some((f) => f.severity === 'fail') ? 'fail' : 'pass';
  return { verdict, indicators: inds.map((m) => String(asObj(m.meta).indicator)), findings };
}
