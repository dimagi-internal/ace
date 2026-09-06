/**
 * ace#1688 — the case-list tile and the writing form shipped two different FCAP
 * taxonomies, and every gate passed the build.
 *
 * PR #1720 shipped `checkCaseListEnumDrift` as a pure diff and wired it into
 * `skills/_app-component-library.md` as PROSE. Nothing executed it: a grep for
 * the symbol across all of `origin/main` at 0.13.1031 returned the module, its
 * own unit test, and the component library — no call site. A library plus a
 * documented rule is compliance-by-memory, which CLAUDE.md is explicit about:
 * *"invariants are hooks, not memory."* This suite covers the half that makes
 * it a hook — extraction from a released CCZ, so `app-release-qa` can fail the
 * build instead of the drift reaching a device.
 *
 * ## The controls, and why each one is here
 *
 * A check that cannot fail proves nothing — three Phase 7 gates shipped in one
 * week structurally unable to fail (ace#1693, #1695, #1701). So:
 *
 * - **Negative control**: the real ace#1688 drift MUST produce findings. The
 *   same fixture with the enum corrected MUST pass. Both are asserted below,
 *   against one shared `fcap-suite.xml` — only `app_strings.txt` differs, so
 *   the pair isolates the taxonomy and nothing else.
 * - **Positive control**: a real released CCZ (`ccz-20260729-0002-deliver`)
 *   passes, so the gate is not trivially always-red.
 * - **Proper subset passes**: the rule is SUBSET, not equality. A tile that
 *   labels fewer values than the form offers is legitimate, and failing it
 *   would fire on real apps.
 *
 * ## On the fixtures
 *
 * `bednet-*` are VERBATIM slices of released Deliver CCZ
 * `ccz-20260729-0002-deliver` — suite detail blocks, the `enum`/`header` lines
 * of `en/app_strings.txt`, and the form's `<itext>` + `<select1>`.
 *
 * `fcap-*` are a RECONSTRUCTION, and the split matters. Their STRUCTURE is
 * copied element-for-element from that same released CCZ. Their CONTENT — both
 * taxonomies and the `nova_text_00000000NN` option values — is verbatim from
 * ace#1688's quoted repro of released CCZ `bf4898f5d80b456eb4525fc4e2d9ced9`.
 * The live CCZ could not be re-downloaded this session (the Connect session was
 * closed and the run that owns it, `spark-facilitator/20260820-0817`, is
 * mid-flight under another agent), so the recorded evidence in the issue is the
 * source. What is NOT claimed: that these bytes are that CCZ's bytes.
 *
 * `fcap-renamed-*` are VERBATIM (ace#1808) — sliced from released Deliver build
 * `b08533bdf26a48a295a362ff204fb88d` (spark-facilitator/20260828-0703, HQ app
 * `89881fa67ec74f21b95e37d41e39ba93`), re-downloaded in the session that fixed
 * #1808 (`commcare_download_ccz` -> 200, 27,592 bytes). Note the huge
 * `m1.case_short.case_replace(join(...))_2.enum.*` locale ids: those are real,
 * CCHQ derives the key from the whole xpath, and they are kept unmodified
 * precisely because a tidied fixture would not exercise `parseAppStrings`'s
 * first-`=`-splits rule against what actually ships.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertChecked, assertUnable } from '../../lib/check-outcome.js';
import {
  type CczEnumFidelityFinding,
  parseAppStrings,
  extractCaseListEnums,
  extractFormChoiceLists,
  extractCaseWriteMap,
  checkCczCaseListEnumFidelity,
  describeCczEnumFidelity,
} from '../../lib/ccz-enum-fidelity.js';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'ccz-enum-fidelity',
);
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const BEDNET_FORM = 'modules-0/forms-0.xml';
const FCAP_FORM = 'modules-1/forms-0.xml';

function runFcap(appStrings: string) {
  return checkCczCaseListEnumFidelity({
    suiteXml: read('fcap-suite.xml'),
    appStrings,
    forms: [{ path: FCAP_FORM, xml: read('fcap-form.xml') }],
  });
}

describe('extraction from a released CCZ', () => {
  it('reads the id-mapping enum off the xpath branch, not the locale id', () => {
    // The property comes from `selected(slept_under_bednet, 'yes')` — the
    // authoritative source. A locale id (`case_slept_under_bednet_2`) cannot be
    // split back into name and index without guessing where the name ends.
    const columns = extractCaseListEnums(
      read('bednet-suite.xml'),
      parseAppStrings(read('bednet-app_strings.txt')),
    );
    expect(columns.map((c) => c.detailId)).toEqual(['m0_case_short', 'm0_case_long']);
    for (const column of columns) {
      expect(column.property).toBe('slept_under_bednet');
      expect(column.enums).toEqual({ yes: 'Yes', no: 'No' });
    }
  });

  it('skips fields that are not id-mapping columns', () => {
    // `case_name` is a plain `<xpath function="case_name"/>` with no branches.
    const columns = extractCaseListEnums(
      read('bednet-suite.xml'),
      parseAppStrings(read('bednet-app_strings.txt')),
    );
    expect(columns).toHaveLength(2); // two details x one enum column, not the name field
  });

  it('reads the AUTHORED form label, never the markdown twin', () => {
    // Nova emits `<value>` and `<value form="markdown">`. This check compares
    // authored-to-authored; what markdown does to the rendered string is
    // ace#1689's job (checkMarkdownEatenLabels), not this one's.
    const lists = extractFormChoiceLists(read('fcap-form.xml'), FCAP_FORM);
    const phase = lists.find((l) => l.property === 'phase');
    expect(phase?.choices['nova_text_0000000001']).toBe('1. Planning');
  });

  it('pairs a column to a select by the ref’s last path segment', () => {
    const lists = extractFormChoiceLists(read('bednet-form.xml'), BEDNET_FORM);
    // ref="/data/slept_under_bednet" -> case property `slept_under_bednet`
    expect(lists.map((l) => l.property)).toEqual(['slept_under_bednet']);
  });
});

describe('NEGATIVE CONTROL — the gate detects the real ace#1688 drift', () => {
  const res = runFcap(read('fcap-drifted-app_strings.txt'));

  it('fails, rather than passing a build whose two surfaces disagree', () => {
    assertChecked(res);
    expect(res.ok, 'the shipped drift must FAIL the gate').toBe(false);
    expect(res.columnsCompared).toBeGreaterThan(0);
  });

  it('reports every row of the issue’s table, tile-vs-form', () => {
    assertChecked(res);
    const byValue = Object.fromEntries(
      res.findings.map((f: CczEnumFidelityFinding) => [`${f.property}:${f.value}`, f]),
    );
    // Verbatim from ace#1688. stored -> (tile label, form label).
    const expected: Array<[string, string, string]> = [
      ['phase:nova_text_0000000001', '1. Introduction', '1. Planning'],
      ['phase:nova_text_0000000002', '2. Planning', '2. Implementation'],
      [
        'phase:nova_text_0000000003',
        '3. Implementation',
        '3. Second Round Planning and Implementation',
      ],
      ['phase:nova_text_0000000004', '4. Sustainability', '4. Transition'],
      ['current_step_id:nova_text_0000000011', '1. Intro with leaders', '1. Our Partnership'],
      [
        'current_step_id:nova_text_0000000012',
        '2. Community introduction',
        '2. Community Dynamics, Governance and Leadership',
      ],
      [
        'current_step_id:nova_text_0000000013',
        '3. Mapping and profiling',
        '3. Understanding the Present – Situational Analysis',
      ],
    ];
    for (const [key, tile, form] of expected) {
      expect(byValue[key], `no finding for ${key}`).toBeDefined();
      expect(byValue[key].kind).toBe('label-mismatch');
      expect(byValue[key].caseListLabel).toBe(tile);
      expect(byValue[key].formLabel).toBe(form);
    }
    expect(res.findings).toHaveLength(expected.length);
  });

  it('names both details once, not the same drift twice', () => {
    // The short and long details carry the same enum. Reporting each finding
    // twice would make the count meaningless in a build memo.
    assertChecked(res);
    for (const f of res.findings) {
      expect(f.detailIds).toEqual(['m0_case_short', 'm0_case_long']);
    }
  });

  it('renders a line an operator can act on without opening the CCZ', () => {
    assertChecked(res);
    const lines = describeCczEnumFidelity(res.findings);
    expect(lines[0]).toContain('1. Introduction');
    expect(lines[0]).toContain('1. Planning');
    expect(lines[0]).toContain(FCAP_FORM);
    // The remediation must say which side is the authority.
    expect(res.findings[0].remediation).toMatch(/form is the authority/i);
  });

  it('PASSES the same CCZ once the enum is derived from the itemset', () => {
    // The fix under test: identical suite.xml, only the enum labels changed.
    // Fails before, passes after — that pair is the whole point of the gate.
    const fixed = runFcap(read('fcap-corrected-app_strings.txt'));
    assertChecked(fixed);
    expect(fixed.ok).toBe(true);
    expect(fixed.findings).toEqual([]);
    expect(fixed.columnsCompared).toBe(4); // 2 properties x 2 details
    expect(fixed.valuesCompared).toBe(14);
  });
});

describe('POSITIVE CONTROL — a real released CCZ passes', () => {
  it('does not fire on ccz-20260729-0002-deliver', () => {
    // A gate that is always red gets turned off. This is a real shipped build.
    const res = checkCczCaseListEnumFidelity({
      suiteXml: read('bednet-suite.xml'),
      appStrings: read('bednet-app_strings.txt'),
      forms: [{ path: BEDNET_FORM, xml: read('bednet-form.xml') }],
    });
    assertChecked(res);
    expect(res.ok).toBe(true);
    expect(res.findings).toEqual([]);
    expect(res.columnsCompared).toBe(2);
    expect(res.unpaired).toEqual([]);
  });
});

describe('SUBSET, not equality', () => {
  it('passes when the tile labels FEWER values than the form offers', () => {
    // The PDD pilot window is "Planning, Steps 1-7" — a tile that labels only
    // the phases in scope is a design decision, not drift. Demanding equality
    // would fail it, and a check with false positives gets ignored.
    const appStrings = read('fcap-corrected-app_strings.txt')
      .split('\n')
      .filter((l) => !/\.enum\.knova_text_000000000[34]=/.test(l))
      .join('\n');
    const res = runFcap(appStrings);
    assertChecked(res);
    expect(res.ok, 'a proper subset is legitimate').toBe(true);
    // Still SURFACED — the tile renders the raw code for these — just not fatal.
    expect(res.unlabelledInCaseList.phase).toEqual([
      'nova_text_0000000003',
      'nova_text_0000000004',
    ]);
  });

  it('fails a value the tile renders that the form cannot produce', () => {
    // The other direction is NOT legitimate: no FLW can ever store it.
    const appStrings =
      read('fcap-corrected-app_strings.txt') +
      'm0.case_short.case_phase_2.enum.knova_text_0000000099=5. Retired phase\n';
    const suite = read('fcap-suite.xml').replace(
      "if(selected(phase, 'nova_text_0000000004'), $knova_text_0000000004, '')",
      "if(selected(phase, 'nova_text_0000000004'), $knova_text_0000000004, ''), " +
        "if(selected(phase, 'nova_text_0000000099'), $knova_text_0000000099, '')",
    );
    const res = checkCczCaseListEnumFidelity({
      suiteXml: suite.replace(
        '<variable name="knova_text_0000000004">',
        '<variable name="knova_text_0000000099">\n' +
          '              <locale id="m0.case_short.case_phase_2.enum.knova_text_0000000099"/>\n' +
          '            </variable>\n' +
          '            <variable name="knova_text_0000000004">',
      ),
      appStrings,
      forms: [{ path: FCAP_FORM, xml: read('fcap-form.xml') }],
    });
    assertChecked(res);
    expect(res.ok).toBe(false);
    const orphan = res.findings.find(
      (f: CczEnumFidelityFinding) => f.value === 'nova_text_0000000099',
    );
    expect(orphan?.kind).toBe('missing-from-form');
  });
});

describe('a blind check must not read as a pass', () => {
  it('is UNABLE when the CCZ has no id-mapping column at all', () => {
    const res = checkCczCaseListEnumFidelity({
      suiteXml: '<suite version="3"><detail id="m0_case_short"></detail></suite>',
      appStrings: '',
      forms: [{ path: BEDNET_FORM, xml: read('bednet-form.xml') }],
    });
    assertUnable(res);
    expect(res.reason).toContain('no id-mapping case-list column');
    expect(res).not.toHaveProperty('ok');
  });

  it('is UNABLE when a column exists but no form select writes its property', () => {
    // This is the matcher-is-the-bug case: an id-mapping column IS present, so
    // reporting "ok" here would be a gate covering nothing (ace#1634's class).
    const res = checkCczCaseListEnumFidelity({
      suiteXml: read('bednet-suite.xml'),
      appStrings: read('bednet-app_strings.txt'),
      forms: [{ path: 'modules-9/forms-0.xml', xml: '<h:html/>' }],
    });
    assertUnable(res);
    // ace#1808: the reason states what was OBSERVED (pairing failed), not a
    // conclusion about the app ("no form select writes any of those
    // properties") that was never established — and was false on the build
    // that surfaced it.
    expect(res.reason).toContain('pairing failed on all 2');
    expect(res.reason).toContain('NOT a pass');
    expect(res.reason).toContain('slept_under_bednet');
    expect(res.reason).not.toContain('no form select writes any of those properties');
  });
});

describe('the gate is WIRED, not just available', () => {
  // PR #1720 shipped the diff and documented the rule; a grep across ALL of
  // origin/main at 0.13.1031 found no call site outside the module, its own
  // test, and the component library. "A library nothing calls is not a
  // preventer" — so pin the wiring itself, or this regresses to prose the next
  // time someone reorganises the skill.
  const skill = fs.readFileSync(
    path.join(FIXTURES, '..', '..', '..', 'skills', 'app-release-qa', 'SKILL.md'),
    'utf8',
  );

  it('app-release-qa calls it, on the step that already parses the CCZ', () => {
    expect(skill, 'must name the entry point').toContain('checkCczCaseListEnumFidelity');
    expect(skill, 'must name the module that owns it').toContain('lib/ccz-enum-fidelity');
  });

  it('drift halts the build rather than being noted in passing', () => {
    expect(skill).toMatch(/\[BLOCKER\]`?\s*`?case-list-enum-drift/);
    // And the failure mode is documented where an operator will look for it.
    expect(skill).toMatch(/- `case-list-enum-drift` —/);
  });

  it('remediation points at the producer, not at the enum in front of you', () => {
    // An instance fix leaves the next build free to reinvent the taxonomy.
    expect(skill).toMatch(/case-list-enum-drift[\s\S]{0,2000}pdd-to-deliver-app/);
  });

  it('the skill states the subset rule, so nobody re-tightens it to equality', () => {
    expect(skill).toMatch(/[Ss]ubset, not equality|subset\*\* of/);
  });

  it('treats `unable` as unevaluated, never as a pass', () => {
    expect(skill).toMatch(/`unable` is \*\*not\*\* a pass|unable.{0,40}not.{0,10}a pass/i);
  });
});

/**
 * ace#1808 — the gate silently did not RUN whenever the Nova question id
 * differs from the case property it writes, which is the normal case.
 *
 * On released Deliver build `b08533bdf26a48a295a362ff204fb88d`
 * (spark-facilitator/20260828-0703, HQ app 89881fa67ec74f21b95e37d41e39ba93)
 * the enrolment form's question is `starting_fcap_step`, it writes
 * `village.pilot_fcap_step`, and both case-list columns render
 * `pilot_fcap_step`. Pairing on the question-id tail alone found nothing:
 * `columnsCompared` stayed 0 and this `[BLOCKER]`-severity check reported
 * `unable` on the exact app family it was written for.
 *
 * `unable` is correctly not a pass, so nothing shipped green — the failure is
 * that a blind check reads as "not applicable here" rather than "I could not
 * do my job."
 *
 * The three `fcap-renamed-*` fixtures are VERBATIM slices of that CCZ,
 * re-downloaded this session (`commcare_download_ccz` -> 200, 27,592 bytes):
 * `suite.xml`'s whole `m1_case_short` detail, the `app_strings.txt` lines its
 * locale ids resolve to, and `modules-0/forms-0.xml`'s `<select1>` + its
 * `<itext>` + the `/data/case/update/pilot_fcap_step` bind. Nothing is
 * reconstructed.
 */
