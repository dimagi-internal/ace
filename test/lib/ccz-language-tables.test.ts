/**
 * dimagi-internal/ace#2292 — `bednet-check-2-visit/20260908-1544`'s released
 * Deliver CCZ shipped `nya/` and `tum/` app-strings tables full of
 * spark-facilitator's Chichewa/Tumbuka programme, and `app-release-qa` scored
 * that exact artifact 10.0 with 0 BLOCKERs across 24 gates.
 *
 * ## The fixtures
 *
 * The `suite.xml` locale rows, the four directory names and the three
 * `app.display.name` lines are VERBATIM from the issue's quoted `unzip` /
 * `grep` output against HQ app `a3359eaf446f498a80366e000a677a4a`, build
 * `171996636b714bb09dee8779e7e83927`. The rest of each table is a short slice
 * in the same shape (the real tables are 50 lines each) — the check reads only
 * the directory name and `app.display.name`, so the slice is complete for
 * everything under test.
 *
 * The clean case is the SAME run's Learn app (HQ app
 * `8088cfa86c5946858f7cd57b489afa0f`, build `77691900f3c04927902de67a55f0b246`),
 * which the issue confirms carries `default/ en/ modules-0/ modules-1/` and no
 * Spark strings. That pairing is what makes the suite a real negative/positive
 * control rather than one hand-built example: same run, same day, one
 * contaminated and one clean.
 *
 * ## Controls
 *
 * A gate that cannot fail proves nothing, and a gate that cannot pass is worse
 * than none. So: the contaminated Deliver MUST report `[nya, tum]`, the clean
 * Learn MUST report nothing, the INVERSE shape (declared with no table) must
 * NOT be laundered into the orphan set, and an input the check cannot read must
 * report `unable` — never a pass (`lib/check-outcome.ts`).
 */

import { describe, expect, it } from 'vitest';
import {
  appDisplayName,
  auditCczLanguageTables,
  declaredLocales,
  formatCczLanguageTables,
  languageTables,
} from '../../lib/ccz-language-tables';
import { assertChecked, assertUnable } from '../../lib/check-outcome';

/** Two declared locales — verbatim from the issue's `grep` over both suites. */
const SUITE_DEFAULT_EN = `<?xml version="1.0" encoding="UTF-8"?>
<suite version="1">
  <locale language="default">
    <resource id="app_strings.default">
      <location authority="local">./default/app_strings.txt</location>
    </resource>
  </locale>
  <locale language="en">
    <resource id="app_strings.en">
      <location authority="local">./en/app_strings.txt</location>
    </resource>
  </locale>
  <detail id="m0_case_short">
    <field>
      <template>
        <text><locale id="m0.case_short.case_household_state_1.enum.k1"/></text>
      </template>
    </field>
  </detail>
</suite>`;

const EN_BEDNET = `app.display.name=Bednet Check Two-Visit Deliver app
en=English
forms.m0f0=Household registration
homescreen.title=Bednet Check Two-Visit Deliver app
lang.current=en
m0.case_short.case_household_state_1.enum.k1=Registered, awaiting spot-check
m0.case_short.case_household_state_1.enum.k2=Spot-checked and closed`;

const DEFAULT_BEDNET = EN_BEDNET.replace('lang.current=en', 'lang.current=default');

/** Verbatim `head -1` + the quoted Spark-keyed slice from the issue. */
const NYA_SPARK = `app.display.name=Spark FCAP — pulogalamu ya wothandizira wa mudzi
en=English
forms.m0f0=Kulembetsa mudzi
forms.m0f0.icon=jr://file/commcare/7b6eea324eec1a6c05d20f96d0add3859f23329d942cd590d644113134eaeb6d.png
forms.m0f0.submit_label=Submit
forms.m1f0=Kaundula wa msonkhano wamudzi
forms.m1f0.submit_label=Submit
homescreen.title=Spark FCAP — pulogalamu ya wothandizira wa mudzi
lang.current=nya
m0.case_short.case_pilot_fcap_step_1.enum.k1=Our Partnership`;

const TUM_SPARK = `app.display.name=Apu ya Mulongozgi wa Spark FCAP
en=English
forms.m0f0=Kulembeska muzi
lang.current=tum
m0.case_short.case_pilot_fcap_step_1.enum.k1=Our Partnership`;

