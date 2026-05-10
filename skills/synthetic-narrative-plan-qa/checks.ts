/**
 * Static QA checks for `synthetic-narrative-plan-qa`.
 *
 * Each check takes the manifest YAML text (utf-8) and returns a `QACheckResult`.
 * Checks are pure, no LLM, fast (<10ms per check on a typical manifest).
 *
 * The primary primitive is a Zod schema (`ManifestZ`) mirroring the contract
 * the connect-labs `synthetic_generate_from_manifest` MCP atom validates at
 * its boundary. Per `_qa-decisions.md` rationale: ACE-side QA gives faster
 * failure + structured `auto_fix_hint` for orchestrator-driven retry without
 * burning a labs dispatch round-trip.
 *
 * **Schema-skeleton approach.** The Zod here mirrors upstream's REQUIRED FIELD
 * STRUCTURE (names, arity, list-vs-scalar) but doesn't re-validate every value
 * constraint upstream enforces (e.g. `flag_rate` in 0-1, `id` regex pattern,
 * date-range consistency). Skeleton-level mirroring catches the high-cost
 * mistakes (`flw_id` vs `flw_ids`, missing required field, wrong list arity)
 * fast without duplicating upstream's value validation per
 * `_qa-template.md § Don't duplicate MCP-boundary QA`.
 *
 * Cross-checked against connect-labs `commcare_connect/labs/synthetic/generator/manifest.py`
 * at origin/main commit c20a91b6 on 2026-05-09.
 *
 * Imported by:
 * - The skill body via `scripts/qa-run.ts` at runtime (orchestrator dispatch)
 * - Per-skill tests under `test/skills/synthetic-narrative-plan-qa/` (vitest)
 *
 * The `CHECKS` array is the canonical ordering — both runtime and tests
 * iterate it. Add a check by appending to the array; surface in the SKILL.md
 * `## Checks` table simultaneously.
 */

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { QACheck, QACheckContext, QACheckResult } from '../../lib/qa-types';

const VALID_ARCHETYPES = ['rockstar', 'steady', 'struggling', 'new_hire'] as const;

const REQUIRED_TOP_LEVEL_KEYS = [
  'opportunity_id',
  'opportunity_name',
  'random_seed',
  'timeline',
  'flw_personas',
  'beneficiary_cohorts',
  'kpi_config',
] as const;

const VALID_ANOMALY_TYPES = ['field_outlier', 'missing_visits', 'duplicate_submission'] as const;
const VALID_KPI_AGGREGATIONS = ['validated_rate', 'non_null_rate', 'mean', 'count'] as const;

// ── Zod schemas (used both by the schema-shape check and the cross-field checks) ──

const TimelineZ = z.object({
  start_date: z.string().min(1),
  end_date: z.string().min(1),
  weeks: z.number().int().min(1),
}).passthrough(); // visit_cadence_per_week_per_flw etc. — pass through, upstream validates

const FlwPersonaZ = z.object({
  // `id` is REQUIRED upstream (matches `^[a-z0-9_]+$`); cross-refs in
  // coaching_arcs[].flw_id and anomalies[].flw_ids resolve against it.
  id: z.string().min(1),
  archetype: z.enum(VALID_ARCHETYPES),
}).passthrough(); // accuracy_distribution / completeness_distribution / flag_rate etc.

const AnomalyZ = z.object({
  // Upstream uses `flw_ids: list[str]` (plural list), NOT `flw_id: str`.
  // Earlier ACE-side draft had this wrong — fix landed 2026-05-09 after
  // connect-labs source cross-check.
  id: z.string().min(1),
  type: z.enum(VALID_ANOMALY_TYPES),
  flw_ids: z.array(z.string().min(1)).min(1),
  week: z.number().int().nullable().optional(),
  weeks: z.array(z.number().int()).nullable().optional(),
  field_path: z.string().min(1).nullable().optional(),
  detection_path: z.string().min(1).nullable().optional(),
}).passthrough();

const CoachingArcZ = z.object({
  flw_id: z.string().min(1),
}).passthrough(); // week_triggered / persona / target_behavior / transcript

const KpiZ = z.object({
  kpi: z.string().min(1),
  field_path: z.string().min(1),
  aggregation: z.enum(VALID_KPI_AGGREGATIONS),
}).passthrough(); // threshold_underperform / threshold_target — upstream validates types

/**
 * Top-level manifest shape — schema skeleton mirroring upstream's
 * `commcare_connect/labs/synthetic/generator/manifest.py § Manifest`.
 * Passthrough on unknown keys; nested objects also passthrough so upstream's
 * full value validation (distributions, rate ranges, date consistency) stays
 * the source of truth.
 */
