import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseValidatorOutput,
  parsePlayOutput,
  commcareCliValidateCcz,
  CommCareCliInputError,
  DEFAULT_PLAY_RESTORE_XML,
  buildPlayRestoreXml,
  extractCaseTypesFromSuite,
  deriveNavInput,
} from './commcare-cli-validate.js';

// The real `suite.xml` shape from the released spark-facilitator Deliver CCZ
// (app fc14076ff22d4b199451ea2cba4cd48f, build 704c99901e104ee29129469de5739750).
// m0-f0 is a `followup` behind a case list WITH a confirm detail; m1-f0 is the
// registration form, whose datum is computed (`uuid()`) and shows no screen.
const SPARK_SUITE = `<suite>
  <entry>
    <command id="m0-f0"/>
    <session>
      <datum id="case_id" nodeset="instance('casedb')/casedb/case[@case_type='fcap_community'][@status='open']" value="./@case_id" detail-select="m0_case_short" detail-confirm="m0_case_long"/>
      <datum id="case_id" value="instance('commcaresession')/session/data/case_id"/>
    </session>
  </entry>
  <entry>
    <command id="m1-f0"/>
    <session>
      <datum id="case_id_new_fcap_community_0" function="uuid()"/>
    </session>
  </entry>
</suite>`;

describe('parseValidatorOutput', () => {
  const defaultInput = {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    timeoutMs: 60_000,
  };

  it('returns pass on zero exit with clean stdout/stderr', () => {
    const r = parseValidatorOutput({ ...defaultInput, stdout: 'App configured successfully\n' });
    expect(r.verdict).toBe('pass');
    expect(r.failed_resource).toBeUndefined();
    expect(r.parser_message).toBeUndefined();
    expect(r.exit_code).toBe(0);
    expect(r.timed_out).toBe(false);
  });

  it('returns fail on non-zero exit', () => {
    const r = parseValidatorOutput({
      ...defaultInput,
      exitCode: 1,
      stderr: 'Exception in thread "main" java.lang.RuntimeException: something\n',
    });
    expect(r.verdict).toBe('fail');
    expect(r.exit_code).toBe(1);
  });

  it('returns fail when timed out, even with exit 0', () => {
    const r = parseValidatorOutput({ ...defaultInput, timedOut: true });
    expect(r.verdict).toBe('fail');
    expect(r.timed_out).toBe(true);
  });

  it('extracts XFormParseException as the parser_message', () => {
    const stderr = `
      Loading app...
      Caused by: org.javarosa.xform.parse.XFormParseException: Bad tag in <data> at line 42 col 5
        at org.javarosa.xform.parse.XFormParser.parseInstance(XFormParser.java:1234)
    `;
    const r = parseValidatorOutput({ ...defaultInput, exitCode: 1, stderr });
    expect(r.verdict).toBe('fail');
    expect(r.parser_message).toContain('XFormParseException');
    expect(r.parser_message).toContain('Bad tag');
    expect(r.parser_message).toContain('line 42');
  });

  it('extracts InvalidResourceException + failed_resource', () => {
    const stderr = `
      Failed to install resource: jr://resource/modules-0/forms-0.xml
      org.commcare.resources.model.InvalidResourceException: bad case bind on entity_id
    `;
    const r = parseValidatorOutput({ ...defaultInput, exitCode: 1, stderr });
    expect(r.verdict).toBe('fail');
    expect(r.failed_resource).toBe('jr://resource/modules-0/forms-0.xml');
    expect(r.parser_message).toContain('InvalidResourceException');
    expect(r.parser_message).toContain('bad case bind');
  });

  it('extracts UnresolvedResourceException (generic-installer path)', () => {
    const stderr = `
      Caused by: org.commcare.resources.model.UnresolvedResourceException:
      jr://resource/suite.xml could not be resolved.
    `;
    const r = parseValidatorOutput({ ...defaultInput, exitCode: 1, stderr });
    expect(r.verdict).toBe('fail');
    expect(r.parser_message).toContain('UnresolvedResourceException');
  });

  it('zero exit but stderr names UnresolvedResourceException → still fail', () => {
    // commcare-cli's CliValidateCommand sometimes logs the exception to stderr
    // but exits 0 if the wrapper catches it. We treat the named exception as
    // authoritative because the device install would reject the same CCZ.
    const stderr = 'WARN: UnresolvedResourceException: jr://resource/foo.xml missing\n';
    const r = parseValidatorOutput({ ...defaultInput, exitCode: 0, stderr });
    expect(r.verdict).toBe('fail');
  });

  it('zero exit + stdout FAILURE prefix → fail', () => {
    const stdout = 'FAILURE: cannot configure app — see stderr\n';
    const r = parseValidatorOutput({ ...defaultInput, stdout });
    expect(r.verdict).toBe('fail');
  });

  it('extracts XPathException', () => {
    const stderr = 'org.javarosa.xpath.XPathException: Cannot resolve #case/case_name at install\n';
    const r = parseValidatorOutput({ ...defaultInput, exitCode: 1, stderr });
    expect(r.verdict).toBe('fail');
    expect(r.parser_message).toContain('XPathException');
    expect(r.parser_message).toContain('case_name');
  });

  it('truncates oversized stdout/stderr to MAX_LOG_CHARS', () => {
    const big = 'x'.repeat(10_000);
    const r = parseValidatorOutput({ ...defaultInput, stdout: big });
    expect(r.stdout.length).toBeLessThan(big.length);
    expect(r.stdout).toContain('truncated');
    expect(r.stdout).toContain('original 10000 chars');
  });

  it('handles missing exit code (-1) as fail', () => {
    const r = parseValidatorOutput({ ...defaultInput, exitCode: -1 });
    expect(r.verdict).toBe('fail');
    expect(r.exit_code).toBe(-1);
  });
});

