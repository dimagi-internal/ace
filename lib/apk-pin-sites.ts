/**
 * dimagi-internal/ace — APK pin-site discovery.
 *
 * The Connect/CommCare APK version is pinned in more than one place, and the
 * operator's complaint that produced this module was precise: *"we had a lot of
 * gotchas last time we upgraded because I didn't do an explicit update-version
 * step."* The failure mode is not "the bump was wrong" — it is **"I forgot a
 * knob."** A checklist fixes that exactly once; the first time someone adds a
 * fourth pin site the checklist is silently incomplete again and nothing says so.
 *
 * So the checklist is not the preventer. THIS is: a discovery pass over the
 * repo that finds every place an APK version is written down, plus a `suspect`
 * scan that flags any APK-shaped version literal the discovery does NOT
 * classify. `test/lib/apk-pin-sites.test.ts` fails when either one finds
 * something `skills/connect-apk-upgrade/SKILL.md` does not name.
 *
 * Class-level preventer per CLAUDE.md § Conventions: the checklist can no
 * longer rot without CI saying so.
 *
 * ## Kinds, and why they are not all the same obligation
 *
 * | kind                    | obligation on an upgrade |
 * |-------------------------|--------------------------|
 * | `pin`                   | MUST flip to the new version, in the same commit as every other `pin` |
 * | `map-self-declaration`  | belongs to its own file (`connect-<v>.yaml` declares `<v>`); a NEW map declares the NEW version |
 * | `doc-claim`             | prose asserting what the default IS — MUST flip, or it lies |
 * | `doc-example`           | an illustrative snippet (a manifest sample); review it, but it may legitimately lag |
 *
 * Conflating these is how a mechanical "replace 2.63.2 with 2.64.0" both
 * rewrites history (the 2.62.0 selector map) and misses prose.
 *
 * Version comparison is NOT this module's job — `lib/ccz-min-version.ts` owns
 * `parseVersionTriple` / `compareVersionTriples`, and callers that need to
 * order versions must use those. `'2.64.0' < '2.9.0'` as strings.
 *
 * ## Evidence class
 *
 * STATIC TEXT SCANNING. Nothing here is sent to, or matched against, a device
 * — no selector, no coordinate, no recipe step order. Unit tests are complete
 * evidence (CLAUDE.md § the trigger is the CLAIM, not the directory).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export type ApkPinKind = 'pin' | 'map-self-declaration' | 'doc-claim' | 'doc-example';

export interface ApkPinSite {
  /** Repo-relative path, always with `/` separators. */
  path: string;
  /** 1-based line number. */
  line: number;
  kind: ApkPinKind;
  /** The version literal found at this site. */
  version: string;
  /** Which syntactic form matched — the handle a new pin form must be added under. */
  form: string;
  /** The matched line, trimmed and capped, for a legible failure message. */
  snippet: string;
}

export interface ApkPinSuspect {
  path: string;
  line: number;
  version: string;
  snippet: string;
}

interface PinForm {
  name: string;
  kind: ApkPinKind;
  re: RegExp;
}

/**
 * Every syntactic form in which ACE pins (or asserts) an APK version.
 *
 * Adding a pin in a NEW syntax is exactly the event this module exists to
 * catch: the suspect scan will flag it as unclassified, the test will fail,
 * and the fix is to add a form here AND a row to the skill's checklist.
 */