const ManifestZ = z
  .object({
    opportunity_id: z.number().int().positive(),
    opportunity_name: z.string().min(1),
    random_seed: z.number().int().min(0), // upstream: NonNegativeInt (0 OK, not PositiveInt)
    timeline: TimelineZ,
    flw_personas: z.array(FlwPersonaZ).min(1),
    beneficiary_cohorts: z.array(z.unknown()).min(1),
    kpi_config: z.array(KpiZ).min(1),
    anomalies: z.array(AnomalyZ).optional(),
    coaching_arcs: z.array(CoachingArcZ).optional(),
  })
  .passthrough();

// ── Helpers ──

interface ParseResult {
  ok: boolean;
  parsed?: unknown;
  err?: string;
}

function safeParseYaml(text: string): ParseResult {
  try {
    const parsed = parseYaml(text);
    if (parsed === null || parsed === undefined) {
      return { ok: false, err: 'manifest parsed as null/empty' };
    }
    if (Array.isArray(parsed) || typeof parsed !== 'object') {
      return { ok: false, err: 'manifest top-level must be a mapping (object), not a sequence/scalar' };
    }
    return { ok: true, parsed };
  } catch (e) {
    return { ok: false, err: (e as Error).message };
  }
}

function getParsed(text: string): Record<string, unknown> | null {
  const r = safeParseYaml(text);
  if (!r.ok) return null;
  return r.parsed as Record<string, unknown>;
}

// ── Checks ──

/**
 * Check 1: File parses as a YAML mapping.
 */
export function checkManifestYamlParses(text: string): QACheckResult {
  const r = safeParseYaml(text);
  if (r.ok) return { pass: true };
  return {
    pass: false,
    detail: `manifest YAML parse failed: ${r.err}`,
    auto_fix_hint:
      're-emit the manifest as valid YAML — likely truncated mid-write or a hand-edit broke quoting. Re-run synthetic-narrative-plan to regenerate.',
  };
}

/**
 * Check 2: Required top-level keys are present.
 */
export function checkRequiredKeysPresent(text: string): QACheckResult {
  const m = getParsed(text);
  if (!m) {
    return {
      pass: false,
      detail: 'cannot validate keys: manifest YAML did not parse',
      auto_fix_hint: 'fix YAML parse errors first (see check manifest_yaml_parses)',
    };
  }
  const missing = REQUIRED_TOP_LEVEL_KEYS.filter((k) => !(k in m));
  if (missing.length === 0) return { pass: true };
  return {
    pass: false,
    detail: `missing required top-level key(s): ${missing.join(', ')}`,
    auto_fix_hint:
      `re-emit the manifest with the missing top-level keys: ${missing.join(', ')}. ` +
      `Default values are acceptable (the eval grades quality separately). ` +
      `See skills/synthetic-data-generate/SKILL.md § Default manifest shape for the canonical defaults.`,
  };
}

/**
 * Check 3: flw_personas is non-empty + each item is well-formed.
 */
export function checkFlwPersonasWellFormed(text: string): QACheckResult {
  const m = getParsed(text);
  if (!m) {
    return {
      pass: false,
      detail: 'cannot validate flw_personas: manifest YAML did not parse',
      auto_fix_hint: 'fix YAML parse errors first',
    };
  }
  const personas = m.flw_personas;
  if (!Array.isArray(personas) || personas.length === 0) {
    return {
      pass: false,
      detail: 'flw_personas missing, empty, or not an array',
      auto_fix_hint:
        'populate flw_personas with at least one persona; default mix is 1 rockstar / 2 steady / 1 struggling / 1 new_hire (see synthetic-narrative-plan/SKILL.md step 3)',
    };
  }
  const issues: string[] = [];
  personas.forEach((p, idx) => {
    const r = FlwPersonaZ.safeParse(p);
    if (!r.success) {
      issues.push(`#${idx}: ${r.error.issues.map((i) => i.message).join('; ')}`);
    }
  });
  if (issues.length === 0) {
    return { pass: true, detail: `${personas.length} persona(s) well-formed` };
  }
  return {
    pass: false,
    detail: `flw_personas malformed: ${issues.slice(0, 5).join(' | ')}${issues.length > 5 ? ` (+${issues.length - 5} more)` : ''}`,
    auto_fix_hint:
      `regenerate flw_personas with required fields: 'id' (or 'display_name') and 'archetype' in {${VALID_ARCHETYPES.join(', ')}}. ` +
      `Each persona must have an archetype value from the enum — generic strings like 'good' or 'bad' are not accepted by the labs MCP.`,
  };
}

/**
 * Check 4: KPI field paths are resolvable against the deliver-app summary
 * IF that summary is supplied in context. When absent, return INFO-style pass.
 */