/** The contaminated Deliver CCZ: default/ en/ modules-0/ modules-1/ nya/ tum/ */
const CONTAMINATED_DELIVER: Record<string, string> = {
  'suite.xml': SUITE_DEFAULT_EN,
  'profile.ccpr': '<profile><property key="locale" value="en" force="false"/></profile>',
  'default/app_strings.txt': DEFAULT_BEDNET,
  'en/app_strings.txt': EN_BEDNET,
  'nya/app_strings.txt': NYA_SPARK,
  'tum/app_strings.txt': TUM_SPARK,
  'modules-0/forms-0.xml': '<h:html><h:head><title>Household registration</title></h:head></h:html>',
  'modules-1/forms-0.xml': '<h:html><h:head><title>Spot check</title></h:head></h:html>',
};

/** The same run's Learn CCZ: default/ en/ modules-0/ modules-1/ and nothing else. */
const CLEAN_LEARN: Record<string, string> = {
  'suite.xml': SUITE_DEFAULT_EN,
  'default/app_strings.txt': DEFAULT_BEDNET.replace(
    /Deliver app/g,
    'Learn app',
  ),
  'en/app_strings.txt': EN_BEDNET.replace(/Deliver app/g, 'Learn app'),
  'modules-0/forms-0.xml': '<h:html><h:head><title>Module 1</title></h:head></h:html>',
};

describe('parsing', () => {
  it('reads only <locale language="…">, never a <locale id="…"> reference', () => {
    // The suite carries one of each. Counting the reference would report the
    // declared set as larger than it is, and orphans are what is present but
    // NOT declared — so that mistake fails OPEN.
    expect(declaredLocales(SUITE_DEFAULT_EN)).toEqual(['default', 'en']);
  });

  it('derives the language code from the in-zip path and ignores everything else', () => {
    expect(Object.keys(languageTables(CONTAMINATED_DELIVER)).sort()).toEqual([
      'default',
      'en',
      'nya',
      'tum',
    ]);
  });

  it('tolerates a leading ./ on zip entry paths', () => {
    expect(Object.keys(languageTables({ './nya/app_strings.txt': NYA_SPARK }))).toEqual(['nya']);
  });

  it('pulls app.display.name, and reports null when a table has none', () => {
    expect(appDisplayName(NYA_SPARK)).toBe('Spark FCAP — pulogalamu ya wothandizira wa mudzi');
    expect(appDisplayName('lang.current=xx\nen=English')).toBeNull();
  });
});

describe('the contaminated Deliver CCZ (ace#2292)', () => {
  const audit = auditCczLanguageTables({ suiteXml: SUITE_DEFAULT_EN, files: CONTAMINATED_DELIVER });

  it('detects nya and tum as orphans', () => {
    assertChecked(audit);
    expect(audit.ok).toBe(false);
    expect(audit.orphans).toEqual(['nya', 'tum']);
    expect(audit.present).toEqual(['default', 'en', 'nya', 'tum']);
    expect(audit.declared).toEqual(['default', 'en']);
    expect(audit.missing).toEqual([]);
    expect(
      audit.findings
        .filter((f) => f.kind === 'undeclared-language-table')
        .map((f) => f.language),
    ).toEqual(['nya', 'tum']);
  });

  it('carries the foreign display name — the signal that made the origin obvious', () => {
    assertChecked(audit);
    const foreign = audit.findings.filter((f) => f.kind === 'foreign-display-name');
    expect(foreign.map((f) => f.language)).toEqual(['nya', 'tum']);
    expect(foreign[0].expectedName).toBe('Bednet Check Two-Visit Deliver app');
    expect(foreign[0].displayName).toContain('Spark FCAP');
    // Undeclared + foreign name is the cross-opportunity signature, so it
    // counts rather than merely being reported.
    expect(foreign.every((f) => f.severity === 'finding')).toBe(true);
    expect(audit.referenceName).toBe('Bednet Check Two-Visit Deliver app');
    expect(audit.referenceLanguage).toBe('en');
  });

  it('names the orphan languages and the foreign name in the rendered gate output', () => {
    const text = formatCczLanguageTables(audit, 'Deliver');
    expect(text).toContain('[FINDING]');
    expect(text).toContain('nya, tum');
    expect(text).toContain('Spark FCAP');
    expect(text).toContain('ace#2292');
    // It must not read as a halt — the device is never offered these locales.
    expect(text).toContain('Not a halt');
    expect(text).not.toContain('[BLOCKER]');
  });
});

