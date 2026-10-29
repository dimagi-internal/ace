/**
 * ace#3340 — static check that every form menu in a released CCZ's suite.xml
 * can actually be offered to a worker.
 *
 * ## The failure
 *
 * Nova lets a module own a case list AND have child modules. HQ compiles that to
 *
 *   <menu id="m0"><command id="m0-case-list"/></menu>        view-only entry
 *   <menu root="m0" id="m1"><command id="m1-f0"/></menu>     child form menu
 *
 * On a phone (CommCare 2.64.0, smallholder-seasonal/20261029-1243) tapping m0
 * opened the case list at once and the child menus never appeared: 11 of 14
 * forms were unreachable, and `commcare_validate_ccz` (a JVM runtime, not run
 * on that build) was the only gate that could have noticed.
 *
 * ## Why (commcare-core, `CommCareSession.getNeededData`)
 *
 * The entries of the current command m0 are [m0-case-list]. That entry needs a
 * datum, and `getDataNeededByAllEntries(entries)` returns STATE_DATUM_VAL
 * BEFORE the session asks the user to choose a command. Child menus
 * (`root="m0"`) are not entries of m0, so they are never offered. Once the
 * datum is picked a view-only entry has no form, so the session just ends
 * ("DONE" on the detail screen, then back to the list).
 *
 * ## The rule
 *
 * A menu is SHADOWED when it has child menus (`root=<id>`) and at least one of
 * its own commands resolves to a view-only entry (no `<form>`) that needs a
 * datum. Fix the app, not the XML: make each form menu a root-level module with
 * its own case list (root tile -> pick the record -> the form), and give any
 * overview list its own root tile with no children.
 *
 * Narrow on purpose: a parent whose own commands are datum-free, or a pure
 * grouping menu, is not flagged — only the shape observed on a device is.
 */

export interface ShadowedMenu {
  menu: string;
  viewOnlyCommands: string[];
  children: string[];
}

export interface SuiteMenuReachability {
  severity: 'ok' | 'blocker' | 'warn';
  shadowed: ShadowedMenu[];
  /** form-entry command ids that sit only inside a shadowed menu's children */
  unreachableForms: string[];
  message: string;
}

interface EntryInfo {
  viewOnly: boolean;
  needsDatum: boolean;
}

export function checkSuiteMenuReachability(suiteXml: string): SuiteMenuReachability {
  const entries = new Map<string, EntryInfo>();
  for (const m of suiteXml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)) {
    const body = m[1];
    const cmd = /<command\s+id="([^"]+)"/.exec(body)?.[1];
    if (!cmd) continue;
    entries.set(cmd, { viewOnly: !/<form>/.test(body), needsDatum: /<datum\b/.test(body) });
  }

  const menus: { id: string; root: string | null; commands: string[] }[] = [];
  for (const m of suiteXml.matchAll(/<menu\b([^>]*?)(?:\/>|>([\s\S]*?)<\/menu>)/g)) {
    const id = /\bid="([^"]+)"/.exec(m[1])?.[1];
    if (!id) continue;
    menus.push({
      id,
      root: /\broot="([^"]+)"/.exec(m[1])?.[1] ?? null,
      commands: [...(m[2] ?? '').matchAll(/<command\s+id="([^"]+)"/g)].map((c) => c[1]),
    });
  }

  if (menus.length === 0) {
    return { severity: 'warn', shadowed: [], unreachableForms: [], message: 'suite.xml has no readable <menu> elements; reachability not checked' };
  }

  const shadowed: ShadowedMenu[] = [];
  const unreachableForms: string[] = [];
  for (const parent of menus) {
    const children = menus.filter((c) => c.root === parent.id);
    if (children.length === 0) continue;
    const viewOnlyCommands = parent.commands.filter((c) => {
      const e = entries.get(c);
      return e?.viewOnly && e.needsDatum;
    });
    if (viewOnlyCommands.length === 0) continue;
    shadowed.push({ menu: parent.id, viewOnlyCommands, children: children.map((c) => c.id) });
    for (const c of children) {
      for (const cmd of c.commands) if (entries.get(cmd) && !entries.get(cmd)!.viewOnly) unreachableForms.push(cmd);
    }
  }

  if (shadowed.length === 0) {
    return { severity: 'ok', shadowed, unreachableForms, message: 'every menu with child menus offers them (no view-only list entry in front of them)' };
  }
  return {
    severity: 'blocker',
    shadowed,
    unreachableForms,
    message:
      `${shadowed.length} menu(s) open a view-only case list instead of their child menus, so ` +
      `${unreachableForms.length} form(s) cannot be reached on a phone (ace#3340): ` +
      shadowed.map((s) => `${s.menu} -> [${s.children.join(', ')}]`).join('; '),
  };
}