/**
 * These cases assert the INPUT-validation error kinds, and `commcareCliValidateCcz`
 * checks for Java FIRST (lib/commcare-cli-validate.ts — the java-first guard added
 * by bb36c267). Without an explicit javaPath every one of them throws
 * `java_not_found` on a machine with no JDK on PATH — including GitHub runners that
 * do not preinstall one — so `clean-install`, the only REQUIRED check on main, went
 * red on unrelated PRs (dimagi-internal/ace#1535, hit live on #1533).
 *
 * An explicit path is returned verbatim without probing (pinned by the
 * 'returns an explicit path verbatim without probing' case above), so this satisfies
 * the guard and lets the assertion under test actually run. Nothing is ever spawned —
 * each case throws before reaching the spawn.
 */
const PINNED_JAVA = '/pinned/java-for-input-validation-tests';

describe('commcareCliValidateCcz — input validation', () => {
  it('throws CommCareCliInputError when CCZ does not exist', async () => {
    await expect(
      commcareCliValidateCcz({
        cczPath: '/tmp/nonexistent-ccz-' + Date.now() + '.ccz',
        jarPath: '/tmp/anything.jar',
        javaPath: PINNED_JAVA,
      }),
    ).rejects.toMatchObject({ name: 'CommCareCliInputError', kind: 'ccz_not_found' });
  });

  it('throws CommCareCliInputError when CCZ is empty', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ace-ccz-empty-'));
    const cczPath = path.join(dir, 'empty.ccz');
    writeFileSync(cczPath, '');
    await expect(
      commcareCliValidateCcz({ cczPath, jarPath: '/tmp/anything.jar', javaPath: PINNED_JAVA }),
    ).rejects.toMatchObject({ name: 'CommCareCliInputError', kind: 'ccz_empty' });
  });

  it('throws CommCareCliInputError when jar does not exist', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ace-ccz-jar-'));
    const cczPath = path.join(dir, 'fake.ccz');
    writeFileSync(cczPath, 'PK\x03\x04dummy zip-like bytes');
    await expect(
      commcareCliValidateCcz({
        cczPath,
        jarPath: '/tmp/nonexistent-jar-' + Date.now() + '.jar',
        javaPath: PINNED_JAVA,
      }),
    ).rejects.toMatchObject({ name: 'CommCareCliInputError', kind: 'jar_not_found' });
  });

  /**
   * Class-level preventer for ace#1535.
   *
   * The cases above are environment-independent only because each pins
   * `javaPath`. A fourth case added without it would pass on every developer
   * machine with a JDK and fail only on a java-less runner — the worst failure
   * signature there is, because it reads as flake and gets re-run rather than
   * fixed. #1535 cost two red `clean-install` runs on an unrelated PR before
   * anyone traced it. The instance fix pins three call sites; this asserts the
   * property structurally, so the next author cannot reintroduce the class by
   * not reading the comment above.
   */
  it('every commcareCliValidateCcz input-validation case pins javaPath', () => {
    const src = readFileSync(new URL('./commcare-cli-validate.test.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf("describe('commcareCliValidateCcz — input validation'"));
    const calls = [...body.matchAll(/commcareCliValidateCcz\(\{[\s\S]*?\}\)/g)].map((m) => m[0]);
    expect(calls.length, 'regex matched no calls — it has drifted from the call shape').
      toBeGreaterThanOrEqual(3);
    const unpinned = calls.filter((c) => !c.includes('javaPath'));
    expect(
      unpinned,
      'commcareCliValidateCcz probes java FIRST and short-circuits with java_not_found, ' +
        'so an input-validation call omitting javaPath asserts a kind it cannot reach on ' +
        'a java-less runner. Add `javaPath: PINNED_JAVA`. See ace#1535.',
    ).toEqual([]);
  });

  it('CommCareCliInputError carries the offending path + kind', () => {
    const err = new CommCareCliInputError('jar_not_found', '/missing/path.jar');
    expect(err.name).toBe('CommCareCliInputError');
    expect(err.kind).toBe('jar_not_found');
    expect(err.path).toBe('/missing/path.jar');
    expect(err.message).toContain('jar_not_found');
    expect(err.message).toContain('/missing/path.jar');
  });
});

