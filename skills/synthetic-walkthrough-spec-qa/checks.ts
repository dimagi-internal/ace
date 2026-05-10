/**
 * Static QA checks for `synthetic-walkthrough-spec-qa`.
 *
 * Each check takes the spec YAML text (utf-8) and returns a `QACheckResult`.
 * Checks are pure, no LLM, fast (<10ms per check on a typical spec).
 *
 * The primary primitive is a Zod schema (`SpecZ`) mirroring the contract
 * `canopy:walkthrough` validates at its boundary. Per `_qa-decisions.md`
 * rationale: ACE-side QA gives faster failure + structured `auto_fix_hint`
 * for orchestrator-driven retry without spawning a canopy:walkthrough run.
 *
 * Cross-checked against canopy plugin's
 * `skills/walkthrough/SKILL.md § Walkthrough Spec Format` at canopy
 * v0.2.87 on 2026-05-09. Spec format declares `auth` as optional ("omit
 * for public pages") and `ai_quality` as optional per scene.
 *
 * Imported by:
 * - The skill body via `scripts/qa-run.ts` at runtime (orchestrator dispatch)
 * - Per-skill tests under `test/skills/synthetic-walkthrough-spec-qa/` (vitest)
 *
 * The `CHECKS` array is the canonical ordering — both runtime and tests
 * iterate it. Add a check by appending; surface in SKILL.md `## Checks`
 * simultaneously.
 */

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { QACheck, QACheckResult } from '../../lib/qa-types';

// `auth` is OPTIONAL per upstream — omit for public pages. Earlier draft
// had it in REQUIRED_TOP_LEVEL_KEYS; corrected 2026-05-09 after canopy
// source cross-check.
const REQUIRED_TOP_LEVEL_KEYS = ['name', 'narrative', 'base_url', 'personas', 'scenes'] as const;

const MIN_SCENES = 4;

/**
 * Phrases that, if `ai_quality` matches them at the whole-string level
 * (after normalization), indicate the assertion is unfalsifiable.
 *
 * The list intentionally undershoots — we'd rather pass borderline cases
 * here and let `synthetic-walkthrough-spec-eval` grade the substantive
 * quality. QA only catches the obvious unfalsifiable shapes.
 */
const TRIVIAL_AI_QUALITY = new Set([
  'looks good',
  'the page should be nice',
  'the page looks good',
  'looks nice',
  'looks correct',
  'is correct',
  'is good',
  'good',
  'nice',
  'fine',
  'ok',
  'okay',
  'tbd',
  'todo',
]);

// ── Zod schemas ──

const PersonaZ = z
  .object({
    name: z.string().optional(),
    role: z.string().optional(),
    color: z.string().optional(),
    intro: z.string().min(1).optional(),
  })
  .passthrough();

const SceneZ = z
  .object({
    persona: z.string().min(1),
    title: z.string().min(1),
    show: z.string().min(1),
    impressive_because: z.string().min(1),
    // `ai_quality` is OPTIONAL per the upstream spec format ("optional"
    // comment at the example in canopy walkthrough SKILL.md). Earlier
    // draft required it; corrected 2026-05-09 after canopy source cross-check.
    ai_quality: z.string().min(1).optional(),
  })
  .passthrough();

const AuthZ = z
  .object({
    type: z.enum(['url', 'command']),
  })
  .passthrough();

const SpecZ = z
  .object({
    name: z.string().min(1),
    narrative: z.string().min(1),
    base_url: z.string().min(1),
    // `auth` optional per upstream — public pages omit it entirely.
    auth: AuthZ.optional(),
    personas: z.record(PersonaZ),
    scenes: z.array(SceneZ),
  })
  .passthrough();

// ── Helpers ──

