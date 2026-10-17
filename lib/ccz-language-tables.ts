/**
 * dimagi-internal/ace#2292 — does a released CCZ ship a language table that its
 * own `suite.xml` does not declare?
 *
 * ## What ace#2292 actually was (re-verified 2026-10-16)
 *
 * The issue reported that the released Deliver CCZ for
 * `bednet-check-2-visit/20260908-1544` (HQ app
 * `a3359eaf446f498a80366e000a677a4a`, build `171996636b714bb09dee8779e7e83927`,
 * `connect-ace-prod`) "unzipped to `default/ en/ modules-0/ modules-1/ nya/
 * tum/`", the last two carrying spark-facilitator's Chichewa/Tumbuka tables.
 *
 * **The CCZ never contained them.** Re-downloading that exact build and listing
 * the ZIP ENTRIES (not a directory on disk):
 *
 * ```
 * $ unzip -l deliver-v7.ccz            # 7 files, all stamped 09-09-2026 01:36
 *   default/app_strings.txt  en/app_strings.txt  profile.ccpr  media_suite.xml
 *   modules-0/forms-0.xml  modules-1/forms-0.xml  suite.xml
 * ```
 *
 * A released build's files are stored on the build doc at build time, so that
 * listing is the same artifact the issue read. The observation came from the
 * reproduction command itself — `unzip -o -q deliver.ccz && ls -d` — run in a
 * scratch directory that had already held an extracted spark-facilitator CCZ.
 * `unzip -o` overwrites the files a zip carries and leaves every other file in
 * place, so spark's `nya/` and `tum/` survived next to bednet's fresh `en/` and
 * `suite.xml`. That is exactly why they read as UNDECLARED: their own
 * `suite.xml` had just been overwritten. HQ writes `app_strings` tables and
 * `<locale>` rows from the same language list, so an undeclared table is not a
 * shape an HQ build produces; a reused extraction directory is. The captured
 * build is `test/fixtures/ccz/bednet-check-2-visit-20260908-1544-deliver-v7.ccz`.
 *
 * ## So this module reads the ZIP, not a directory
 *
 * `readCczTextFiles` builds the file map from the archive bytes in memory, so
 * the audit's input is the artifact and nothing else — no extraction
 * directory, no residue from an earlier build. Feed `auditCczLanguageTables`
 * from it. A file map assembled by walking a directory you `unzip -o`'d into is
 * how ace#2292 manufactured a cross-opportunity defect out of a clean build.
 *
 * ## Why the orphan check stays
 *
 * An undeclared table is unreachable to a worker (the device is only offered
 * the locales `suite.xml` declares), so it is a `[FINDING]`, not a halt. It is
 * kept as a cheap structural invariant over the artifact — not because a real
 * build has ever been seen to violate it.
 */

import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { type CheckOutcome, checked, formatUnable, unable } from './check-outcome';

/**
 * `<lang>/app_strings.txt` at the zip root. The language code is derived HERE,
 * from the in-zip path, rather than trusted from a caller-built map — the whole
 * finding is a set difference between two language-code sets, so both sides
 * have to be read off the artifact by the same rule.
 */
const LANG_TABLE_RE = /^([A-Za-z0-9_-]+)\/app_strings\.txt$/;

/**
 * `<locale language="…">` in `suite.xml`, ANY attribute order, open or
 * self-closing.
 *
 * Anchored on `language=` and not on `locale` alone on purpose: `suite.xml` is
 * FULL of `<locale id="m0.case_short.…"/>` reference nodes, and matching those
 * would read every locale REFERENCE as a locale DECLARATION and report the
 * declared set as enormous — which fails open, since orphans are what is
 * present-but-not-declared.
 */
const LOCALE_DECL_RE = /<locale\b[^>]*\blanguage="([^"]*)"[^>]*\/?>/g;

/** The key every CommCare app-strings table carries for the app's own name. */
const DISPLAY_NAME_KEY = 'app.display.name';

export type LanguageTableFindingKind = 'undeclared-language-table' | 'foreign-display-name';

/**
 * `finding` flips `ok`. `signal` does not — it is corroborating evidence a
 * human reads next to a finding.
 *
 * The split exists because a DECLARED language whose display name differs is
 * the normal shape of a genuinely translated app (Nova's i18n channel
 * translates the app name along with everything else), while an UNDECLARED one
 * differing points at a table from some other build (in ace#2292, a stale
 * extraction rather than the CCZ — see the module header).
 * Grading the first as a defect would fire on every correctly multilingual
 * build, so it is reported and not counted.
 */
export type LanguageTableSeverity = 'finding' | 'signal';

export interface LanguageTableFinding {
  kind: LanguageTableFindingKind;
  severity: LanguageTableSeverity;
  /** The language directory this is about, e.g. `nya`. */
  language: string;
  /** Whether `suite.xml` declares a `<locale language="…">` for it. */
  declared: boolean;
  /** `app.display.name` in that table, or null when the table carries none. */
  displayName: string | null;
  /** What `displayName` was compared against. Null on the orphan finding. */
  expectedName: string | null;
  /** One line an operator can act on. */
  detail: string;
}