describe('parsePlayOutput', () => {
  const base = {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    timeoutMs: 30_000,
    entryPath: [0, 0],
  };

  it('returns pass on clean form open + benign EOF NPE', () => {
    // Real-world LEARN walk: form intro screen shown, then stdin EOF
    // triggers the benign "input is null" NPE at loopSession:267.
    const stdout = `
Locales defined:
* en
Restoring user data from local file /tmp/restore.xml
Setting logged in user to: demo
Bednet Spot-Check — Learn | demo [1]
====================
0) Connect Platform Quiz
> Answer the question below to unlock the Deliver app.
Press Return to Proceed
Quitting!
> Unhandled Fatal Error executing CommCare app
java.lang.NullPointerException: Cannot invoke "String.startsWith(String)" because "input" is null
    at org.commcare.util.cli.ApplicationHost.loopSession(ApplicationHost.java:267)
`;
    const r = parsePlayOutput({ ...base, stdout });
    expect(r.verdict).toBe('pass');
    expect(r.failing_binding).toBeUndefined();
    expect(r.unresolved_xpath).toBeUndefined();
  });

  it('returns fail with the bednet-class binding diagnostics on XPathTypeMismatchException', () => {
    // Real-world DELIVER output from the bednet-spot-check/20260525-1405
    // Phase 6 reproducer.
    const stdout = `
Starting form entry with the following stack frame
Live Frame
----------
COMMAND: m0
DATUM : case_id_new_bednet_visit_0 - 85064263-6469-4a1e-9e75-0fe39a02bc74
COMMAND: m0-f0
Unhandled Fatal Error executing CommCare app
org.javarosa.xpath.XPathTypeMismatchException: Calculation Error: Error in calculation for /data/du_bednet_visit/deliver
Logic references instance(commcaresession)/session/data/case_id which is not a valid question or value.
    at org.javarosa.xpath.XPathNodeset.getInvalidNodesetException(XPathNodeset.java:146)
    at org.javarosa.core.model.FormDef.initAllTriggerables(FormDef.java:1004)
`;
    const r = parsePlayOutput({ ...base, stdout });
    expect(r.verdict).toBe('fail');
    expect(r.failing_binding).toBe('/data/du_bednet_visit/deliver');
    expect(r.unresolved_xpath).toBe('instance(commcaresession)/session/data/case_id');
    expect(r.parser_message).toContain('XPathTypeMismatchException');
    expect(r.parser_message).toContain('Calculation Error');
  });

  it('returns fail on bare XPathException without "Fatal Error" prefix', () => {
    const stdout = 'Some output. org.javarosa.xpath.XPathException: cannot bind';
    const r = parsePlayOutput({ ...base, stdout });
    expect(r.verdict).toBe('fail');
    expect(r.parser_message).toContain('XPathException');
  });

  it('returns fail on XFormParseException (also covered by validate but visible in play too)', () => {
    const stdout =
      'Unhandled Fatal Error executing CommCare app\norg.javarosa.xform.parse.XFormParseException: bad tag at line 5';
    const r = parsePlayOutput({ ...base, stdout });
    expect(r.verdict).toBe('fail');
    expect(r.parser_message).toContain('XFormParseException');
  });

  it('treats timeouts as fail regardless of output', () => {
    const r = parsePlayOutput({ ...base, timedOut: true });
    expect(r.verdict).toBe('fail');
    expect(r.timed_out).toBe(true);
  });

  it('reports the entry_path back to the caller', () => {
    const r = parsePlayOutput({ ...base, entryPath: [2, 0] });
    expect(r.entry_path).toEqual([2, 0]);
  });

  it('does NOT flip to fail on stderr that only contains the EOF NPE (loopSession)', () => {
    const stderr =
      'java.lang.NullPointerException: Cannot invoke "String.startsWith(String)" because "input" is null\n  at org.commcare.util.cli.ApplicationHost.loopSession(ApplicationHost.java:267)';
    const r = parsePlayOutput({ ...base, stderr });
    expect(r.verdict).toBe('pass');
  });

  it('truncates oversized stdout via shared trimLog', () => {
    const big = 'y'.repeat(10_000);
    const r = parsePlayOutput({ ...base, stdout: big });
    expect(r.stdout.length).toBeLessThan(big.length);
    expect(r.stdout).toContain('truncated');
  });

  //
  // dimagi-internal/ace#1088 — an empty casedb makes every `followup` form
  // unreachable. The crash lands in case-LIST rendering, before form-init
  // ever runs, so calling it a `cli-form-init-error` is a category error.
  //
  it('does not classify an empty-casedb entity-list crash as a form-init defect', () => {
    // Verbatim from spark-facilitator/20260730-1718, Deliver app
    // fc14076ff22d4b199451ea2cba4cd48f entry_path [0,0].
    const stderr = [
      'java.lang.ArrayIndexOutOfBoundsException: Index 0 out of bounds for length 0',
      '\tat org.commcare.util.screen.EntityListSubscreen.handleInputAndUpdateHost(EntityListSubscreen.java:220)',
      '\tat org.commcare.util.screen.CompoundScreenHost.handleInputAndUpdateSession(CompoundScreenHost.java:40)',
      '\tat org.commcare.util.cli.ApplicationHost.loopSession(ApplicationHost.java:341)',
    ].join('\n');
    const stdout =
      'Case | demo [5]\n====\n> Unhandled Fatal Error executing CommCare app';
    const r = parsePlayOutput({ ...base, stdout, stderr });
    expect(r.verdict).not.toBe('fail');
    expect(r.verdict).toBe('skipped');
    expect(r.skip_reason).toBe('empty-case-list');
    expect(r.failing_binding).toBeUndefined();
  });

  it('a REAL form-init defect still wins even if the case list also crashed', () => {
    // Precedence guard: the empty-case-list classifier must never mask an
    // XPath form-init failure. Known-defect classes are tested first.
    const stdout = [
      'Unhandled Fatal Error executing CommCare app',
      'org.javarosa.xpath.XPathTypeMismatchException: Calculation Error: Error in calculation for /data/du/deliver',
      '\tat org.commcare.util.screen.EntityListSubscreen.handleInputAndUpdateHost(EntityListSubscreen.java:220)',
      'java.lang.ArrayIndexOutOfBoundsException: Index 0 out of bounds for length 0',
    ].join('\n');
    const r = parsePlayOutput({ ...base, stdout });
    expect(r.verdict).toBe('fail');
    expect(r.failing_binding).toBe('/data/du/deliver');
  });

  it('does NOT treat a bare loopSession frame as benign (guards against ace#1025 over-widening)', () => {
    // ace#1025 proposes matching `ApplicationHost.loopSession(...)` anywhere
    // in the stream. Every crash unwinds through loopSession, so that would
    // reclassify real crashes as benign. Only the `input is null` NPE — the
    // stdin-EOF artifact — is benign.
    const stdout = [
      'Unhandled Fatal Error executing CommCare app',
      'java.lang.IllegalStateException: something genuinely broken',
      '\tat org.commcare.util.cli.ApplicationHost.loopSession(ApplicationHost.java:341)',
    ].join('\n');
    expect(parsePlayOutput({ ...base, stdout }).verdict).toBe('fail');
  });
});

