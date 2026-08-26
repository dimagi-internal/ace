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
import { MobileError } from './errors.js';
import { computeSelectorMapSha } from '../../lib/recipe-provenance.js';

/**
 * Static palette dir shipped INSIDE this plugin install, relative to
 * this file. The default; overridable via `ACE_MOBILE_STATIC_RECIPES_DIR`
 * (see `resolveStaticRecipesDir`).
 */
export const INSTALLED_STATIC_RECIPES_DIR = new URL('./recipes/static/', import.meta.url).pathname;

/** Env var that overrides the static palette dir. */
export const STATIC_RECIPES_DIR_ENV = 'ACE_MOBILE_STATIC_RECIPES_DIR';

/** Selector-map dir relative to this file. */
const SELECTORS_DIR = new URL('./selectors/', import.meta.url).pathname;

/**
 * Resolve the static palette dir in force, honouring
 * `ACE_MOBILE_STATIC_RECIPES_DIR`.
 *
 * **Why this exists (jjackson/ace#1062).** Three ACE rules used to be
 * mutually unsatisfiable for a `recipes/static/*.yaml` fix: the self-heal
 * gate demands a mobile recipe/selector fix be proven on a live device
 * BEFORE it merges; CLAUDE.md forbids writing into
 * `~/.claude/plugins/cache/`; and this module resolved every palette file
 * from the plugin's own install dir with no override. A caller who staged
 * a fixed palette elsewhere was SILENTLY ignored — on 2026-07-29 (#1058)
 * the Maestro trace showed the OLD blocks executing and the run read as a
 * failed fix. **A silently-ignored override is a false negative, not an
 * error**, which is why this function fails LOUD rather than falling back.
 *
 * Contract:
 *   - unset / empty → the install dir (production default, unchanged).
 *   - set → expanded (`~`, relative-to-cwd), validated, returned. A path
 *     that doesn't exist, isn't a directory, or holds no `.yaml` throws
 *     `MobileError('STATIC_RECIPES_DIR_INVALID')`. A typo must never
 *     degrade into "quietly used the install palette."
 *   - an unexpanded `${...}` placeholder also throws — Claude Code does
 *     not always expand env references (see `lib/plugin-data-dir.ts`),
 *     and a literal `${REPO}/mcp/...` would otherwise mkdir-miss into
 *     the same false negative.
 */
export function resolveStaticRecipesDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[STATIC_RECIPES_DIR_ENV];
  if (raw === undefined || raw.trim().length === 0) return INSTALLED_STATIC_RECIPES_DIR;

  const value = raw.trim();
  const fail = (reason: string): never => {
    throw new MobileError(
      'STATIC_RECIPES_DIR_INVALID',
      `${STATIC_RECIPES_DIR_ENV}=${JSON.stringify(raw)} is not a usable palette dir: ${reason}.`,
      `Point ${STATIC_RECIPES_DIR_ENV} at a directory containing the palette YAMLs ` +
        `(e.g. <repo>/mcp/mobile/recipes/static), or unset it to use the plugin's own ` +
        `palette at ${INSTALLED_STATIC_RECIPES_DIR}. This fails closed on purpose: a ` +
        `silently-ignored override reads as a failed fix (jjackson/ace#1062).`,
      { env_var: STATIC_RECIPES_DIR_ENV, value: raw, installed_dir: INSTALLED_STATIC_RECIPES_DIR },
    );
  };

  if (/\$\{|\$[A-Za-z_]/.test(value)) {
    fail('it still contains an unexpanded variable reference — expand it before exporting');
  }

  let expanded = value;
  if (expanded === '~') expanded = os.homedir();
  else if (expanded.startsWith('~/')) expanded = path.join(os.homedir(), expanded.slice(2));
  const abs = path.resolve(expanded);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return fail(`${abs} does not exist`);
  }
  if (!stat.isDirectory()) fail(`${abs} is not a directory`);
  if (!fs.readdirSync(abs).some((f) => f.endsWith('.yaml'))) {
    fail(`${abs} contains no .yaml palette files`);
  }
  // Trailing separator matches the install dir's shape (URL keeps it), so
  // callers that concatenate rather than `path.join` behave identically.
  return abs.endsWith(path.sep) ? abs : abs + path.sep;
}

/**
 * True when `dir` is NOT the palette shipped in this install — i.e. an
 * override is in force. Drives the loud log + the atom-result field, so a
 * validating operator can SEE that the staged palette won.
 */
export function isStaticRecipesDirOverride(dir: string): boolean {
  return path.resolve(dir) !== path.resolve(INSTALLED_STATIC_RECIPES_DIR);
}

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

/**
 * Load the `logical-name -> declared type` view of the active selector map.
 *
 * This is the only piece of the map `recipe-lint.ts` needs: the
 * `selector-value-position-type-mismatch` rule compares the KEY a recipe
 * wrote a value-position `"${SELECTOR:name}"` under against the `type:` the
 * map declares for `name` (dimagi-internal/ace#1690). Keeping the linter a
 * pure function means the map has to be injected, and this is the injector.
 *
 * Throws if the map file is missing — same contract as
 * `getActiveSelectorMapMetadata`; callers that want to degrade gracefully
 * (e.g. `mobile_validate_recipe` on an unknown APK) catch and abstain.
 */