function safeParse(text: string): { ok: boolean; parsed?: Record<string, unknown>; err?: string } {
  try {
    const parsed = parseYaml(text);
    if (parsed === null || parsed === undefined) {
      return { ok: false, err: 'spec parsed as null/empty' };
    }
    if (Array.isArray(parsed) || typeof parsed !== 'object') {
      return { ok: false, err: 'spec top-level must be a mapping (object), not a sequence/scalar' };
    }
    return { ok: true, parsed: parsed as Record<string, unknown> };
  } catch (e) {
    return { ok: false, err: (e as Error).message };
  }
}

function getParsed(text: string): Record<string, unknown> | null {
  const r = safeParse(text);
  return r.ok ? (r.parsed as Record<string, unknown>) : null;
}

// ── Checks ──

/** Check 1: File parses as a YAML mapping. */
export function checkSpecYamlParses(text: string): QACheckResult {
  const r = safeParse(text);
  if (r.ok) return { pass: true };
  return {
    pass: false,
    detail: `spec YAML parse failed: ${r.err}`,
    auto_fix_hint:
      're-emit the spec as valid YAML — likely truncated mid-write or hand-edit broke quoting. Re-run synthetic-walkthrough-spec to regenerate.',
  };
}

/** Check 2: Required top-level keys present. */
export function checkRequiredTopLevelKeys(text: string): QACheckResult {
  const m = getParsed(text);
  if (!m) {
    return {
      pass: false,
      detail: 'cannot validate keys: spec YAML did not parse',
      auto_fix_hint: 'fix YAML parse errors first (see check spec_yaml_parses)',
    };
  }
  const missing = REQUIRED_TOP_LEVEL_KEYS.filter((k) => !(k in m));
  if (missing.length === 0) return { pass: true };
  return {
    pass: false,
    detail: `missing required top-level key(s): ${missing.join(', ')}`,
    auto_fix_hint:
      `re-emit the spec with the missing top-level keys: ${missing.join(', ')}. ` +
      `See skills/synthetic-walkthrough-spec/SKILL.md § Process step 4 for the canonical shape.`,
  };
}

/** Check 3: scenes is an array of ≥4 scenes; each scene has required fields. */
export function checkScenesArrayWellFormed(text: string): QACheckResult {
  const m = getParsed(text);
  if (!m) {
    return {
      pass: false,
      detail: 'cannot validate scenes: spec YAML did not parse',
      auto_fix_hint: 'fix YAML parse errors first',
    };
  }
  const scenes = m.scenes;
  if (!Array.isArray(scenes)) {
    return {
      pass: false,
      detail: 'scenes missing or not an array',
      auto_fix_hint: 'add a scenes: [...] array with at least 4 scene entries',
    };
  }
  if (scenes.length < MIN_SCENES) {
    return {
      pass: false,
      detail: `scenes has ${scenes.length} entry(ies); minimum is ${MIN_SCENES}`,
      auto_fix_hint:
        `add scenes until count reaches ≥${MIN_SCENES}. Per synthetic-walkthrough-spec/SKILL.md step 3, target 5–8 scenes per persona to map their priorities to labs URLs.`,
    };
  }
  const issues: string[] = [];
  scenes.forEach((s, idx) => {
    const r = SceneZ.safeParse(s);
    if (!r.success) {
      const fields = r.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}:${i.message}`)
        .join('; ');
      issues.push(`#${idx}: ${fields}`);
    }
  });
  if (issues.length === 0) {
    return { pass: true, detail: `${scenes.length} scene(s) well-formed` };
  }
  return {
    pass: false,
    detail: `scenes malformed: ${issues.slice(0, 5).join(' | ')}${issues.length > 5 ? ` (+${issues.length - 5} more)` : ''}`,
    auto_fix_hint:
      'every scene must have non-empty: persona, title, show, impressive_because. ai_quality is optional but recommended (drives the AI-judge rubric). See synthetic-walkthrough-spec/SKILL.md step 4 for examples.',
  };
}