export function checkKpiFieldPathsResolvable(text: string, ctx?: QACheckContext): QACheckResult {
  const m = getParsed(text);
  if (!m) return { pass: true, detail: 'manifest unparseable; check skipped' };
  const summary = ctx?.deliver_summary as string | undefined;
  if (!summary) {
    return {
      pass: true,
      detail: 'deliver-app summary not supplied; field-path resolvability check skipped (INFO)',
    };
  }
  const kpis = Array.isArray(m.kpi_config) ? (m.kpi_config as Array<Record<string, unknown>>) : [];
  if (kpis.length === 0) return { pass: true, detail: 'kpi_config empty; nothing to resolve' };
  const unresolved: string[] = [];
  for (const kpi of kpis) {
    const fp = typeof kpi.field_path === 'string' ? kpi.field_path : '';
    if (!fp) continue; // empty field_path is acceptable per Stage 1 default
    if (!summary.includes(fp)) {
      unresolved.push(fp);
    }
  }
  if (unresolved.length === 0) return { pass: true };
  return {
    pass: false,
    detail: `kpi field_path(s) not found in deliver-app summary: ${unresolved.join(', ')}`,
    auto_fix_hint:
      `fix each kpi_config[].field_path to reference a real form question path from the deliver app summary. ` +
      `Common paths are listed in 2-commcare/app-deploy_summary.md.`,
  };
}

/**
 * Check 5: Anomalies traceable — each has id + type + flw_ids (non-empty list)
 * + a week reference (`week` or `weeks`) + (field_path | detection_path).
 *
 * Upstream uses `flw_ids: list[str]` (plural list), not `flw_id: str`.
 * AnomalyZ validates `id` and `type` (per the upstream Pydantic) so a missing
 * required field surfaces here directly.
 */
export function checkAnomaliesTraceable(text: string): QACheckResult {
  const m = getParsed(text);
  if (!m) return { pass: true, detail: 'manifest unparseable; check skipped' };
  const anomalies = m.anomalies;
  if (anomalies === undefined || anomalies === null) {
    return { pass: true, detail: 'anomalies absent (optional)' };
  }
  if (!Array.isArray(anomalies)) {
    return {
      pass: false,
      detail: 'anomalies must be an array',
      auto_fix_hint: 'change anomalies to a YAML sequence ([] or list of objects)',
    };
  }
  if (anomalies.length === 0) return { pass: true, detail: 'anomalies empty' };
  const issues: string[] = [];
  anomalies.forEach((a, idx) => {
    const r = AnomalyZ.safeParse(a);
    if (!r.success) {
      issues.push(`#${idx}: ${r.error.issues.map((i) => i.message).join('; ')}`);
      return;
    }
    const missing: string[] = [];
    // `flw_ids` (list) is required by AnomalyZ; the schema parse already
    // catches empty / missing. Just check the trace fields here.
    if (r.data.week === undefined && (!r.data.weeks || r.data.weeks.length === 0)) {
      missing.push('week|weeks');
    }
    if (!r.data.field_path && !r.data.detection_path) {
      missing.push('field_path|detection_path');
    }
    if (missing.length > 0) {
      issues.push(`#${idx}: missing ${missing.join(', ')}`);
    }
  });
  if (issues.length === 0) {
    return { pass: true, detail: `${anomalies.length} anomaly entr(ies) traceable` };
  }
  return {
    pass: false,
    detail: `anomalies missing trace fields: ${issues.slice(0, 5).join(' | ')}${issues.length > 5 ? ` (+${issues.length - 5} more)` : ''}`,
    auto_fix_hint:
      `each anomaly must have id + type + flw_ids (non-empty list) + a week reference (week or weeks) + (field_path OR detection_path). ` +
      `An anomaly without a detection path is reviewer-invisible downstream — it generates no signal in labs.`,
  };
}

/**
 * Check 6: Every coaching_arcs[].flw_id appears in flw_personas[].id.
 */
export function checkCoachingArcsMatchPersonas(text: string): QACheckResult {
  const m = getParsed(text);
  if (!m) return { pass: true, detail: 'manifest unparseable; check skipped' };
  const arcs = m.coaching_arcs;
  if (!Array.isArray(arcs) || arcs.length === 0) {
    return { pass: true, detail: 'coaching_arcs empty or absent (optional)' };
  }
  const personas = Array.isArray(m.flw_personas) ? (m.flw_personas as Array<Record<string, unknown>>) : [];
  const personaIds = new Set(
    personas.map((p) => (typeof p.id === 'string' ? p.id : '')).filter(Boolean),
  );
  const dangling: string[] = [];
  arcs.forEach((arc, idx) => {
    const flwId = typeof (arc as Record<string, unknown>)?.flw_id === 'string'
      ? ((arc as Record<string, unknown>).flw_id as string)
      : '';
    if (!flwId) {
      dangling.push(`#${idx}: missing flw_id`);
      return;
    }
    if (!personaIds.has(flwId)) {
      dangling.push(`#${idx}: flw_id '${flwId}' not in flw_personas`);
    }
  });
  if (dangling.length === 0) return { pass: true, detail: `${arcs.length} arc(s) match personas` };
  return {
    pass: false,
    detail: `coaching_arcs reference unknown FLW(s): ${dangling.join(' | ')}`,
    auto_fix_hint:
      `each coaching_arcs[].flw_id must match a flw_personas[].id. ` +
      `Either fix the flw_id to match an existing persona, or add the persona to flw_personas.`,
  };
}