describe('the question id is not the case property (ace#1808)', () => {
  const suiteXml = read('fcap-renamed-suite.xml');
  const appStrings = read('fcap-renamed-app_strings.txt');
  const formXml = read('fcap-renamed-form.xml');
  const forms = [{ path: 'modules-0/forms-0.xml', xml: formXml }];

  it('the fixture really does carry the rename — question id is NOT the case property', () => {
    // If this ever stops holding, the rest of this block proves nothing.
    expect(formXml).toContain('<select1 ref="/data/starting_step/starting_fcap_step">');
    expect(formXml).toContain('nodeset="/data/case/update/pilot_fcap_step"');
    expect(suiteXml).toContain("selected(pilot_fcap_step, 'step_1')");
    expect(suiteXml).not.toContain('starting_fcap_step');
  });

  it('resolves the case property through the form case-update bind', () => {
    expect(extractCaseWriteMap(formXml)).toEqual({
      '/data/starting_step/starting_fcap_step': ['pilot_fcap_step'],
    });
    const [list] = extractFormChoiceLists(formXml, 'modules-0/forms-0.xml');
    expect(list.property).toBe('starting_fcap_step'); // the QUESTION id
    expect(list.caseProperties).toEqual(['pilot_fcap_step']); // the CASE property
  });

  it('THE GATE NOW RUNS: checked, not unable', () => {
    const res = checkCczCaseListEnumFidelity({ suiteXml, appStrings, forms });
    assertChecked(res);
    expect(res.columnsCompared).toBe(1);
    expect(res.valuesCompared).toBe(7);
    expect(res.unpaired).toEqual([]);
    // This build has zero drift — 7-for-7 identical, verified by hand in the
    // issue. So the gate runs AND passes, which is the honest verdict.
    expect(res.ok).toBe(true);
  });

  it('NEGATIVE CONTROL: a drifted label under the SAME rename still fails', () => {
    // Change one tile label. The pairing must survive and the diff must bite —
    // a gate that runs but cannot fail is the ace#1693/#1695/#1701 class.
    const drifted = appStrings.replace(
      '=Step 3: Understanding the Present - Situational Analysis',
      '=Step 3: Situation Analysis',
    );
    expect(drifted).not.toBe(appStrings);
    const res = checkCczCaseListEnumFidelity({ suiteXml, appStrings: drifted, forms });
    assertChecked(res);
    expect(res.ok).toBe(false);
    expect(res.columnsCompared).toBe(1);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].property).toBe('pilot_fcap_step');
    expect(res.findings[0].value).toBe('step_3');
    expect(describeCczEnumFidelity(res.findings)[0]).toMatch(/Situation Analysis/);
  });

  it('NEGATIVE CONTROL: a stored value the form cannot produce is still caught', () => {
    // The tile still labels `step_1`; the form can only store `step_9`.
    const res = checkCczCaseListEnumFidelity({
      suiteXml,
      appStrings,
      forms: [
        {
          path: 'modules-0/forms-0.xml',
          xml: formXml.replace('<value>step_1</value>', '<value>step_9</value>'),
        },
      ],
    });
    assertChecked(res);
    expect(res.ok).toBe(false);
    expect(res.findings.map((f) => f.kind)).toContain('missing-from-form');
    expect(res.findings.find((f) => f.kind === 'missing-from-form')!.value).toBe('step_1');
  });

  it('the case-write mapping WINS over a coincidental question-id match', () => {
    // Two selects: one whose question id happens to be `pilot_fcap_step` with
    // the WRONG taxonomy, and the real one that writes the case property. The
    // form's own declaration must decide, or the fix is a coin flip.
    const decoy = `<?xml version='1.0'?>
      <h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms" xmlns:jr="http://openrosa.org/javarosa">
        <h:head><model><itext><translation lang="en" default="">
          <text id="d0"><value>WRONG</value></text>
        </translation></itext></model></h:head>
        <h:body>
          <select1 ref="/data/decoy/pilot_fcap_step">
            <item><label ref="jr:itext('d0')"/><value>step_1</value></item>
          </select1>
        </h:body>
      </h:html>`;
    const res = checkCczCaseListEnumFidelity({
      suiteXml,
      appStrings,
      // decoy FIRST, so a first-wins name map would pick it.
      forms: [{ path: 'modules-9/forms-0.xml', xml: decoy }, ...forms],
    });
    assertChecked(res);
    expect(res.ok).toBe(true);
    expect(res.findings).toEqual([]);
  });

  it('an expression case-write is not mapped — a guess is worse than a fallback', () => {
    const expr = formXml.replace(
      'calculate="/data/starting_step/starting_fcap_step"',
      'calculate="if(/data/a = 1, /data/starting_step/starting_fcap_step, /data/b)"',
    );
    expect(expr).not.toBe(formXml);
    expect(extractCaseWriteMap(expr)).toEqual({});
  });

  it('the question-id fallback still works for a select with no case write', () => {
    // bednet: `/data/slept_under_bednet` writes `slept_under_bednet`, and its
    // form fixture carries no case block at all.
    const res = checkCczCaseListEnumFidelity({
      suiteXml: read('bednet-suite.xml'),
      appStrings: read('bednet-app_strings.txt'),
      forms: [{ path: 'modules-0/forms-0.xml', xml: read('bednet-form.xml') }],
    });
    assertChecked(res);
    expect(res.columnsCompared).toBeGreaterThan(0);
  });
});
