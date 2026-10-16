/**
 * ace#2286 — `commcare_validate_ccz mode:play` could not reach the PAYABLE
 * form of a `longitudinal-visits` Deliver app. The play restore seeded one
 * bare case per type (ace#1088), but that form's case list FILTERS on case
 * properties, so the bare seed was excluded, the entity list rendered zero
 * rows, and the walk died in `EntityListSubscreen` → `skipped /
 * empty-case-list` on every run of the archetype (bednet-check-2-visit/
 * 20260908-1544, Deliver build 171996636b714bb09dee8779e7e83927, `[1, 0]`).
 *
 * The fix seeds a case carrying exactly the values suite.xml states a row
 * needs — but only for conjunctions of `<prop> = '<literal>'` equalities.
 * Every other predicate seeds nothing and the skip names it.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipSync, strToU8 } from 'fflate';

import {
  buildPlayRestoreXml,
  commcareCliPlayCcz,
  extractCaseSeedPlanFromSuite,
  type CliSpawn,
} from '../../lib/commcare-cli-validate.js';

/**
 * Released bednet-check-2-visit Deliver suite.xml, COMPLETE and UNMODIFIED
 * (build 1fcc4b819ff74ccf96a7972b550e887f, 20260907-1126 — provenance in
 * test/lib/ccz-enum-fidelity.test.ts). Its m1 Follow-Up list filters on
 * `[consent_given = 'yes']`: the same shape, one day before the ace#2286 run.
 */
const BEDNET_SUITE = readFileSync(
  path.join(__dirname, '../fixtures/ccz-enum-fidelity/hhstate-suite.xml'),
  'utf8',
);

/** The m1 datum verbatim from the ace#2286 issue body (20260908-1544 build). */
const ISSUE_DATUM = `<suite><entry><command id="m1-f0"/><session>
<datum id="case_id"
       nodeset="instance('casedb')/casedb/case[@case_type='household'][@status='open'][consent_given = 'yes' and household_state = 'registered_awaiting_followup']"
       value="./@case_id" detail-select="m1_case_short" detail-confirm="m1_case_long"/>
</session></entry></suite>`;

/** Verbatim stack from the ace#2286 issue body. */
const EMPTY_LIST_STACK = `java.lang.ArrayIndexOutOfBoundsException: Index 0 out of bounds for length 0
     at org.commcare.util.screen.EntityListSubscreen.handleInputAndUpdateHost(EntityListSubscreen.java:220)`;

function suiteWith(predicate: string): string {
  return `<suite><entry><command id="m0-f0"/><session>
<datum id="case_id" nodeset="instance('casedb')/casedb/case[@case_type='household'][@status='open'][${predicate}]" value="./@case_id" detail-select="m0_case_short"/>
</session></entry></suite>`;
}

describe('extractCaseSeedPlanFromSuite (ace#2286)', () => {
  it('positive control: the released bednet suite seeds consent_given=yes on household', () => {
    const plan = extractCaseSeedPlanFromSuite(BEDNET_SUITE);
    expect(plan.seeds).toEqual([{ caseType: 'household', properties: { consent_given: 'yes' } }]);
    expect(plan.unseeded).toEqual([]);
  });

  it('extracts BOTH conjuncts of the issue-run datum', () => {
    expect(extractCaseSeedPlanFromSuite(ISSUE_DATUM)).toEqual({
      seeds: [
        {
          caseType: 'household',
          properties: { consent_given: 'yes', household_state: 'registered_awaiting_followup' },
        },
      ],
      unseeded: [],
    });
  });

  it('reads entity-encoded attributes and double-quoted literals', () => {
    const suite = `<suite><datum id="c" nodeset="instance('casedb')/casedb/case[@case_type='v'][@status='open'][stage = &quot;two&quot;]"/></suite>`;
    expect(extractCaseSeedPlanFromSuite(suite).seeds).toEqual([
      { caseType: 'v', properties: { stage: 'two' } },
    ]);
  });

  it('an unfiltered list needs no property seed', () => {
    const suite = `<suite><datum id="c" nodeset="instance('casedb')/casedb/case[@case_type='v'][@status='open']"/></suite>`;
    expect(extractCaseSeedPlanFromSuite(suite)).toEqual({ seeds: [], unseeded: [] });
  });

  it('an `and` inside a literal is not a conjunction', () => {
    const plan = extractCaseSeedPlanFromSuite(suiteWith("label = 'rock and roll'"));
    expect(plan.seeds).toEqual([{ caseType: 'household', properties: { label: 'rock and roll' } }]);
  });

  it.each([
    ["consent_given = 'yes' or household_state = 'x'", 'or'],
    ["consent_given != 'no'", 'inequality'],
    ['visit_count > 2', 'comparison'],
    ["selected(services, 'bednet')", 'selected()'],
    ["not(consent_given = 'no')", 'negation'],
    ['date(next_visit) <= today()', 'date function'],
    ["consent_given = 'yes' and visit_count >= 1", 'mixed conjunction'],
    ["consent_given = 'yes' and consent_given = 'no'", 'contradiction'],
  ])('negative control (%s, %s): seeds nothing and names the predicate', (predicate) => {
    const plan = extractCaseSeedPlanFromSuite(suiteWith(predicate));
    expect(plan.seeds).toEqual([]);
    expect(plan.unseeded).toHaveLength(1);
    expect(plan.unseeded[0]).toMatchObject({ datum_id: 'case_id', case_type: 'household', predicate });
    expect(plan.unseeded[0].reason).toMatch(/equality|must equal both/);
  });

  it('an index/parent join is not seeded and stays one predicate', () => {
    const suite = `<suite><datum id="case_id" nodeset="instance('casedb')/casedb/case[@case_type='member'][@status='open'][index/*[not(@relationship='extension')]=instance('commcaresession')/session/data/parent_id]"/></suite>`;
    const plan = extractCaseSeedPlanFromSuite(suite);
    expect(plan.seeds).toEqual([]);
    expect(plan.unseeded.map((u) => u.predicate)).toEqual([
      "index/*[not(@relationship='extension')]=instance('commcaresession')/session/data/parent_id",
    ]);
  });
});

