//
// Pure check: is every `connect.learn_module` form in a released Learn CCZ
// reachable by EVERY worker — i.e. does no `<menu>` / `<command>` on the path
// to it carry a `relevant=` display condition?
//
// Contract truth (dimagi-internal/ace#3036, observed on a real device +
// Connect, kaduna-graduation/20261015-1411 Phase 6, 2026-10-16): Connect
// computes Learn completion over EVERY learn_module in the app. That Learn app
// held 14 learn_module markers, 9 display-gated to `#user/kgrad_role = 'FLW'`
// and 5 to `'enumerator'`. An FLW finished all 9 of hers and passed the
// assessment; `connect_get_learn_progress` then read
// `modules_completed_pct: 64.3` (9/14), `learn_complete: false`, and Deliver
// never unlocked. A role-gated Learn app therefore cannot be completed by ANY
// single role.
//
// Wire format (read from that run's released CCZ, build
// b7a5e1dcc83f482aabdf99858cdc97c0): Nova compiles a module display condition
// onto the suite menu, with `#user/<prop>` expanded to the session user-data
// path —
//
//   <menu id="m1" relevant="instance('commcaresession')/session/user/data/kgrad_role = 'FLW'" style="grid">
//     <command id="m1-f0"/>
//
// — and a FORM display condition onto the `<command>` itself. The form file
// `modules-N/forms-M.xml` (the `first_seen_in` of a
// `projected_connect_state.learn_modules[]` entry) is command `mN-fM`.
//
// Why this is a parser and not only a rubric line: the run's app-release-qa
// reported 31/31 checks green, and the Learn eval passed, on an app no worker
// could complete. Marker presence, slug length and time_estimate all read the
// form; only the suite sees who can open it.
//

import { checked, unable, type CheckOutcome } from './check-outcome';

export interface LearnModuleRef {
  /** Connect slug (`projected_connect_state.learn_modules[].slug`). */
  slug: string;
  /** CCZ path of the form carrying the marker, e.g. `modules-1/forms-0.xml`. */
  firstSeenIn: string;
}

export type DisplayGateClass =
  /** The condition reads a user property (`session/user/data/…`) — role gating. */
  | 'user-property'
  /** Some other display condition — the form may be unreachable for some workers. */
  | 'other-condition';

export interface DisplayGateFinding {
  slug: string;
  commandId: string;
  /** Where the condition sits: the form's own command, or a menu on its path. */
  gatedAt: Array<{ element: 'menu' | 'command'; id: string; relevant: string }>;
  gateClass: DisplayGateClass;
  /** `user-property` → blocker (ace#3036); other conditions → warn. */
  severity: 'blocker' | 'warn';
  message: string;
}

interface Menu {
  id: string;
  root: string;
  relevant: string | null;
  commands: Array<{ id: string; relevant: string | null }>;
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : null;
}

// Attribute runs match quoted strings whole: a `relevant=` XPath may hold a
// literal `>` ("count(...) > 0"), which a `[^>]*` run would cut short.
function parseMenus(suiteXml: string): Menu[] {
  const out: Menu[] = [];
  for (const m of suiteXml.matchAll(/<menu\b((?:[^>"]|"[^"]*")*)>([\s\S]*?)<\/menu>/g)) {
    const id = attr(m[1], 'id');
    if (!id) continue;
    const commands = [...m[2].matchAll(/<command\b((?:[^>"/]|"[^"]*")*)\/?>/g)]
      .map((c) => ({ id: attr(c[1], 'id'), relevant: attr(c[1], 'relevant') }))
      .filter((c): c is { id: string; relevant: string | null } => !!c.id);
    out.push({ id, root: attr(m[1], 'root') ?? 'root', relevant: attr(m[1], 'relevant'), commands });
  }
  return out;
}

/** `modules-1/forms-0.xml` → `m1-f0`; null when the path is not a form file. */
export function commandIdForFormPath(path: string): string | null {
  const m = path.match(/modules-(\d+)\/forms-(\d+)\.xml$/);
  return m ? `m${m[1]}-f${m[2]}` : null;
}

const USER_DATA = /session\/user\/data\//;

/**
 * Report every learn_module form that sits behind a display condition.
 * `unable` when there is nothing to check or a marker's form cannot be found
 * in the suite — a check that located nothing is not a pass.
 */
export function checkLearnModuleDisplayGating(input: {
  suiteXml: string;
  learnModules: LearnModuleRef[];
}): CheckOutcome<DisplayGateFinding> {
  const { suiteXml, learnModules } = input;
  if (!learnModules.length) {
    return unable('no learn_module markers were supplied — read projected_connect_state.learn_modules from commcare_download_ccz');
  }
  const menus = suiteXml ? parseMenus(suiteXml) : [];
  if (!menus.length) return unable('suite.xml has no <menu> elements — nothing to locate the learn_module forms in');
  const byId = new Map(menus.map((m) => [m.id, m]));

  const findings: DisplayGateFinding[] = [];
  for (const mod of learnModules) {
    const commandId = commandIdForFormPath(mod.firstSeenIn);
    if (!commandId) return unable(`learn_module ${mod.slug}: first_seen_in "${mod.firstSeenIn}" is not a modules-N/forms-M.xml path`);
    const holders = menus.filter((m) => m.commands.some((c) => c.id === commandId));
    if (!holders.length) return unable(`learn_module ${mod.slug}: command ${commandId} is not listed in any suite <menu>`);

    const gatedAt: DisplayGateFinding['gatedAt'] = [];
    for (const holder of holders) {
      const cmd = holder.commands.find((c) => c.id === commandId)!;
      if (cmd.relevant) gatedAt.push({ element: 'command', id: commandId, relevant: cmd.relevant });
      // Walk the menu and its ancestors: a gate anywhere on the path hides the form.
      const seen = new Set<string>();
      let cur: Menu | undefined = holder;
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        if (cur.relevant && !gatedAt.some((g) => g.element === 'menu' && g.id === cur!.id)) {
          gatedAt.push({ element: 'menu', id: cur.id, relevant: cur.relevant });
        }
        cur = cur.root === 'root' ? undefined : byId.get(cur.root);
      }
    }
    if (!gatedAt.length) continue;

    const userProp = gatedAt.some((g) => USER_DATA.test(g.relevant));
    findings.push({
      slug: mod.slug,
      commandId,
      gatedAt,
      gateClass: userProp ? 'user-property' : 'other-condition',
      severity: userProp ? 'blocker' : 'warn',
      message: userProp
        ? `learn_module ${mod.slug} (${commandId}) is display-gated on a user property. Connect counts every ` +
          `learn_module toward Learn completion, so a worker who cannot see this form can never reach 100% ` +
          `and Deliver never unlocks (ace#3036: 9/14 = 64.3% after an FLW passed).`
        : `learn_module ${mod.slug} (${commandId}) has a display condition; confirm every worker can reach it, ` +
          `because Connect counts every learn_module toward Learn completion (ace#3036).`,
    });
  }
  return checked(!findings.some((f) => f.severity === 'blocker'), findings);
}

export function formatLearnModuleDisplayGating(outcome: CheckOutcome<DisplayGateFinding>): string {
  if (outcome.status === 'unable') return `learn-module display gating: UNABLE TO CHECK — ${outcome.reason}`;
  if (!outcome.findings.length) return 'learn-module display gating: every learn_module form is ungated';
  return outcome.findings
    .map((f) => `[${f.severity.toUpperCase()}] ${f.message}\n  ` + f.gatedAt.map((g) => `${g.element} ${g.id}: ${g.relevant}`).join('\n  '))
    .join('\n');
}