export const PIN_FORMS: readonly PinForm[] = [
  // `export const DEFAULT_APK_VERSION = '2.63.2';`  (mcp/mobile/client.ts)
  { name: 'code-default-const', kind: 'pin', re: /export const DEFAULT_APK_VERSION\s*=\s*'([\d.]+)'/ },
  // `apkVersion: string = '2.63.2',`                (mcp/mobile/recipe-resolver.ts)
  { name: 'default-parameter', kind: 'pin', re: /\bapkVersion\s*:\s*string\s*=\s*'([\d.]+)'/ },
  // `apkVersion: z.string().default('2.63.2')`      (mcp/mobile-server.ts, twice)
  { name: 'zod-schema-default', kind: 'pin', re: /\bapkVersion\s*:\s*z\.string\(\)\.default\('([\d.]+)'\)/ },
  // `process.env.ACE_CONNECT_APK_VERSION || '2.63.2'` (scripts/probe-atlas-drift.ts)
  { name: 'env-fallback', kind: 'pin', re: /ACE_CONNECT_APK_VERSION\s*(?:\|\||\?\?)\s*'([\d.]+)'/ },
  // `ACE_CONNECT_APK_VERSION=2.63.2`                (.env.tpl)
  { name: 'env-tpl-pin', kind: 'pin', re: /^ACE_CONNECT_APK_VERSION=([\d.]+)\s*$/ },
  // `apk_version: "2.63.2"`                         (mcp/mobile/selectors/connect-<v>.yaml)
  { name: 'selector-map-self-declaration', kind: 'map-self-declaration', re: /^apk_version:\s*"([\d.]+)"/ },
  // `(default APK 2.63.2)`                          (CLAUDE.md)
  { name: 'prose-default-apk', kind: 'doc-claim', re: /default APK ([\d.]+)/ },
  // ``ACE_CONNECT_APK_VERSION` (default 2.63.2)`    (playbook/integrations/mobile-integration.md)
  { name: 'prose-default-paren', kind: 'doc-claim', re: /ACE_CONNECT_APK_VERSION`?\s*\(default ([\d.]+)\)/ },
  // `connect_apk_version: "2.63.0"`                 (screenshot-manifest examples in skill prose)
  { name: 'manifest-example', kind: 'doc-example', re: /^connect_apk_version:\s*"([\d.]+)"/ },
];

/**
 * An APK-shaped version literal in code. Deliberately NARROWER than
 * {@link PIN_FORMS} — it only fires on identifiers a pin would actually use,
 * so prose that merely mentions a version does not trip it.
 */
const SUSPECT_RE = /(DEFAULT_APK|APK_VERSION|apkVersion|apk_version)[\s\S]{0,60}?['"=]\s*(\d+\.\d+\.\d+)/;

/**
 * Directories whose FILENAMES are keyed by APK version. These are artifact
 * FAMILIES, not pins: an upgrade ADDS a member, it never rewrites the existing
 * ones (back-copying a calibrated row into an older map is the exact
 * anti-pattern CLAUDE.md § close the loop to the source of truth forbids).
 */
export const VERSION_KEYED_ARTIFACT_DIRS: readonly string[] = [
  'mcp/mobile/selectors', // connect-<v>.yaml — the selector map
  'docs/mobile-atlas', // connect-<v>.md — the surface atlas
];

/** Roots the scan walks. `docs/` and `test/` are deliberately excluded. */
const SCAN_ROOTS: readonly string[] = [
  'mcp',
  'lib',
  'bin',
  'scripts',
  'commands',
  'agents',
  'skills',
  'playbook',
  'hooks',
  'templates',
];

/** Single files outside any scanned root. */
const SCAN_FILES: readonly string[] = ['.env.tpl', 'runtime.yaml', 'CLAUDE.md'];

/**
 * This module's own source is excluded: its doc comments quote every pin form
 * verbatim (that is what makes them readable), so scanning itself reports its
 * own documentation as pins. Self-exclusion, not an exemption — nothing in
 * here is loaded at runtime by the mobile stack.
 */
const SELF_EXCLUDED: readonly string[] = ['lib/apk-pin-sites.ts'];

const SCAN_EXTENSIONS = ['.ts', '.js', '.mjs', '.cjs', '.sh', '.yaml', '.yml', '.md', '.tpl', '.json', '.py'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'tmp', 'evidence']);

function isScannable(path: string): boolean {
  // bin/ ships extensionless executables (`bin/ace-doctor`) — scan those too.
  if (path.startsWith('bin/') && !path.includes('.')) return true;
  return SCAN_EXTENSIONS.some((ext) => path.endsWith(ext));
}

function walk(root: string, dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    const rel = relative(root, abs).split(sep).join('/');
    if (st.isDirectory()) walk(root, abs, out);
    else if (st.isFile() && isScannable(rel)) out.push(rel);
  }
}

/** Repo-relative paths this module scans. Exported so a test can assert coverage. */
export function scannableFiles(repoRoot: string): string[] {
  const out: string[] = [];
  for (const r of SCAN_ROOTS) walk(repoRoot, join(repoRoot, r), out);
  for (const f of SCAN_FILES) {
    try {
      if (statSync(join(repoRoot, f)).isFile()) out.push(f);
    } catch {
      /* absent is fine */
    }
  }
  return out.filter((p) => !SELF_EXCLUDED.includes(p)).sort();
}

const cap = (s: string) => (s.length > 160 ? `${s.slice(0, 157)}...` : s);

/**
 * Classify one file's contents. Pure — takes text, not a path on disk, so the
 * unit tests exercise the forms without a fixture tree.
 */
export function findPinSitesInText(path: string, text: string): ApkPinSite[] {
  const out: ApkPinSite[] = [];
  text.split('\n').forEach((raw, i) => {
    for (const form of PIN_FORMS) {
      const m = form.re.exec(raw);
      if (!m) continue;
      out.push({
        path,
        line: i + 1,
        kind: form.kind,
        version: m[1],
        form: form.name,
        snippet: cap(raw.trim()),
      });
    }
  });
  return out;
}

/**
 * Lines that LOOK like a code-level APK pin but that no form in
 * {@link PIN_FORMS} classified. A non-empty result means someone introduced a
 * pin in a syntax this module has never seen — the "I forgot a knob" event.
 */
export function findPinSuspectsInText(path: string, text: string): ApkPinSuspect[] {
  const out: ApkPinSuspect[] = [];
  text.split('\n').forEach((raw, i) => {
    const m = SUSPECT_RE.exec(raw);
    if (!m) return;
    if (PIN_FORMS.some((f) => f.re.test(raw))) return; // already classified
    out.push({ path, line: i + 1, version: m[2], snippet: cap(raw.trim()) });
  });
  return out;
}

export interface ApkPinScan {
  sites: ApkPinSite[];
  suspects: ApkPinSuspect[];
  /** Repo-relative paths that carry at least one site or suspect. */
  files: string[];
}

/** Walk the repo and classify every APK version literal it writes down. */
export function scanApkPinSites(repoRoot: string): ApkPinScan {
  const sites: ApkPinSite[] = [];
  const suspects: ApkPinSuspect[] = [];
  for (const rel of scannableFiles(repoRoot)) {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, rel), 'utf-8');
    } catch {
      continue;
    }
    sites.push(...findPinSitesInText(rel, text));
    suspects.push(...findPinSuspectsInText(rel, text));
  }
  const files = [...new Set([...sites.map((s) => s.path), ...suspects.map((s) => s.path)])].sort();
  return { sites, suspects, files };
}

/** The subset an upgrade MUST flip atomically. */
export function mustFlipSites(scan: ApkPinScan): ApkPinSite[] {
  return scan.sites.filter((s) => s.kind === 'pin' || s.kind === 'doc-claim');
}

/**
 * Files the upgrade checklist must name individually.
 *
 * Members of a {@link VERSION_KEYED_ARTIFACT_DIRS} family are deliberately
 * EXCLUDED: `connect-2.62.0.yaml` is a historical artifact, not a knob, and
 * requiring the checklist to list every past map would make it grow by one
 * dead line per upgrade — the opposite of a checklist that stays read. The
 * family DIRECTORY is what the checklist names, and a separate assertion
 * covers that.
 */
export function filesRequiringChecklistMention(scan: ApkPinScan): string[] {
  const inFamily = (p: string) => VERSION_KEYED_ARTIFACT_DIRS.some((d) => p.startsWith(`${d}/`));
  const paths = [
    ...scan.sites.filter((s) => !inFamily(s.path)).map((s) => s.path),
    ...scan.suspects.filter((s) => !inFamily(s.path)).map((s) => s.path),
  ];
  return [...new Set(paths)].sort();
}