describe('extractCaseTypesFromSuite (ace#1088)', () => {
  it('pulls the case type off an entry datum nodeset', () => {
    const suite = `<suite>
      <entry>
        <command id="m0-f0"/>
        <session>
          <datum id="case_id"
                 nodeset="instance('casedb')/casedb/case[@case_type='fcap_community'][@status='open']"
                 value="./@case_id" detail-select="m0_case_short"/>
        </session>
      </entry>
    </suite>`;
    expect(extractCaseTypesFromSuite(suite)).toEqual(['fcap_community']);
  });

  it('de-duplicates and returns every distinct case type in the app', () => {
    const suite = `<suite>
      <entry><session><datum nodeset="instance('casedb')/casedb/case[@case_type='household'][@status='open']"/></session></entry>
      <entry><session><datum nodeset="instance('casedb')/casedb/case[@case_type='member'][@status='open']"/></session></entry>
      <entry><session><datum nodeset="instance('casedb')/casedb/case[@case_type='household'][@status='open']"/></session></entry>
    </suite>`;
    expect(extractCaseTypesFromSuite(suite).sort()).toEqual(['household', 'member']);
  });

  it('handles double-quoted predicates', () => {
    const suite = `<suite><entry><session><datum nodeset='instance("casedb")/casedb/case[@case_type="visit"]'/></session></entry></suite>`;
    expect(extractCaseTypesFromSuite(suite)).toEqual(['visit']);
  });

  it('returns [] for a registration-only app with no case datums', () => {
    const suite = `<suite><entry><command id="m0-f0"/></entry></suite>`;
    expect(extractCaseTypesFromSuite(suite)).toEqual([]);
  });

  it('returns [] rather than throwing on unparseable input', () => {
    expect(extractCaseTypesFromSuite('')).toEqual([]);
    expect(extractCaseTypesFromSuite('not xml at all')).toEqual([]);
  });
});

