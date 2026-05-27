/**
 * Recipe provenance — embed `ace_version` + `selector_map_sha` in
 * generated Phase 3 journey recipes so Phase 6 can detect stale
 * Drive artifacts before AVD wall-clock burns.
 *
 * Class-level finding from `docs/learnings/2026-05-14-phase6-validation-arc.md`:
 * when a code change renames a logical selector or restructures a
 * recipe pattern, every previously-generated journey recipe on Drive
 * is silently stale. Retry #3 of the 2026-05-14 arc lost a full
 * Phase 6 dispatch to a mechanical rename that needed Drive
 * regeneration.
 *
 * The fix: the recipe header carries `selector_map_sha` (sha-256 of
 * the active selector YAML, truncated to 12 hex chars). Phase 6's
 * pre-flight reads the header, recomputes the current map sha, and
 * refuses to run if they differ — pointing the operator at the
 * "regenerate recipes" remedy.
 *
 * Header shape is a YAML comment block so Maestro's parser ignores it
 * entirely. Static palette recipes don't need provenance (they're
 * checked in and guarded by `static-palette-health.test.ts`); only
 * generated journey recipes get this header. Recipes with no header
 * are treated as legacy and pass freshness validation (opt-in based
 * on header presence — never breaks pre-provenance callers).
 */
import * as crypto from 'node:crypto';

export interface RecipeProvenance {
  ace_version: string;
  selector_map_sha: string;
  selector_map_apk_version: string;
  /** ISO 8601 — when this recipe was emitted by the generator. */
  generated_at: string;
}

const HEADER_PREFIX = '# ACE Recipe Provenance — do not edit by hand';

const HEADER_FIELDS: (keyof RecipeProvenance)[] = [
  'ace_version',
  'selector_map_sha',
  'selector_map_apk_version',
  'generated_at',
];

export function buildRecipeProvenanceHeader(p: RecipeProvenance): string {
  const lines = [HEADER_PREFIX];
  for (const k of HEADER_FIELDS) lines.push(`# ${k}: ${p[k]}`);
  lines.push(''); // blank line — user content lands cleanly below
  lines.push(''); // trailing newline
  return lines.join('\n');
}

/**
 * Parse the provenance header out of a recipe YAML. Returns undefined
 * when no header is present (legacy recipes) or any required field
 * is missing. Tolerant of extra whitespace in field values.
 */
export function parseRecipeProvenance(
  yamlText: string,
): RecipeProvenance | undefined {
  const lines = yamlText.split('\n').slice(0, 20);
  if (lines.length === 0 || !lines[0].startsWith(HEADER_PREFIX.slice(0, 24))) {
    return undefined;
  }
  const out: Partial<RecipeProvenance> = {};
  for (const line of lines) {
    if (!line.startsWith('#')) continue;
    const m = line.match(/^#\s+([a-z_]+):\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1] as keyof RecipeProvenance;
    if (HEADER_FIELDS.includes(key)) {
      out[key] = m[2];
    }
  }
  for (const k of HEADER_FIELDS) {
    if (typeof out[k] !== 'string' || out[k]!.length === 0) return undefined;
  }
  return out as RecipeProvenance;
}

/**
 * Compute a stable short hash of the selector map YAML. SHA-256
 * truncated to 12 hex chars — collision probability is ~1 in 2^48 for
 * a single accidental near-match; far below any realistic drift rate
 * (selector maps change a few times per release at most).
 */
export function computeSelectorMapSha(yamlText: string): string {
  return crypto
    .createHash('sha256')
    .update(yamlText)
    .digest('hex')
    .slice(0, 12);
}

export type FreshnessVerdict =
  | { ok: true; provenance: RecipeProvenance | undefined }
  | { ok: false; reason: string; provenance: RecipeProvenance | undefined };

/**
 * Check whether a recipe is fresh against the currently-active
 * selector map.
 *
 * Returns `ok: true` when:
 *   - the recipe has no provenance header (legacy), OR
 *   - the recipe's `selector_map_sha` matches `currentSelectorMapSha`
 *     AND `selector_map_apk_version` matches `currentApkVersion`.
 *
 * Returns `ok: false` with a `reason` string the pre-flight gate can
 * surface to the operator when either mismatches.
 */
export function validateRecipeFreshness(args: {
  recipeText: string;
  currentSelectorMapSha: string;
  currentApkVersion: string;
}): FreshnessVerdict {
  const provenance = parseRecipeProvenance(args.recipeText);
  if (!provenance) return { ok: true, provenance: undefined };

  if (provenance.selector_map_sha !== args.currentSelectorMapSha) {
    return {
      ok: false,
      reason:
        `selector_map_sha mismatch: recipe was generated against ` +
        `${provenance.selector_map_sha} but the current map is ` +
        `${args.currentSelectorMapSha}. Regenerate via /ace:step app-test-cases.`,
      provenance,
    };
  }
  if (provenance.selector_map_apk_version !== args.currentApkVersion) {
    return {
      ok: false,
      reason:
        `selector_map_apk_version mismatch: recipe targets ` +
        `${provenance.selector_map_apk_version} but the current map is ` +
        `${args.currentApkVersion}.`,
      provenance,
    };
  }
  return { ok: true, provenance };
}