/** Check 4: every scenes[].persona key exists in personas. */
export function checkScenePersonasResolvable(text: string): QACheckResult {
  const m = getParsed(text);
  if (!m) return { pass: true, detail: 'spec unparseable; check skipped' };
  const personas = m.personas;
  const scenes = m.scenes;
  if (!personas || typeof personas !== 'object' || Array.isArray(personas)) {
    return {
      pass: false,
      detail: 'personas missing or not a mapping',
      auto_fix_hint: 'add personas: { <key>: { intro: "..." } } mapping at top level',
    };
  }
  if (!Array.isArray(scenes)) return { pass: true, detail: 'scenes not an array; deferred to scenes_array_well_formed' };
  const personaKeys = new Set(Object.keys(personas as Record<string, unknown>));
  const orphans: string[] = [];
  scenes.forEach((s, idx) => {
    const persona = (s as Record<string, unknown>)?.persona;
    if (typeof persona !== 'string') {
      orphans.push(`#${idx}: scene has no string 'persona' field`);
      return;
    }
    if (!personaKeys.has(persona)) {
      orphans.push(`#${idx}: persona '${persona}' not in personas keys (${[...personaKeys].join(', ') || '<empty>'})`);
    }
  });
  if (orphans.length === 0) return { pass: true };
  return {
    pass: false,
    detail: `scene persona key(s) unresolvable: ${orphans.slice(0, 5).join(' | ')}${orphans.length > 5 ? ` (+${orphans.length - 5} more)` : ''}`,
    auto_fix_hint:
      `every scenes[].persona must match a key in the top-level personas mapping. ` +
      `Either fix the scene's persona key to match an existing persona, or add the persona to the personas: mapping.`,
  };
}

/** Check 5: each ai_quality assertion is non-trivial / falsifiable. */
export function checkAiQualityAssertionsFalsifiable(text: string): QACheckResult {
  const m = getParsed(text);
  if (!m) return { pass: true, detail: 'spec unparseable; check skipped' };
  const scenes = m.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return { pass: true, detail: 'scenes empty/missing; deferred to scenes_array_well_formed' };
  }
  const trivial: string[] = [];
  scenes.forEach((s, idx) => {
    const aq = (s as Record<string, unknown>)?.ai_quality;
    if (typeof aq !== 'string') {
      // Caught by check 3; skip here.
      return;
    }
    const normalized = aq.trim().toLowerCase().replace(/[.!?]+$/, '');
    if (normalized.length < 12) {
      trivial.push(`#${idx}: too short (${normalized.length} chars)`);
      return;
    }
    if (TRIVIAL_AI_QUALITY.has(normalized)) {
      trivial.push(`#${idx}: trivial phrase '${aq.trim()}'`);
    }
  });
  if (trivial.length === 0) return { pass: true };
  return {
    pass: false,
    detail: `ai_quality assertion(s) not falsifiable: ${trivial.slice(0, 5).join(' | ')}${trivial.length > 5 ? ` (+${trivial.length - 5} more)` : ''}`,
    auto_fix_hint:
      `rewrite each flagged ai_quality assertion to be falsifiable — name what an AI judge should look for (a number, a named element, a threshold). ` +
      `Examples: "KPI panel must show ≥3 named FLWs with archetype labels visible", "anomaly callout must reference a specific FLW + week from the manifest". ` +
      `Generic "looks good" / "is correct" / "TBD" phrases fail the eval (Stage 4) anyway.`,
  };
}