export interface LanguageTableExtras {
  /** Every `<lang>/app_strings.txt` directory present in the zip, sorted. */
  present: string[];
  /** Every `<locale language="…">` declared in `suite.xml`, sorted. */
  declared: string[];
  /** Present in the zip, undeclared in `suite.xml` — the ace#2292 class. */
  orphans: string[];
  /**
   * Declared in `suite.xml` with no table in the zip. The INVERSE case, and
   * deliberately NOT an orphan: it is a different defect (a locale the device
   * is offered and cannot resolve) with a different owner, and folding it into
   * the orphan set would make the one number this gate reports mean two things.
   * Reported so it is visible; it does not flip `ok`.
   */
  missing: string[];
  /** language -> its `app.display.name`, null when the table carries none. */
  displayNames: Record<string, string | null>;
  /** The name every table was compared against, or null if none could be resolved. */
  referenceName: string | null;
  /**
   * Where `referenceName` came from: a language code, or null when the caller
   * supplied it directly (or nothing resolved).
   */
  referenceLanguage: string | null;
}

export type LanguageTableAudit = CheckOutcome<LanguageTableFinding, LanguageTableExtras>;

/** Text entries a CCZ audit reads: `profile.ccpr` and every `.txt` / `.xml`. */
const TEXT_ENTRY_RE = /(?:^|\/)profile\.ccpr$|\.(?:txt|xml)$/;

/**
 * The CCZ's text entries as in-zip path -> text, read from the archive bytes
 * in memory (ace#2292). Directory entries and binaries (media) are skipped.
 *
 * This is the input `auditCczLanguageTables` is meant to receive. It cannot see
 * anything the archive does not carry — which a directory listing after
 * `unzip -o` into a reused scratch directory can, and did.
 */
export function readCczTextFiles(ccz: Uint8Array | string): Record<string, string> {
  const bytes = typeof ccz === 'string' ? new Uint8Array(readFileSync(ccz)) : ccz;
  const entries = unzipSync(bytes, { filter: (f) => TEXT_ENTRY_RE.test(f.name) });
  const out: Record<string, string> = {};
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue;
    out[name] = strFromU8(data);
  }
  return out;
}

/** Every `<locale language="…">` declared in a suite. */
export function declaredLocales(suiteXml: string): string[] {
  const out = new Set<string>();
  for (const m of suiteXml.matchAll(LOCALE_DECL_RE)) {
    const lang = m[1].trim();
    if (lang) out.add(lang);
  }
  return [...out].sort();
}

/**
 * Every `<lang>/app_strings.txt` in an unzipped CCZ, language code -> raw text.
 *
 * A leading `./` is tolerated because zip listings carry it inconsistently;
 * anything else (form XMLs, `profile.ccpr`, media) is ignored, so the caller
 * can hand over the whole file map without pre-filtering it.
 */
export function languageTables(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawPath, text] of Object.entries(files)) {
    const path = rawPath.replace(/^\.\//, '');
    const m = LANG_TABLE_RE.exec(path);
    if (m) out[m[1]] = text;
  }
  return out;
}

