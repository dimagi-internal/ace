/**
 * ace#2860 — `commcare_validate_ccz` play seeded no lookup-table fixtures, so
 * every form reading a `jr://fixture/item-list:<tag>` died in
 * `FormDef.initialize` and a clean build graded `fail` (→ app-release-qa
 * BLOCKER). The restore now seeds an empty root per item-list tag the CCZ
 * declares, and an unseeded-fixture crash is a harness skip, not a defect.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipSync, strToU8 } from 'fflate';

import {
  buildPlayRestoreXml,
  extractItemListFixtureTags,
  readCczItemListFixtureTags,
  parsePlayOutput,
} from '../../lib/commcare-cli-validate.js';

const FORM_WITH_LOOKUP = `<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head><model>
    <instance><data xmlns="http://openrosa.org/formdesigner/x"/></instance>
    <instance id="seasonal_calendar" src="jr://fixture/item-list:seasonal_calendar"/>
    <instance id="commcaresession" src="jr://instance/session"/>
  </model></h:head>
</h:html>`;

describe('extractItemListFixtureTags (ace#2860)', () => {
  it('finds the item-list tag a form instance declares', () => {
    expect(extractItemListFixtureTags(FORM_WITH_LOOKUP)).toEqual(['seasonal_calendar']);
  });

  it('dedupes across documents and ignores non-item-list instances', () => {
    const other = `<instance id="c" src="jr://fixture/item-list:curriculum"/>
      <instance id="s" src='jr://fixture/item-list:seasonal_calendar'/>
      <instance id="g" src="jr://fixture/user-groups"/>`;
    expect(extractItemListFixtureTags(FORM_WITH_LOOKUP, other)).toEqual([
      'seasonal_calendar',
      'curriculum',
    ]);
  });

  it('reads the tags straight out of a CCZ', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ace-2860-'));
    const ccz = path.join(dir, 'app.ccz');
    writeFileSync(
      ccz,
      zipSync({
        'suite.xml': strToU8('<suite/>'),
        'modules-0/forms-0.xml': strToU8(FORM_WITH_LOOKUP),
        'modules-8/forms-0.xml': strToU8(
          '<instance id="c" src="jr://fixture/item-list:curriculum"/>',
        ),
        'media/x.png': strToU8('jr://fixture/item-list:not_xml'),
      }),
    );
    expect(readCczItemListFixtureTags(ccz).sort()).toEqual(['curriculum', 'seasonal_calendar']);
  });
});

describe('buildPlayRestoreXml fixture seeding (ace#2860)', () => {
  it('seeds an empty item-list fixture root per tag, owned by the restore user', () => {
    const xml = buildPlayRestoreXml({ caseTypes: ['farmer'], fixtureTags: ['foo'] });
    expect(xml).toContain('<fixture id="item-list:foo" user_id="demo-user-uuid">');
    expect(xml).toContain('<foo_list></foo_list>');
    // The case seed is untouched.
    expect(xml).toContain('<case_type>farmer</case_type>');
  });

  it('seeds no fixtures by default (back-compat)', () => {
    expect(buildPlayRestoreXml()).not.toContain('<fixture');
  });

  it('a form declaring item-list:foo yields a restore carrying item-list:foo', () => {
    const form = '<instance id="x" src="jr://fixture/item-list:foo"/>';
    const xml = buildPlayRestoreXml({ fixtureTags: extractItemListFixtureTags(form) });
    expect(xml).toContain('item-list:foo');
  });
});

describe('parsePlayOutput: unseeded fixture is a harness skip (ace#2860)', () => {
  const base = { exitCode: 0, stderr: '', timedOut: false, timeoutMs: 30000, entryPath: [0, 0] };
  // Verbatim (abridged frames) from smallholder-seasonal/20261012-1549 m0-f0.
  const FIXTURE_CRASH = `Unhandled Fatal Error executing CommCare app
org.commcare.core.process.CommCareInstanceInitializer$FixtureInitializationException: Unable to find lookup table: jr://fixture/item-list:seasonal_calendar
\tat org.commcare.core.process.CommCareInstanceInitializer.loadFixtureRoot(CommCareInstanceInitializer.java:225)
\tat org.javarosa.core.model.FormDef.initialize(FormDef.java:1454)`;

  it('classifies FixtureInitializationException as skipped/cli-fixture-unseeded', () => {
    const r = parsePlayOutput({ ...base, stdout: FIXTURE_CRASH });
    expect(r.verdict).toBe('skipped');
    expect(r.skip_reason).toBe('cli-fixture-unseeded');
  });

  it('NEGATIVE CONTROL: a real XPath defect in the same stream still fails', () => {
    const r = parsePlayOutput({
      ...base,
      stdout: `${FIXTURE_CRASH}\norg.javarosa.xpath.XPathTypeMismatchException: Calculation Error`,
    });
    expect(r.verdict).toBe('fail');
  });
});
