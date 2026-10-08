import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  deriveNavInput,
  parsePlayOutput,
  parseSuiteMenus,
  resolveEntryPath,
} from '../../lib/commcare-cli-validate';

/**
 * dimagi-internal/ace#2784 — two defects in the `play` install-sim gate.
 *
 * 1. The nav walk keyed the suite command on the DISPLAY index
 *    (`m${displayIdx}-f${formIdx}`). With child modules nested under a parent
 *    menu, display positions stop matching HQ module indices, so no
 *    entry_path reached a paid form.
 * 2. The classifier ended "otherwise → pass", so a walk stranded on a
 *    case-confirm screen (exit 255, form never opened) was graded `pass`.
 *
 * Fixture: suite.xml of the released group-payment-test Deliver CCZ
 * (connect-ace-prod app b6aeae19280843c18f844d18bdf047bc, build
 * 6d52f4babdcf4bcba25a5d84e26e8e7b). HQ modules 0 Groups, 1 Group members
 * (root="m0"), 2 Session records (root="m0"), 3 Variant A, 4 Variant B. The
 * root screen shows `0) Groups 1) Variant A sessions 2) Variant B sessions`.
 *
 * Every expected keystroke sequence below was observed live with
 * commcare-cli.jar against that CCZ on 2026-10-07 — it is the CLI's own
 * behaviour, not a model of it.
 */
const SUITE = readFileSync(
  path.join(__dirname, '../fixtures/ccz-play-nav-2784/suite.xml'),
  'utf8',
);

describe('parseSuiteMenus (ace#2784)', () => {
  it('reads every menu with its root (default "root") and its own commands', () => {
    const menus = parseSuiteMenus(SUITE).map((m) => [m.id, m.root, m.commands]);
    expect(menus).toEqual([
      ['m0', 'root', ['m0-f0', 'm0-f1']],
      ['m1', 'm0', ['m1-case-list']],
      ['m2', 'm0', ['m2-case-list']],
      ['m3', 'root', ['m3-f0']],
      ['m4', 'root', ['m4-f0']],
      ['root', 'root', []],
    ]);
  });
});

describe('resolveEntryPath on a Deliver app with nested child modules (ace#2784)', () => {
  it('display [1,0] is Variant A (m3-f0): case asked at the menu, then the form', () => {
    // Live: `1 / 0 / <enter> / 0` → `Starting form entry … COMMAND: m3-f0`.
    const r = resolveEntryPath([1, 0], SUITE);
    expect(r.commandId).toBe('m3-f0');
    expect(r.unresolved).toBeUndefined();
    expect(r.navInput).toBe('1\n0\n\n0\n:quit\n');
  });

  it('display [2,0] is Variant B (m4-f0)', () => {
    const r = resolveEntryPath([2, 0], SUITE);
    expect(r.commandId).toBe('m4-f0');
    expect(r.navInput).toBe('2\n0\n\n0\n:quit\n');
  });

  it('NEGATIVE CONTROL: the pre-fix derivation for [1,0] never sent the confirm Enter', () => {
    // What shipped: looked up `m1-f0` (no such entry), derived no datum, and
    // stopped on the confirm screen — the exact stream in the issue.
    const legacy = deriveNavInput([1, 0], SUITE.replace(/<menu\b[\s\S]*?<\/menu>/g, ''));
    expect(legacy).toBe('1\n0\n:quit\n');
    expect(deriveNavInput([1, 0], SUITE)).not.toBe(legacy);
  });

  it('a menu whose entries disagree on their first datum lists forms FIRST (m0)', () => {
    // m0-f0 opens with a uuid() datum, m0-f1 with a case datum, so CommCare
    // cannot ask a shared datum on entering m0. Live: `0 / 0` → m0-f0, and
    // `0 / 1 / 0 / <enter>` → m0-f1 (case list + confirm AFTER the form).
    expect(resolveEntryPath([0, 0], SUITE)).toMatchObject({
      commandId: 'm0-f0',
      navInput: '0\n0\n:quit\n',
    });
    expect(resolveEntryPath([0, 1], SUITE)).toMatchObject({
      commandId: 'm0-f1',
      navInput: '0\n1\n0\n\n:quit\n',
    });
  });

  it('descends into a child menu by its position inside the parent', () => {
    // Inside m0: 0) m0-f0  1) m0-f1  2) m1  3) m2.
    expect(resolveEntryPath([0, 2, 0], SUITE).commandId).toBe('m1-case-list');
    expect(resolveEntryPath([0, 3, 0], SUITE).commandId).toBe('m2-case-list');
  });

  it('names an out-of-range index instead of guessing (the HQ index [3,0] at a 3-item root)', () => {
    // Passing the HQ module index crashed live with
    // `ArrayIndexOutOfBoundsException: Index 3 out of bounds for length 3`.
    const r = resolveEntryPath([3, 0], SUITE);
    expect(r.commandId).toBeUndefined();
    expect(r.unresolved).toMatch(/out of range.*lists 3 item/);
  });

  it('names a path that stops on a menu', () => {
    expect(resolveEntryPath([1], SUITE).unresolved).toMatch(/ends on menu "m3"/);
  });

  it('keeps the calibrated spark shapes when the suite declares menus', () => {
    // Same entries as the spark-facilitator fixture, now with the <menu>
    // blocks HQ actually emits: one followup form per menu → case first.
    const spark = `<suite>
      <entry><command id="m0-f0"/><session>
        <datum id="case_id" nodeset="instance('casedb')/casedb/case[@case_type='fcap_community'][@status='open']" value="./@case_id" detail-select="m0_case_short" detail-confirm="m0_case_long"/>
        <datum id="case_id" value="instance('commcaresession')/session/data/case_id"/>
      </session></entry>
      <entry><command id="m1-f0"/><session>
        <datum id="case_id_new_fcap_community_0" function="uuid()"/>
      </session></entry>
      <menu id="m0"><text/><command id="m0-f0"/></menu>
      <menu id="m1"><text/><command id="m1-f0"/></menu>
    </suite>`;
    expect(deriveNavInput([0, 0], spark)).toBe('0\n0\n\n0\n:quit\n');
    expect(deriveNavInput([1, 0], spark)).toBe('1\n0\n:quit\n');
  });
});