/**
 * Check 7: random_seed is present and is a positive integer.
 */
export function checkRandomSeedPresent(text: string): QACheckResult {
  const m = getParsed(text);
  if (!m) return { pass: true, detail: 'manifest unparseable; check skipped' };
  const seed = m.random_seed;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed <= 0) {
    return {
      pass: false,
      detail: `random_seed must be a positive integer (got: ${JSON.stringify(seed)})`,
      auto_fix_hint:
        "set `random_seed:` to today's date as a YYYYMMDD integer (e.g. 20260509). Required for deterministic regeneration across re-runs.",
    };
  }
  return { pass: true, detail: `seed=${seed}` };
}

/**
 * Check 8: timeline.start_date < timeline.end_date and timeline.weeks ≥ 1.
 */
export function checkTimelineDatesConsistent(text: string): QACheckResult {
  const m = getParsed(text);
  if (!m) return { pass: true, detail: 'manifest unparseable; check skipped' };
  const tl = m.timeline as Record<string, unknown> | undefined;
  if (!tl || typeof tl !== 'object') {
    return {
      pass: false,
      detail: 'timeline missing or not an object',
      auto_fix_hint: 'add a timeline mapping with start_date, end_date, weeks',
    };
  }
  const r = TimelineZ.safeParse(tl);
  if (!r.success) {
    return {
      pass: false,
      detail: `timeline malformed: ${r.error.issues.map((i) => `${i.path.join('.')}:${i.message}`).join(' | ')}`,
      auto_fix_hint:
        'timeline must have start_date (ISO string), end_date (ISO string), weeks (positive integer)',
    };
  }
  const start = Date.parse(r.data.start_date);
  const end = Date.parse(r.data.end_date);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return {
      pass: false,
      detail: `timeline dates not parseable: start_date='${r.data.start_date}', end_date='${r.data.end_date}'`,
      auto_fix_hint: 'use ISO date strings (YYYY-MM-DD) for start_date and end_date',
    };
  }
  if (start >= end) {
    return {
      pass: false,
      detail: `timeline.start_date (${r.data.start_date}) must precede timeline.end_date (${r.data.end_date})`,
      auto_fix_hint:
        'fix the timeline so start_date precedes end_date. Default: start_date = today − weeks*7 days, end_date = today.',
    };
  }
  return { pass: true, detail: `${r.data.weeks}-week window` };
}

// ── Canonical CHECKS array ────────────────────────────────────────

/**
 * Ordered list of static checks synthetic-narrative-plan-qa runs.
 * The `id` of each check matches the row in
 * skills/synthetic-narrative-plan-qa/SKILL.md `## Checks` table.
 */
export const CHECKS: QACheck[] = [
  {
    id: 'manifest_yaml_parses',
    type: 'static',
    description: 'Manifest file parses as a YAML mapping',
    run: checkManifestYamlParses,
  },
  {
    id: 'required_keys_present',
    type: 'static',
    description: 'Required top-level keys present',
    run: checkRequiredKeysPresent,
  },
  {
    id: 'flw_personas_well_formed',
    type: 'static',
    description: 'flw_personas non-empty; each item has id+archetype with valid archetype enum',
    run: checkFlwPersonasWellFormed,
  },
  {
    id: 'kpi_field_paths_resolvable',
    type: 'static',
    description:
      'kpi_config[].field_path resolves against deliver-app summary (skipped INFO when summary not supplied)',
    run: checkKpiFieldPathsResolvable,
  },
  {
    id: 'anomalies_traceable',
    type: 'static',
    description:
      'each anomaly has flw_id + week + (field_path | detection_path); empty anomalies allowed',
    run: checkAnomaliesTraceable,
  },
  {
    id: 'coaching_arcs_match_personas',
    type: 'static',
    description: 'every coaching_arcs[].flw_id maps to a flw_personas[].id',
    run: checkCoachingArcsMatchPersonas,
  },
  {
    id: 'random_seed_present',
    type: 'static',
    description: 'random_seed is a positive integer (deterministic generation)',
    run: checkRandomSeedPresent,
  },
  {
    id: 'timeline_dates_consistent',
    type: 'static',
    description: 'timeline.start_date < end_date; weeks ≥ 1',
    run: checkTimelineDatesConsistent,
  },
];
