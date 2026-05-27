// mcp/mobile/recipe-resolver.ts
//
// Selector placeholder + env-var resolution for Maestro recipes.
//
// Two things `mobile_run_recipe` must do before handing a recipe to
// Maestro that the runner used to NOT do — both surfaced as
// harness-gaps in turmeric run 20260513-2243 retry #5:
//
//   1. Resolve `${SELECTOR:logical-name}` placeholders against the
//      APK-specific selector map. Without this, Maestro receives the
//      literal placeholder string, falls through to text-regex
//      matching, and fails with a NaN/regex error. Was previously
//      only available via the `mobile_resolve_selectors` atom —
//      every caller had to remember to invoke it + write the
//      resolved file to disk.
//
//   2. Auto-inject `ACE_E2E_*` env vars (`PIN`, `PHONE`,
//      `BACKUP_CODE`, etc.) into Maestro's envVars dict from
//      `process.env`. Without this, recipes referencing `${PIN}`
//      get the literal string `${PIN}` typed into password fields.
//      Maestro reports the step COMPLETED — the failure manifests
//      downstream as a stale lockscreen assertion. Silent class.
//
// Class-level fix: both injections happen unconditionally inside
// `MobileClient.runRecipe`, before any caller-visible Maestro
// invocation. Caller-provided envVars still win on conflict —
// auto-injection only fills KEYS that the caller didn't already set.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { logInfo } from './logging.js';
import { computeSelectorMapSha } from '../../lib/recipe-provenance.js';

/** Static palette dir relative to this file. */
const STATIC_RECIPES_DIR = new URL('./recipes/static/', import.meta.url).pathname;

/** Selector-map dir relative to this file. */
const SELECTORS_DIR = new URL('./selectors/', import.meta.url).pathname;

/** ACE_E2E_* → Maestro envVars key mapping. */
const ACE_E2E_ENV_MAP: Record<string, string> = {
  PIN: 'ACE_E2E_PIN',
  PHONE: 'ACE_E2E_PHONE',
  PHONE_LOCAL: 'ACE_E2E_PHONE_LOCAL',
  COUNTRY_CODE: 'ACE_E2E_COUNTRY_CODE',
  BACKUP_CODE: 'ACE_E2E_BACKUP_CODE',
  NAME: 'ACE_E2E_NAME',
};

/**
 * Read the active selector map file for an APK version and compute
 * its stable short SHA. Used by both the generator (stamps recipes
 * with selector_map_sha at write time) and the pre-flight gate
 * (rejects recipes whose stamped SHA differs from the current map).
 *
 * Returns the absolute file path alongside the SHA so callers can
 * surface a useful operator message ("the map at <path> hashes to
 * <sha>"). Throws if the file is missing — that's a fatal config
 * error, not a fall-through to "no provenance."
 */
export function getActiveSelectorMapMetadata(apkVersion: string): {
  path: string;
  sha: string;
  apkVersion: string;
} {
  const selectorPath = path.join(SELECTORS_DIR, `connect-${apkVersion}.yaml`);
  if (!fs.existsSync(selectorPath)) {
    throw new Error(`selector map not found: ${selectorPath}`);
  }
  const body = fs.readFileSync(selectorPath, 'utf8');
  return {
    path: selectorPath,
    sha: computeSelectorMapSha(body),
    apkVersion,
  };
}

/** Outcome of resolving a single recipe YAML body. */
export interface SelectorResolution {
  /** The resolved YAML — every `${SELECTOR:...}` replaced with the matching matcher block. */
  yaml: string;
  /** Placeholders that didn't match any entry in the selector map. Non-empty = recipe will fail. */
  unresolved: string[];
  /** Placeholders that resolved but the map flags the entry as `unverified: true`. Warning, not error. */
  unverified: string[];
  /** The apk_version field from the loaded selector map. */
  apkVersion: string;
  /** Absolute path to the selector map file used. */
  sourceMap: string;
}

interface SelectorEntry {
  type: 'id' | 'text' | 'point';
  value: string;
  unverified?: boolean;
  purpose?: string;
}

interface SelectorMap {
  apk_version: string;
  selectors: Record<string, SelectorEntry>;
}

/**
 * Resolve `${SELECTOR:logical-name}` placeholders in a YAML body.
 * Pure function — no filesystem writes, no side effects.
 *
 * The atom at `mcp/mobile-server.ts` § mobile_resolve_selectors uses
 * this helper too — single source of truth for the resolution logic.
 */
export function resolveSelectorsInYaml(
  yaml: string,
  apkVersion: string,
): SelectorResolution {
  const selectorPath = path.join(SELECTORS_DIR, `connect-${apkVersion}.yaml`);
  if (!fs.existsSync(selectorPath)) {
    throw new Error(`selector map not found: ${selectorPath}`);
  }
  const map = parseYaml(fs.readFileSync(selectorPath, 'utf8')) as SelectorMap;
  if (!map.selectors) {
    throw new Error(`selector map at ${selectorPath} has no \`selectors\` block`);
  }

  const unresolved: string[] = [];
  const unverified: string[] = [];
  const re = /\$\{SELECTOR:([a-z0-9-]+)\}/g;
  const out = yaml.replace(re, (_m, name: string) => {
    const entry = map.selectors[name];
    if (!entry) {
      unresolved.push(name);
      return `# UNRESOLVED ${name}`;
    }
    if (entry.unverified) unverified.push(name);
    switch (entry.type) {
      case 'id':    return `id: "${entry.value}"`;
      case 'text':  return `text: "${entry.value}"`;
      case 'point': return `point: "${entry.value}"`;
      default:
        unresolved.push(name);
        return `# UNRESOLVED-TYPE ${name}`;
    }
  });

  return {
    yaml: out,
    unresolved,
    unverified,
    apkVersion: map.apk_version,
    sourceMap: selectorPath,
  };
}