/** Check 6: each persona has a non-empty `intro` field (canopy uses for scoring rubric anchoring). */
export function checkPersonaPainPointsDocumented(text: string): QACheckResult {
  const m = getParsed(text);
  if (!m) return { pass: true, detail: 'spec unparseable; check skipped' };
  const personas = m.personas;
  if (!personas || typeof personas !== 'object' || Array.isArray(personas)) {
    return { pass: true, detail: 'personas missing/malformed; deferred to required_top_level_keys' };
  }
  const entries = Object.entries(personas as Record<string, unknown>);
  if (entries.length === 0) {
    return {
      pass: false,
      detail: 'personas mapping is empty',
      auto_fix_hint: 'add at least one persona under personas: with an `intro` field describing the persona',
    };
  }
  const missing: string[] = [];
  for (const [key, val] of entries) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) {
      missing.push(`${key}: not an object`);
      continue;
    }
    const intro = (val as Record<string, unknown>).intro;
    if (typeof intro !== 'string' || intro.trim().length === 0) {
      missing.push(`${key}: missing or empty 'intro'`);
    }
  }
  if (missing.length === 0) return { pass: true, detail: `${entries.length} persona(s) intros populated` };
  return {
    pass: false,
    detail: `personas missing intros: ${missing.join(', ')}`,
    auto_fix_hint:
      `populate personas[<key>].intro with one sentence describing the persona's perspective and what they care about (their pain points / priorities). ` +
      `canopy:walkthrough uses this for scoring-rubric anchoring; without it, scene scoring lacks per-persona context.`,
  };
}

/** Check 7: scenes[].title values are unique across the spec. */
export function checkSceneTitlesUnique(text: string): QACheckResult {
  const m = getParsed(text);
  if (!m) return { pass: true, detail: 'spec unparseable; check skipped' };
  const scenes = m.scenes;
  if (!Array.isArray(scenes)) return { pass: true, detail: 'scenes not an array; deferred' };
  const seen = new Map<string, number[]>();
  scenes.forEach((s, idx) => {
    const t = (s as Record<string, unknown>)?.title;
    if (typeof t !== 'string' || !t.trim()) return; // caught by check 3
    const key = t.trim();
    const existing = seen.get(key);
    if (existing) {
      existing.push(idx);
    } else {
      seen.set(key, [idx]);
    }
  });
  const collisions: string[] = [];
  for (const [title, indices] of seen) {
    if (indices.length > 1) {
      collisions.push(`'${title}' appears at scenes #${indices.join(', #')}`);
    }
  }
  if (collisions.length === 0) return { pass: true, detail: `${seen.size} unique scene title(s)` };
  return {
    pass: false,
    detail: `duplicate scene title(s): ${collisions.join(' | ')}`,
    auto_fix_hint:
      `rename colliding scene titles so each is unique. canopy derives screenshot filenames from scene titles; collisions cause the slideshow to overwrite captures and confuse the score table.`,
  };
}

// ── Canonical CHECKS array ────────────────────────────────────────

/**
 * Ordered list of static checks synthetic-walkthrough-spec-qa runs.
 * The `id` of each check matches the row in
 * skills/synthetic-walkthrough-spec-qa/SKILL.md `## Checks` table.
 */
export const CHECKS: QACheck[] = [
  {
    id: 'spec_yaml_parses',
    type: 'static',
    description: 'Spec file parses as a YAML mapping',
    run: checkSpecYamlParses,
  },
  {
    id: 'required_top_level_keys',
    type: 'static',
    description: 'Required top-level keys present (name, narrative, base_url, auth, personas, scenes)',
    run: checkRequiredTopLevelKeys,
  },
  {
    id: 'scenes_array_well_formed',
    type: 'static',
    description: `scenes is an array of ≥${MIN_SCENES}; each has persona, title, show, impressive_because (ai_quality optional)`,
    run: checkScenesArrayWellFormed,
  },
  {
    id: 'scene_personas_resolvable',
    type: 'static',
    description: 'every scenes[].persona matches a key in personas',
    run: checkScenePersonasResolvable,
  },
  {
    id: 'ai_quality_assertions_falsifiable',
    type: 'static',
    description: 'each scene ai_quality assertion is non-trivial (not "looks good" / "TBD")',
    run: checkAiQualityAssertionsFalsifiable,
  },
  {
    id: 'persona_pain_points_documented',
    type: 'static',
    description: 'each persona has a non-empty intro field (canopy scoring-rubric anchor)',
    run: checkPersonaPainPointsDocumented,
  },
  {
    id: 'scene_titles_unique',
    type: 'static',
    description: 'scene titles are unique across the spec (canopy derives screenshot filenames from titles)',
    run: checkSceneTitlesUnique,
  },
];