describe('buildPlayRestoreXml caseSeeds (ace#2286)', () => {
  it('emits the properties in a case-2.0 <update>, xml-escaped', () => {
    const xml = buildPlayRestoreXml({
      caseTypes: ['household'],
      caseSeeds: [{ caseType: 'household', properties: { consent_given: 'yes', note: 'a<b & c' } }],
    });
    const cases = xml.match(/<case [\s\S]*?<\/case>/g)!;
    expect(cases).toHaveLength(2);
    expect(cases[0]).not.toContain('<update>');
    expect(cases[1]).toContain('<update>');
    expect(cases[1]).toContain('<consent_given>yes</consent_given>');
    expect(cases[1]).toContain('<note>a&lt;b &amp; c</note>');
    expect(cases[1]).toContain('<owner_id>demo-user-uuid</owner_id>');
  });

  it('without caseSeeds the restore is unchanged', () => {
    expect(buildPlayRestoreXml({ caseTypes: ['x'], caseSeeds: [] })).toBe(
      buildPlayRestoreXml({ caseTypes: ['x'] }),
    );
  });
});

describe('commcareCliPlayCcz seeds what the case list filters on (ace#2286)', () => {
  function run(suite: string, entryPath: number[], stdout: string) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ace-caseseed-'));
    const cczPath = path.join(dir, 'app.ccz');
    writeFileSync(cczPath, zipSync({ 'suite.xml': strToU8(suite) }));
    const jarPath = path.join(dir, 'cli.jar');
    writeFileSync(jarPath, 'x');
    let restore = '';
    const spawnImpl: CliSpawn = (_cmd, args) => {
      restore = readFileSync(args[args.length - 1], 'utf8');
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: { write: () => true, end: () => {} },
        kill: () => true,
      });
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(stdout));
        child.emit('close', 0);
      });
      return child;
    };
    return commcareCliPlayCcz({ cczPath, jarPath, javaPath: 'java-fake', entryPath, spawnImpl }).then(
      (res) => ({ res, restore }),
    );
  }

  it('the bednet Follow-Up walk carries a household case with consent_given=yes', async () => {
    const { res, restore } = await run(BEDNET_SUITE, [1, 0], 'Form Start: Press Return to proceed\n');
    expect(res.command_id).toBe('m1-f0');
    expect(res.seeded_case_properties).toEqual([
      { caseType: 'household', properties: { consent_given: 'yes' } },
    ]);
    expect(restore).toMatch(
      /<case_type>household<\/case_type>[\s\S]*?<update>\s*<consent_given>yes<\/consent_given>/,
    );
    expect(res.verdict).toBe('pass');
    expect(res.unseeded_case_predicates).toBeUndefined();
  });

  it('an unseedable filter still skips, and the skip names the predicate', async () => {
    const suite = suiteWith("visit_count > 2");
    const { res, restore } = await run(suite, [0, 0], EMPTY_LIST_STACK);
    expect(restore).not.toContain('<update>');
    expect(res.verdict).toBe('skipped');
    expect(res.skip_reason).toBe('empty-case-list');
    expect(res.unseeded_case_predicates).toEqual([
      expect.objectContaining({ case_type: 'household', predicate: 'visit_count > 2' }),
    ]);
  });
});