/**
 * Build the envVars dict to pass to Maestro: caller-provided wins,
 * but `ACE_E2E_*` convenience vars from `process.env` auto-inject
 * when the caller didn't set the corresponding short name.
 *
 * Mapping (Maestro key → process.env source):
 *   PIN          ← ACE_E2E_PIN
 *   PHONE        ← ACE_E2E_PHONE
 *   PHONE_LOCAL  ← ACE_E2E_PHONE_LOCAL
 *   COUNTRY_CODE ← ACE_E2E_COUNTRY_CODE
 *   BACKUP_CODE  ← ACE_E2E_BACKUP_CODE
 *   NAME         ← ACE_E2E_NAME
 *
 * The short names match what static recipes have always used
 * (`${PIN}`, `${PHONE}`, etc.). Caller-provided values override
 * — e.g. a test recipe wanting a non-`+7426` phone can still pass
 * its own `PHONE` and the env-var auto-injection won't clobber it.
 */
export function injectAceEnvVars(
  caller: Record<string, string>,
): Record<string, string> {
  const out = { ...caller };
  for (const [maestroKey, envKey] of Object.entries(ACE_E2E_ENV_MAP)) {
    if (!(maestroKey in out)) {
      const v = process.env[envKey];
      if (v) out[maestroKey] = v;
    }
  }
  return out;
}

/**
 * Prepare a recipe for Maestro by resolving placeholders in BOTH the
 * top-level recipe AND every file under `mcp/mobile/recipes/static/`
 * (which Maestro may `runFlow: file:` into).
 *
 * Strategy: copy + resolve every static palette file to a temp dir,
 * resolve the top-level recipe in place if it's already a sibling
 * of the temp dir OR copy it in too, return the path to the resolved
 * top-level recipe. Maestro's relative-path `runFlow: file:` refs
 * naturally resolve to the temp-dir sibling copies.
 *
 * Failure modes:
 *   - Selector map for `apkVersion` missing → throws.
 *   - Top-level recipe has unresolved placeholders → throws with
 *     the list of unresolved names so the caller can name the gap.
 *     Static palette files with unresolved placeholders log a WARN
 *     but don't fail-fast (they may be optional palette entries the
 *     top-level recipe never references).
 */
export async function prepareRecipeForMaestro(
  recipePath: string,
  apkVersion: string = '2.63.0',
): Promise<{
  resolvedPath: string;
  tempDir: string;
  unverifiedSelectorsInTop: string[];
}> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-recipe-'));

  // Resolve every static palette file. Catch + log on individual
  // failures so a malformed entry in the palette doesn't break runs
  // for recipes that don't even use the broken file.
  const paletteFiles = fs.existsSync(STATIC_RECIPES_DIR)
    ? fs.readdirSync(STATIC_RECIPES_DIR).filter((f) => f.endsWith('.yaml'))
    : [];
  for (const f of paletteFiles) {
    try {
      const body = fs.readFileSync(path.join(STATIC_RECIPES_DIR, f), 'utf8');
      const resolved = resolveSelectorsInYaml(body, apkVersion);
      fs.writeFileSync(path.join(tempDir, f), resolved.yaml, 'utf8');
      if (resolved.unresolved.length > 0) {
        logInfo(
          `recipe-resolver: ${f} has unresolved selectors ${JSON.stringify(resolved.unresolved)} — ` +
            `WARN (palette file, may not be referenced by the top-level recipe).`,
        );
      }
    } catch (err) {
      logInfo(`recipe-resolver: skipping palette file ${f}: ${(err as Error).message}`);
    }
  }

  // Resolve the top-level recipe and place it in temp dir.
  const topName = path.basename(recipePath);
  // Avoid name collision with a palette file of the same name.
  const resolvedTopName = paletteFiles.includes(topName) ? `__top_${topName}` : topName;
  const topBody = fs.readFileSync(recipePath, 'utf8');
  const resolvedTop = resolveSelectorsInYaml(topBody, apkVersion);
  if (resolvedTop.unresolved.length > 0) {
    throw new Error(
      `recipe-resolver: top-level recipe ${recipePath} has unresolved selectors: ${JSON.stringify(resolvedTop.unresolved)}. ` +
        `Selector map: ${resolvedTop.sourceMap}. ` +
        `Add the missing entries to the map or rename the placeholder; this fails closed rather than ` +
        `letting Maestro receive the literal placeholder text.`,
    );
  }
  fs.writeFileSync(path.join(tempDir, resolvedTopName), resolvedTop.yaml, 'utf8');

  return {
    resolvedPath: path.join(tempDir, resolvedTopName),
    tempDir,
    unverifiedSelectorsInTop: resolvedTop.unverified,
  };
}