describe('buildPlayRestoreXml (ace#1088)', () => {
  it('emits the demo Registration block with no cases by default', () => {
    const xml = buildPlayRestoreXml();
    expect(xml).toContain('<username>demo</username>');
    expect(xml).not.toContain('<case ');
  });

  it('seeds one open case per requested case type, owned by the demo user', () => {
    const xml = buildPlayRestoreXml({ caseTypes: ['fcap_community'] });
    expect(xml).toContain('<case_type>fcap_community</case_type>');
    // Case-list filters overwhelmingly key on ownership; an unowned case is
    // invisible to the restoring user and we'd be back to an empty list.
    expect(xml).toContain('<owner_id>demo-user-uuid</owner_id>');
    expect(xml).toContain('user_id="demo-user-uuid"');
    expect(xml).toContain('http://commcarehq.org/case/transaction/v2');
  });

  it('gives each seeded case a distinct case_id', () => {
    const xml = buildPlayRestoreXml({ caseTypes: ['a', 'b'] });
    const ids = Array.from(xml.matchAll(/case_id="([^"]+)"/g)).map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('is deterministic — same input, same restore', () => {
    expect(buildPlayRestoreXml({ caseTypes: ['x'] })).toBe(
      buildPlayRestoreXml({ caseTypes: ['x'] }),
    );
  });

  it('DEFAULT_PLAY_RESTORE_XML stays the zero-case form (back-compat)', () => {
    expect(DEFAULT_PLAY_RESTORE_XML).toBe(buildPlayRestoreXml());
  });

  it('finds the spark-facilitator case type straight off the real suite', () => {
    expect(extractCaseTypesFromSuite(SPARK_SUITE)).toEqual(['fcap_community']);
  });
});

describe('deriveNavInput (ace#1088)', () => {
  // Both sequences are calibrated against a live run of
  // commcare-cli-commcare_2.63.0.jar on the released spark-facilitator
  // Deliver CCZ: each reaches `Form Start: Press Return to proceed`.
  it('inserts a case-list hop + confirm for a followup entry', () => {
    // module 0 → case list (pick row 0) → detail confirm (Enter) → form 0.
    expect(deriveNavInput([0, 0], SPARK_SUITE)).toBe('0\n0\n\n0\n:quit\n');
  });

  it('inserts nothing for a registration entry whose datum is computed', () => {
    expect(deriveNavInput([1, 0], SPARK_SUITE)).toBe('1\n0\n:quit\n');
  });

  it('omits the confirm step when the datum has no detail-confirm', () => {
    const suite = `<suite><entry><command id="m0-f0"/><session>
      <datum id="case_id" nodeset="instance('casedb')/casedb/case[@case_type='x']" detail-select="m0_case_short"/>
    </session></entry></suite>`;
    expect(deriveNavInput([0, 0], suite)).toBe('0\n0\n0\n:quit\n');
  });

  it('falls back to the plain menu walk when the suite is unavailable', () => {
    expect(deriveNavInput([0, 0])).toBe('0\n0\n:quit\n');
    expect(deriveNavInput([2, 1], '<suite/>')).toBe('2\n1\n:quit\n');
  });

  it('sends NOTHING after form entry — stray keys are typed as answers', () => {
    // A trailing `0` on a date question raises
    // `IllegalArgumentException: Invalid cast of data [0] to type Date`,
    // which the classifier would read as a CCZ defect. Observed live.
    for (const nav of [deriveNavInput([0, 0], SPARK_SUITE), deriveNavInput([1, 0], SPARK_SUITE)]) {
      expect(nav.endsWith('\n:quit\n')).toBe(true);
      expect(nav.split('\n:quit')[0].split('\n')).not.toContain('0\n0\n0\n0');
    }
  });
});