describe('the same run’s clean Learn CCZ', () => {
  const audit = auditCczLanguageTables({ suiteXml: SUITE_DEFAULT_EN, files: CLEAN_LEARN });

  it('reports nothing', () => {
    assertChecked(audit);
    expect(audit.ok).toBe(true);
    expect(audit.findings).toEqual([]);
    expect(audit.orphans).toEqual([]);
    expect(audit.present).toEqual(['default', 'en']);
  });

  it('renders as a pass naming what was compared', () => {
    const text = formatCczLanguageTables(audit, 'Learn');
    expect(text).toContain('[PASS]');
    expect(text).toContain('default, en');
  });
});

describe('the inverse — declared with no table in the zip', () => {
  const suite = SUITE_DEFAULT_EN.replace(
    '  <detail',
    '  <locale language="fr">\n    <resource id="app_strings.fr"/>\n  </locale>\n  <detail',
  );
  const audit = auditCczLanguageTables({ suiteXml: suite, files: CLEAN_LEARN });

  it('is reported as missing, NOT laundered into the orphan set', () => {
    assertChecked(audit);
    expect(audit.declared).toEqual(['default', 'en', 'fr']);
    expect(audit.missing).toEqual(['fr']);
    expect(audit.orphans).toEqual([]);
    // A different defect with a different owner. It does not flip ok, and it
    // must never be counted as an orphan — the orphan number is the one thing
    // this gate reports, and it has to mean exactly one thing.
    expect(audit.ok).toBe(true);
    expect(audit.findings.filter((f) => f.kind === 'undeclared-language-table')).toEqual([]);
  });

  it('still names the missing table in the pass output', () => {
    expect(formatCczLanguageTables(audit, 'Learn')).toContain('fr');
  });
});

describe('a genuinely translated app', () => {
  it('does not fail on a declared language whose display name is translated', () => {
    const suite = SUITE_DEFAULT_EN.replace(
      '  <detail',
      '  <locale language="nya">\n    <resource id="app_strings.nya"/>\n  </locale>\n  <detail',
    );
    const audit = auditCczLanguageTables({
      suiteXml: suite,
      files: {
        ...CLEAN_LEARN,
        'nya/app_strings.txt': 'app.display.name=Pulogalamu ya Bednet\nlang.current=nya',
      },
    });
    assertChecked(audit);
    expect(audit.ok).toBe(true);
    expect(audit.orphans).toEqual([]);
    // Reported as a signal so a foreign programme name is never silent, but a
    // correctly multilingual build must not be graded as defective.
    const signals = audit.findings.filter((f) => f.kind === 'foreign-display-name');
    expect(signals).toHaveLength(1);
    expect(signals[0].severity).toBe('signal');
  });
});

describe('inputs the check cannot answer over report unable, never a pass', () => {
  it('unable when the file map carries no app_strings table at all', () => {
    const audit = auditCczLanguageTables({
      suiteXml: SUITE_DEFAULT_EN,
      files: { 'modules-0/forms-0.xml': '<h:html/>' },
    });
    assertUnable(audit);
    expect(audit.reason).toMatch(/no <lang>\/app_strings\.txt/);
    // The `unable` branch has no `ok` to misread, and its rendering is not green.
    expect(formatCczLanguageTables(audit, 'Deliver')).toContain('UNABLE TO CHECK');
    expect(formatCczLanguageTables(audit, 'Deliver')).not.toContain('PASS');
  });

  it('unable when suite.xml yields no locale declarations', () => {
    // Every released CCZ declares at least `default`. Zero declarations means
    // the suite was not read — and reporting "every table is an orphan" on a
    // failed read is the loudest possible false finding.
    const audit = auditCczLanguageTables({
      suiteXml: '<suite version="1"><detail id="m0_case_short"/></suite>',
      files: CONTAMINATED_DELIVER,
    });
    assertUnable(audit);
    expect(audit.reason).toMatch(/declares no <locale language/);
  });
});