describe('parsePlayOutput requires observed form entry (ace#2784)', () => {
  const base = { exitCode: 0, stderr: '', timedOut: false, timeoutMs: 30_000, entryPath: [1, 0] };

  // Verbatim tail of the stream the issue reports for [1,0] (exit 255).
  const STRANDED_ON_CONFIRM = `Group Payment Test Deliver app | demo [8]
====================
0) Groups
1) Variant A sessions
2) Variant B sessions
> Case | demo [8]
====================
  Group name | Community
0)
> Case | demo [8]
====================
Press enter to select this case
>`;

  it('a walk that never reached form entry is NOT a pass', () => {
    const r = parsePlayOutput({ ...base, exitCode: 255, stdout: STRANDED_ON_CONFIRM });
    expect(r.verdict).toBe('skipped');
    expect(r.skip_reason).toBe('form-entry-not-reached');
  });

  it('NEGATIVE CONTROL: the same stream plus the form-entry marker passes', () => {
    const r = parsePlayOutput({
      ...base,
      stdout: `${STRANDED_ON_CONFIRM}\nStarting form entry with the following stack frame\nCOMMAND: m3-f0\nForm Start: Press Return to proceed`,
    });
    expect(r.verdict).toBe('pass');
    expect(r.skip_reason).toBeUndefined();
  });

  it('reads the marker past the 4KB log trim', () => {
    const r = parsePlayOutput({
      ...base,
      stdout: `${'menu line\n'.repeat(800)}Starting form entry with the following stack frame`,
    });
    expect(r.stdout.length).toBeLessThan(5000);
    expect(r.verdict).toBe('pass');
  });

  // Verbatim (abridged frames) from the live m3-f0 run once the walk was fixed.
  const CASE_INDEX_NPE = `Starting form entry with the following stack frame
Live Frame
----------
COMMAND: m3
DATUM : case_id - ace-play-seed-0
DATUM : case_id - ace-play-seed-0
COMMAND: m3-f0
Unhandled Fatal Error executing CommCare appjava.lang.NullPointerException: Cannot invoke "org.commcare.modern.engine.cases.CaseIndexTable.getCasesMatchingIndex(String, String)" because "this.caseIndexTable" is null
\tat org.commcare.cases.instance.CaseInstanceTreeElement.performCaseIndexQuery(CaseInstanceTreeElement.java:281)
\tat org.javarosa.core.model.FormDef.initialize(FormDef.java:1464)
\tat org.commcare.util.cli.ApplicationHost.loopSession(ApplicationHost.java:379)`;

  it("the CLI sandbox's missing CaseIndexTable is a harness skip, not a CCZ failure", () => {
    const r = parsePlayOutput({ ...base, stdout: CASE_INDEX_NPE });
    expect(r.verdict).toBe('skipped');
    expect(r.skip_reason).toBe('cli-case-index-unsupported');
  });

  it('NEGATIVE CONTROL: a real XPath defect in the same stream still fails', () => {
    const r = parsePlayOutput({
      ...base,
      stdout: `${CASE_INDEX_NPE}\norg.javarosa.xpath.XPathTypeMismatchException: Calculation Error: Error in calculation for /data/x`,
    });
    expect(r.verdict).toBe('fail');
  });

  it('NEGATIVE CONTROL: an unrelated NPE after form entry still fails', () => {
    const r = parsePlayOutput({
      ...base,
      stdout: `Starting form entry with the following stack frame\nUnhandled Fatal Error executing CommCare app\njava.lang.NullPointerException: something else is null\n\tat org.javarosa.core.model.FormDef.initialize(FormDef.java:1464)`,
    });
    expect(r.verdict).toBe('fail');
  });
});
