/**
 * ace#3340 — a CCZ whose form menus are unreachable on a phone.
 *
 * smallholder-seasonal/20261029-1243, coach Deliver build v51, CommCare 2.64.0:
 * 11 of 14 forms could not be opened. suite.xml shape of every broken root:
 *
 *   <menu id="m0"><command id="m0-case-list"/></menu>          (view-only entry)
 *   <menu root="m0" id="m1"><command id="m1-f0"/></menu>       (the form menu)
 *
 * Cause, from commcare-core `CommCareSession.getNeededData`: the entries of the
 * current command "m0" are [m0-case-list]; that entry needs a datum, and
 * `getDataNeededByAllEntries` returns STATE_DATUM_VAL BEFORE the session ever
 * asks the user to pick a command. Child menus (root="m0") are not entries of
 * m0, so they are never offered. The fixed v72 build had flat roots only.
 */
import { describe, it, expect } from 'vitest';
import { checkSuiteMenuReachability } from '../../lib/suite-menu-reachability.js';

const wrap = (menus: string, entries = '') =>
  `<suite>${entries}${menus}</suite>`;

const entries = `
<entry><command id="m0-case-list"/><instance id="casedb" src="jr://instance/casedb"/><session><datum id="case_id" nodeset="x" value="./@case_id"/></session></entry>
<entry><form>urn:xmlns:a</form><command id="m1-f0"/><session><datum id="case_id" nodeset="x" value="./@case_id"/></session></entry>
<entry><form>urn:xmlns:b</form><command id="m17-f0"/><session><datum id="case_id" nodeset="x" value="./@case_id"/></session></entry>
<entry><form>urn:xmlns:c</form><command id="m18-f0"/></entry>`;

describe('checkSuiteMenuReachability', () => {
  it('flags the v51 shape: a menu whose own list entry shadows its child form menus', () => {
    const suite = wrap(
      `<menu id="m0"><command id="m0-case-list"/></menu>
       <menu root="m0" id="m1"><command id="m1-f0"/></menu>
       <menu id="m17"><command id="m17-f0"/></menu>`,
      entries,
    );
    const r = checkSuiteMenuReachability(suite);
    expect(r.severity).toBe('blocker');
    expect(r.shadowed).toEqual([{ menu: 'm0', viewOnlyCommands: ['m0-case-list'], children: ['m1'] }]);
    expect(r.unreachableForms).toEqual(['m1-f0']);
  });

  it('passes flat root menus (the v72 shape): a case list per form menu, no children', () => {
    const suite = wrap(
      `<menu id="m1"><command id="m1-f0"/></menu>
       <menu id="m0"><command id="m0-case-list"/></menu>
       <menu id="m17"><command id="m17-f0"/></menu>`,
      entries,
    );
    const r = checkSuiteMenuReachability(suite);
    expect(r.severity).toBe('ok');
    expect(r.shadowed).toEqual([]);
    expect(r.unreachableForms).toEqual([]);
  });

  it('passes a pure grouping menu: children only, no command of its own', () => {
    const suite = wrap(
      `<menu id="m0"></menu><menu root="m0" id="m1"><command id="m1-f0"/></menu>`,
      entries,
    );
    expect(checkSuiteMenuReachability(suite).severity).toBe('ok');
  });

  it('passes a parent whose own commands are datum-free forms (the form list and child menus share one screen)', () => {
    const suite = wrap(
      `<menu id="m3"><command id="m18-f0"/></menu><menu root="m3" id="m1"><command id="m1-f0"/></menu>`,
      entries,
    );
    expect(checkSuiteMenuReachability(suite).severity).toBe('ok');
  });

  it('is never a silent pass on an unreadable suite', () => {
    expect(checkSuiteMenuReachability('not xml at all').severity).toBe('warn');
  });
});
