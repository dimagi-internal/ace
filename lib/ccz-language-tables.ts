/**
 * dimagi-internal/ace#2292 — a released Deliver CCZ shipped ANOTHER
 * opportunity's language tables, and `app-release-qa` scored it 10.0 with 0
 * BLOCKERs across 24 gates.
 *
 * The released Deliver CCZ for `bednet-check-2-visit/20260908-1544` (HQ app
 * `a3359eaf446f498a80366e000a677a4a`, build `171996636b714bb09dee8779e7e83927`,
 * `connect-ace-prod`) unzipped to:
 *
 * ```
 * default/  en/  modules-0/  modules-1/  nya/  tum/
 * ```
 *
 * while its `suite.xml` declared two locales and `profile.ccpr` pinned one:
 *
 * ```xml
 * <locale language="default">
 * <locale language="en">
 * ```
 *
 * `nya/` and `tum/` were not a translation of this app. They were Spark FCAP's
 * programme, keyed to Spark's case model:
 *
 * ```
 * en:  app.display.name=Bednet Check Two-Visit Deliver app
 * nya: app.display.name=Spark FCAP — pulogalamu ya wothandizira wa mudzi
 * tum: app.display.name=Apu ya Mulongozgi wa Spark FCAP
 * ```
 *
 * 16 Spark-ish lines and ZERO bednet-ish lines in each of the two 50-line
 * tables. The Learn app of the same run was clean, so the residue is specific
 * to that Deliver HQ app id.
 *
 * ## Why this is a finding and not a halt
 *
 * The device is only ever offered the locales `suite.xml` DECLARES, so an
 * orphan table is unreachable to a worker: an FLW cannot select `nya`, and a
 * Phase 6 device walk renders English. That is why ace#2292 is labelled
 * `harness` and why this gate is loud rather than blocking.
 *
 * It is still a real defect, for two reasons the artifact makes plain. The PDD
 * for that run declares `working_language: en` and REFUSES to name a geography
 * — "inventing one would be fabricated context" — and Chichewa and Tumbuka are
 * Malawian languages, so this is the
 * `docs/learnings/2026-05-12-no-inferred-backstory.md` class arriving through a
 * build artifact instead of through prose. And it is latent rather than inert:
 * the moment a run resolves its deferred language question and declares a
 * working language, whichever rows already exist on that HQ app become
 * reachable — pre-populated with another programme's text over another
 * programme's case properties.
 *
 * ## Why a static CCZ check
 *
 * Both halves are deterministic set logic over an artifact `app-release-qa`
 * already downloads and unzips: the `<lang>/app_strings.txt` directories in the
 * zip, and the `<locale language="…">` rows in `suite.xml`. No device, no live
 * surface — the ace#1236 rule (structure whose ground truth is the artifact
 * belongs in a unit test, not a device run).
 *
 * ## Scope: detection only
 *
 * This module answers "does this CCZ ship a language table nothing wires up?"
 * It does NOT diagnose WHY. ace#2292's leading hypothesis — a recycled HQ app
 * whose language rows survive an in-place `upload_app_to_hq` — is explicitly
 * unconfirmed there, and confirming it needs the HQ app's own history. Piece 2
 * of that issue stays open; nothing here refuses an upload or acts on the
 * hypothesis.
 */

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
 * differing is what made ace#2292's cross-opportunity origin obvious on sight.
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
            : ' — an undeclared table naming a different programme is the ' +
              'ace#2292 cross-opportunity signature'),
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
    'they become reachable the moment this app declares a working language',
    '(dimagi-internal/ace#2292).',
    '',
  ];
  for (const f of audit.findings) {
    lines.push(`  [${f.severity === 'finding' ? 'FINDING' : 'SIGNAL'}] ${f.detail}`);
  }
  lines.push(
    '',
    'Check the orphan tables against the PDD\'s declared working language, record',
    'the orphan set as a Phase 3 residual, and do NOT hand-edit the zip. The cause',
    'is upstream of the artifact and is unconfirmed (ace#2292 piece 2).',
  );
  return lines.join('\n');
}