export function loadSelectorTypes(
  apkVersion: string,
): Record<string, 'id' | 'text' | 'point'> {
  const selectorPath = path.join(SELECTORS_DIR, `connect-${apkVersion}.yaml`);
  if (!fs.existsSync(selectorPath)) {
    throw new Error(`selector map not found: ${selectorPath}`);
  }
  const map = parseYaml(fs.readFileSync(selectorPath, 'utf8')) as SelectorMap;
  if (!map || !map.selectors) {
    throw new Error(`selector map at ${selectorPath} has no \`selectors\` block`);
  }
  const out: Record<string, 'id' | 'text' | 'point'> = {};
  for (const [name, entry] of Object.entries(map.selectors)) {
    const t = entry?.type;
    if (t === 'id' || t === 'text' || t === 'point') out[name] = t;
  }
  return out;
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

  // Two placeholder forms, resolved in this order:
  //
  //   1. VALUE position — `"${SELECTOR:name}"` (placeholder inside double
  //      quotes, occupying a matcher's value). Resolves to just the bare
  //      `"<value>"`, leaving the surrounding `id:` / `text:` key the
  //      recipe author wrote intact. This form is raw-YAML-valid even
  //      beside `below:` / `childOf:` siblings (the `:` in `SELECTOR:name`
  //      lives inside a quoted string), so it is the form to use for
  //      card-scoped matchers like
  //      `id: "${SELECTOR:opp-list-resume-button}"\n  below:\n    text: ${OPP_NAME}`.
  //      (jjackson/ace#650 — the key-position form below cannot express
  //      scoped matchers without producing raw-invalid YAML.)
  //
  //   2. KEY position — bare `${SELECTOR:name}` on its own. Resolves to
  //      the full `id: "<value>"` / `text: "<value>"` / `point: "<value>"`
  //      matcher key+value. The original form; only raw-YAML-valid as a
  //      sole matcher (no sibling keys).
  //
  // Value position MUST run first: the key-position regex would otherwise
  // also match the bare token *inside* the quotes and corrupt it.
  const valueRe = /"\$\{SELECTOR:([a-z0-9-]+)\}"/g;
  const keyRe = /\$\{SELECTOR:([a-z0-9-]+)\}/g;

  let out = yaml.replace(valueRe, (_m, name: string) => {
    const entry = map.selectors[name];
    if (!entry) {
      unresolved.push(name);
      return `"# UNRESOLVED ${name}"`;
    }
    if (entry.unverified) unverified.push(name);
    if (entry.type === 'id' || entry.type === 'text' || entry.type === 'point') {
      return `"${entry.value}"`;
    }
    unresolved.push(name);
    return `"# UNRESOLVED-TYPE ${name}"`;
  });

  out = out.replace(keyRe, (_m, name: string) => {
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
 * top-level recipe AND every file under the static palette dir
 * (which Maestro may `runFlow: file:` into).
 *
 * The palette dir is `staticRecipesDir` when the caller passes one —
 * `MobileClient` always passes `this.staticRecipesDir`, so the client's
 * dir and this resolver's dir CANNOT disagree (the #1062 bug was exactly
 * that divergence) — otherwise `resolveStaticRecipesDir()`.
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
  apkVersion: string = '2.63.2',
  staticRecipesDir?: string,
): Promise<{
  resolvedPath: string;
  tempDir: string;
  unverifiedSelectorsInTop: string[];
  paletteDir: string;
  paletteDirSource: 'install' | 'override';
}> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-recipe-'));
  const paletteDir = staticRecipesDir ?? resolveStaticRecipesDir();
  const paletteDirSource = isStaticRecipesDirOverride(paletteDir) ? 'override' : 'install';

  // LOUD signal when an override is in force. Silence is what made #1062
  // a false negative: the operator staged a fixed palette, it was ignored,
  // and the only evidence was buried in a Maestro trace. Now every run
  // states which palette it actually used.
  if (paletteDirSource === 'override') {
    logInfo(
      `recipe-resolver: palette dir OVERRIDE in force — using ${paletteDir} ` +
        `(via ${STATIC_RECIPES_DIR_ENV}) INSTEAD OF the plugin's own ` +
        `${INSTALLED_STATIC_RECIPES_DIR}. Every runFlow: file: ref resolves ` +
        `to the override's copies.`,
    );
  }

  // Resolve every static palette file. Catch + log on individual
  // failures so a malformed entry in the palette doesn't break runs
  // for recipes that don't even use the broken file.
  const paletteFiles = fs.existsSync(paletteDir)
    ? fs.readdirSync(paletteDir).filter((f) => f.endsWith('.yaml'))
    : [];
  for (const f of paletteFiles) {
    try {
      const body = fs.readFileSync(path.join(paletteDir, f), 'utf8');
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

  // Cheap hardening, independent of the override (jjackson/ace#1062):
  // if the top recipe has sibling palette YAMLs in its OWN directory that
  // the palette dir is about to shadow, say so. That is precisely the
  // #1058 shape — a caller stages a fixed palette next to its recipe and
  // assumes it wins. It doesn't; the palette dir does.
  const topDir = path.dirname(path.resolve(recipePath));
  if (path.resolve(topDir) !== path.resolve(paletteDir)) {
    let shadowed: string[] = [];
    try {
      shadowed = fs
        .readdirSync(topDir)
        .filter((f) => f.endsWith('.yaml') && f !== path.basename(recipePath) && paletteFiles.includes(f));
    } catch {
      /* unreadable sibling dir is not this function's problem */
    }
    if (shadowed.length > 0) {
      logInfo(
        `recipe-resolver: ${shadowed.length} sibling YAML(s) next to ${recipePath} ` +
          `are SHADOWED by the palette dir ${paletteDir} and will NOT be used: ` +
          `${JSON.stringify(shadowed)}. Staging a palette next to the recipe does not ` +
          `override the palette — set ${STATIC_RECIPES_DIR_ENV} instead ` +
          `(playbook/integrations/mobile-integration.md § Validating a palette fix pre-merge).`,
      );
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
    paletteDir,
    paletteDirSource,
  };
}