/** `app.display.name` out of one table's text, or null when it carries none. */
export function appDisplayName(appStrings: string): string | null {
  for (const line of appStrings.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    if (line.slice(0, eq).trim() !== DISPLAY_NAME_KEY) continue;
    return line.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Audit one released CCZ's language tables against the locales its own
 * `suite.xml` declares.
 *
 * @param input.suiteXml  `suite.xml` from the zip root.
 * @param input.files     The unzipped CCZ as in-zip path -> text. Binary
 *                        entries may be omitted; only `<lang>/app_strings.txt`
 *                        is read.
 * @param input.appName   Optional — the app's name from the deploy summary or
 *                        Nova blueprint. When absent the reference is the
 *                        display name of the app's own primary declared table
 *                        (`en`, else `default`, else the first declared one
 *                        present), which keeps the check self-contained.
 */
export function auditCczLanguageTables(input: {
  suiteXml: string;
  files: Record<string, string>;
  appName?: string;
}): LanguageTableAudit {
  const tables = languageTables(input.files);
  const present = Object.keys(tables).sort();
  const declared = declaredLocales(input.suiteXml);

  if (present.length === 0) {
    return unable(
      'this CCZ carries no <lang>/app_strings.txt table, so there is no ' +
        'language table to compare against suite.xml — if the zip you unzipped ' +
        'does have language directories, the file map handed to this check is ' +
        'the bug',
    );
  }

  // A suite that yields zero declarations cannot distinguish "every table is an
  // orphan" from "this parser did not read the suite". Reporting the first when
  // it is the second turns a broken read into a maximally loud false finding,
  // so refuse to answer instead. Every real released CCZ declares at least
  // `default`.
  if (declared.length === 0) {
    return unable(
      'suite.xml declares no <locale language="…">, so the declared set could ' +
        'not be established — a present-but-undeclared table is indistinguishable ' +
        'from a suite this check failed to read. Every released CCZ declares at ' +
        'least `default`, so treat an empty declared set as a parse failure',
    );
  }

  const declaredSet = new Set(declared);
  const orphans = present.filter((lang) => !declaredSet.has(lang));
  const missing = declared.filter((lang) => !(lang in tables));

  const displayNames: Record<string, string | null> = {};
  for (const lang of present) displayNames[lang] = appDisplayName(tables[lang]);

  // Reference: what the app calls itself. Prefer the caller's authority, then
  // the app's own primary declared table.
  let referenceName: string | null = input.appName?.trim() || null;
  let referenceLanguage: string | null = null;
  if (!referenceName) {
    const order = ['en', 'default', ...declared];
    for (const lang of order) {
      if (!declaredSet.has(lang)) continue;
      const name = displayNames[lang];
      if (name) {
        referenceName = name;
        referenceLanguage = lang;
        break;
      }
    }
  }

  const findings: LanguageTableFinding[] = [];

  for (const lang of orphans) {
    findings.push({
      kind: 'undeclared-language-table',
      severity: 'finding',
      language: lang,
      declared: false,
      displayName: displayNames[lang],
      expectedName: null,
      detail:
        `${lang}/app_strings.txt ships in the CCZ but suite.xml declares no ` +
        `<locale language="${lang}"> — the table is unwired, so the device is ` +
        `never offered it` +
        (displayNames[lang] ? ` (it calls the app "${displayNames[lang]}")` : ''),
    });
  }

  if (referenceName) {
    for (const lang of present) {
      const name = displayNames[lang];
      if (!name || name === referenceName) continue;
      const isDeclared = declaredSet.has(lang);
      findings.push({
        kind: 'foreign-display-name',
        severity: isDeclared ? 'signal' : 'finding',
        language: lang,
        declared: isDeclared,
        displayName: name,
        expectedName: referenceName,
        detail:
          `${lang}/app_strings.txt names the app "${name}", but this app is ` +
          `"${referenceName}"` +
          (isDeclared
            ? ' — expected for a genuinely translated language, reported so a ' +
              'foreign programme name is visible rather than silent'
            : ' — an undeclared table naming a different programme is what a ' +
              'reused extraction directory produces (ace#2292); confirm it is ' +
              'in the archive before treating it as the build'),
      });
    }
  }

  const ok = findings.every((f) => f.severity !== 'finding');
  return {
    ...checked(ok, findings),
    present,
    declared,
    orphans,
    missing,
    displayNames,
    referenceName,
    referenceLanguage,
  };
}

/**
 * Human-readable gate output. Leads with the orphan set, because the list of
 * language codes is the thing an operator can check against the PDD's declared
 * working language in one glance.
 */
export function formatCczLanguageTables(audit: LanguageTableAudit, appLabel: string): string {
  if (audit.status === 'unable') {
    return formatUnable(`ccz-language-tables (${appLabel})`, audit.reason);
  }

  const tail = audit.missing.length
    ? `; declared with no table in the zip: ${audit.missing.join(', ')}`
    : '';

  if (audit.ok) {
    const signals = audit.findings.filter((f) => f.severity === 'signal');
    const lines = [
      `[PASS] ccz-language-tables (${appLabel}): every language table in the zip ` +
        `is declared in suite.xml (${audit.present.join(', ')})${tail}.`,
    ];
    for (const s of signals) lines.push(`  [SIGNAL] ${s.detail}`);
    return lines.join('\n');
  }

  const lines = [
    `[FINDING] ccz-language-tables (${appLabel}): ${audit.orphans.length} language ` +
      `table(s) ship in the CCZ that suite.xml does not declare — ` +
      `${audit.orphans.join(', ')}${tail}.`,
    '',
    'Not a halt: the device is only ever offered the locales suite.xml declares,',
    'so an orphan table is unreachable to a worker and the English device walk is',
    'unaffected. It is still wrong — the strings belong to some other build, and',
    'they become reachable the moment this app declares a working language.',
    '',
  ];
  for (const f of audit.findings) {
    lines.push(`  [${f.severity === 'finding' ? 'FINDING' : 'SIGNAL'}] ${f.detail}`);
  }
  lines.push(
    '',
    'First confirm the orphan is IN THE ARCHIVE: build the file map with',
    'readCczTextFiles (or read `unzip -l`), never from a directory you unzip -o\'d',
    'into — ace#2292\'s orphans were residue of an earlier extraction, not the',
    'build. If it is real, record it as a Phase 3 residual; do NOT hand-edit the zip.',
  );
  return lines.join('\n');
}
