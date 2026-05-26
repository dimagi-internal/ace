import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseValidatorOutput,
  parsePlayOutput,
  commcareCliValidateCcz,
  CommCareCliInputError,
} from './commcare-cli-validate.js';

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

describe('commcareCliValidateCcz — input validation', () => {
  it('throws CommCareCliInputError when CCZ does not exist', async () => {
    await expect(
      commcareCliValidateCcz({
        cczPath: '/tmp/nonexistent-ccz-' + Date.now() + '.ccz',
        jarPath: '/tmp/anything.jar',
      }),
    ).rejects.toMatchObject({ name: 'CommCareCliInputError', kind: 'ccz_not_found' });
  });

  it('throws CommCareCliInputError when CCZ is empty', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ace-ccz-empty-'));
    const cczPath = path.join(dir, 'empty.ccz');
    writeFileSync(cczPath, '');
    await expect(
      commcareCliValidateCcz({ cczPath, jarPath: '/tmp/anything.jar' }),
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
      }),
    ).rejects.toMatchObject({ name: 'CommCareCliInputError', kind: 'jar_not_found' });
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
});
