/**
 * ace#2989 — the play restore carried no custom user data, so an app whose
 * menus are gated on `#user/<field>` threw in `MenuLoader.menuIsRelevant`
 * while the ROOT menu rendered, and every form graded `fail` /
 * `cli-form-init-error` before any form opened (kaduna-graduation/
 * 20261015-1411, all 33 forms). The restore now seeds every
 * `session/user/data/<key>` the CCZ reads, callers can pick a role branch,
 * the walk evaluates user-data-only menu relevance, and an unseeded read is
 * a harness skip. Device evidence (issue body): with `kgrad_role` seeded as
 * `FLW` / `enumerator` / `''`, all 16 Learn forms reached form entry.
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
  evalUserDataRelevance,
  extractUserDataKeys,
  parsePlayOutput,
  resolveEntryPath,
  type CliSpawn,
} from '../../lib/commcare-cli-validate.js';

const ROLE = "instance('commcaresession')/session/user/data/kgrad_role";

/** kaduna-graduation shape: every root menu gated on the role. */
const SUITE = `<suite>
  <entry><form>a</form><command id="m0-f0"><text/></command></entry>
  <entry><form>b</form><command id="m1-f0"><text/></command></entry>
  <entry><form>c</form><command id="m2-f0"><text/></command></entry>
  <entry><form>d</form><command id="m2-f1"><text/></command></entry>
  <menu id="m0" relevant="${ROLE} = &apos;FLW&apos;"><text/><command id="m0-f0"/></menu>
  <menu id="m1" relevant="${ROLE} = &apos;enumerator&apos;"><text/><command id="m1-f0"/></menu>
  <menu id="m2" relevant="${ROLE} = &apos;FLW&apos; or ${ROLE} = &apos;enumerator&apos;"><text/>
    <command id="m2-f0" relevant="${ROLE} != &apos;FLW&apos;"/>
    <command id="m2-f1"/>
  </menu>
</suite>`;

/** Verbatim from ace#2989. */
const MENU_LOADER_STACK = `org.javarosa.xpath.XPathTypeMismatchException: Logic references instance(commcaresession)/session/user/data/kgrad_role which is not a valid question or value.
	at org.commcare.suite.model.MenuLoader.menuIsRelevant(MenuLoader.java:143)
	at org.commcare.suite.model.MenuLoader.addUnaddedMenu(MenuLoader.java:126)
	at org.commcare.util.screen.MenuScreen.init(MenuScreen.java:93)`;

function play(stdout: string, stderr = '') {
  return parsePlayOutput({ exitCode: -1, stdout, stderr, timedOut: false, timeoutMs: 30000, entryPath: [0, 0] });
}

describe('extractUserDataKeys (ace#2989)', () => {
  it('finds every user data key across suite and forms, once each', () => {
    const form = `<bind nodeset="/data/x" calculate="instance('commcaresession')/session/user/data/district"/>`;
    expect(extractUserDataKeys(SUITE, form)).toEqual(['kgrad_role', 'district']);
  });
});

describe('buildPlayRestoreXml userData (ace#2989)', () => {
  it('emits each key after the name defaults, escaped', () => {
    const xml = buildPlayRestoreXml({ userData: { kgrad_role: 'FLW', note: 'a<b & "c"' } });
    expect(xml).toContain('<data key="commcare_first_name">Demo</data>');
    expect(xml).toContain('<data key="kgrad_role">FLW</data>');
    expect(xml).toContain('<data key="note">a&lt;b &amp; &quot;c&quot;</data>');
  });

  it('seeds an empty value as a PRESENT key', () => {
    expect(buildPlayRestoreXml({ userData: { kgrad_role: '' } })).toContain('<data key="kgrad_role"></data>');
  });

  it('a caller value overrides a default', () => {
    const xml = buildPlayRestoreXml({ userData: { commcare_first_name: 'Ada' } });
    expect(xml).toContain('<data key="commcare_first_name">Ada</data>');
    expect(xml).not.toContain('>Demo<');
  });
});

describe('parsePlayOutput: unseeded user data (ace#2989)', () => {
  it('the verbatim MenuLoader stack is skipped / cli-user-data-unseeded, not fail', () => {
    const res = play(`Unhandled Fatal Error executing CommCare app\n${MENU_LOADER_STACK}`);
    expect(res.verdict).toBe('skipped');
    expect(res.skip_reason).toBe('cli-user-data-unseeded');
    expect(res.unresolved_xpath).toBe('instance(commcaresession)/session/user/data/kgrad_role');
  });

  it('a real XPath defect in the same stream still fails', () => {
    const real =
      'org.javarosa.xpath.XPathTypeMismatchException: Logic references /data/visit/missing_q which is not a valid question or value.';
    const res = play(`${MENU_LOADER_STACK}\n${real}`);
    expect(res.verdict).toBe('fail');
  });

  it('a parser-class defect in the same stream still fails', () => {
    const res = play(`${MENU_LOADER_STACK}\nXFormParseException: bad bind`);
    expect(res.verdict).toBe('fail');
  });

  it('session/data (not user data) is a real defect', () => {
    const res = play(
      'XPathTypeMismatchException: Logic references instance(commcaresession)/session/data/case_id which is not a valid question or value.',
    );
    expect(res.verdict).toBe('fail');
  });
});

describe('evalUserDataRelevance (ace#2989)', () => {
  const ud = { kgrad_role: 'FLW' };
  it.each([
    [`${ROLE} = 'FLW'`, true],
    [`${ROLE} = 'enumerator'`, false],
    [`${ROLE} != 'FLW'`, false],
    [`${ROLE} = 'enumerator' or ${ROLE} = 'FLW'`, true],
    [`(${ROLE} = 'FLW') and ${ROLE} != ''`, true],
    [`"FLW" = ${ROLE}`, true],
  ])('%s → %s', (expr, want) => {
    expect(evalUserDataRelevance(expr, ud)).toBe(want);
  });

  it('an absent key reads as empty', () => {
    expect(evalUserDataRelevance(`${ROLE} = ''`, {})).toBe(true);
  });

  it.each([
    "count(instance('casedb')/casedb/case) > 0",
    `${ROLE} = 'FLW' and true()`,
    `not(${ROLE} = 'FLW')`,
    `${ROLE} = `,
  ])('refuses to guess at %s', (expr) => {
    expect(evalUserDataRelevance(expr, ud)).toBeUndefined();
  });
});

describe('resolveEntryPath evaluates user-data menu relevance (ace#2989)', () => {
  it('FLW sees m0 then m2; inside m2 the != FLW form is hidden', () => {
    expect(resolveEntryPath([0, 0], SUITE, { kgrad_role: 'FLW' }).commandId).toBe('m0-f0');
    expect(resolveEntryPath([1, 0], SUITE, { kgrad_role: 'FLW' }).commandId).toBe('m2-f1');
  });

  it('enumerator sees m1 then m2 with both forms', () => {
    const ud = { kgrad_role: 'enumerator' };
    expect(resolveEntryPath([0, 0], SUITE, ud).commandId).toBe('m1-f0');
    expect(resolveEntryPath([1, 0], SUITE, ud).commandId).toBe('m2-f0');
    expect(resolveEntryPath([1, 1], SUITE, ud).commandId).toBe('m2-f1');
  });

  it('an empty role hides every gated menu and says so instead of indexing past it', () => {
    const r = resolveEntryPath([0, 0], SUITE, { kgrad_role: '' });
    expect(r.commandId).toBeUndefined();
    expect(r.unresolved).toMatch(/lists 0 item/);
  });

  it('without user data the walk is relevance-blind, as before', () => {
    expect(resolveEntryPath([1, 0], SUITE).commandId).toBe('m1-f0');
  });
});

describe('commcareCliPlayCcz seeds the user data the CCZ reads (ace#2989)', () => {
  function run(userData?: Record<string, string>) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ace-userdata-'));
    const cczPath = path.join(dir, 'app.ccz');
    writeFileSync(cczPath, zipSync({ 'suite.xml': strToU8(SUITE) }));
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
        child.stdout.emit('data', Buffer.from('Starting form entry with the following stack frame\n'));
        child.emit('close', 0);
      });
      return child;
    };
    return commcareCliPlayCcz({ cczPath, jarPath, javaPath: 'java-fake', entryPath: [0, 0], userData, spawnImpl }).then(
      (res) => ({ res, restore }),
    );
  }

  it('every referenced key is present (empty) by default', async () => {
    const { res, restore } = await run({ kgrad_role: 'FLW' });
    expect(restore).toContain('<data key="kgrad_role">FLW</data>');
    expect(res.seeded_user_data).toEqual({ kgrad_role: 'FLW' });
    expect(res.command_id).toBe('m0-f0');
    expect(res.verdict).toBe('pass');
  });

  it('with no override the key is seeded empty and the gated root is reported, not run', async () => {
    const { res } = await run();
    expect(res.seeded_user_data).toEqual({ kgrad_role: '' });
    expect(res.verdict).toBe('skipped');
    expect(res.skip_reason).toBe('entry-path-unresolved');
  });
});
