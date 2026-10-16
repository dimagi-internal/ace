/**
 * lib/labs-workspace.ts — read and drive a labs program's WORKSPACE settings
 * page, the one way to let a Connect org's members into a labs-only program
 * without widening its email-domain allowlist (ace#3020).
 *
 * A labs workspace "replaces all of the rules below with its roles": once a
 * labs-only program's organisation is a workspace, `allowed_domains` stops
 * applying, and every MEMBER of a Connect org listed as one of its LLOs is a
 * Network Manager there (connect-labs `labs/workspaces.py` rules 1-5,
 * `labs/synthetic/models.py` `is_accessible_to`). `clone-to-new-workspace` § 4c
 * lists the clone's OWN Connect orgs as the LLOs, so a reviewer the release adds
 * to those orgs opens the rebuilt dashboards through that Connect grant.
 *
 * There is no MCP atom for it (connect-labs#2572): the
 * page is `/microplans/program/<id>/workspace/` (connect-labs
 * `microplans/urls.py` `program_workspace_settings`, mounted at `microplans/`
 * in `config/urls.py`), a Django form for Dimagi sign-ins only
 * (`can_manage_access` → `is_dimagi_user`: @dimagi.com or @dimagi-ai.com, so
 * ace@ qualifies). Its POST actions are `turn_on` (`adopt_program`) and
 * `add_llo` (`slug`, `name`), each answering with a redirect back to the page
 * (`ProgramWorkspaceSettingsView.post`). The page itself is the read-back:
 * `templates/microplans/workspace_settings.html` renders the `turn_on` form
 * only while the program is not yet a workspace, and one `remove_llo` form
 * carrying `name="slug" value="<slug>"` per LLO.
 */

export function workspaceSettingsPath(programId: number): string {
  return `/microplans/program/${programId}/workspace/`;
}

export interface WorkspacePageState {
  /** The program's organisation is a labs workspace already. */
  is_workspace: boolean;
  /** LLO slugs the page lists (lower-cased). */
  llos: string[];
}

/** Read the settings page HTML. Throws when it is not the settings page at all (a login page, a 404). */
export function parseWorkspacePage(html: string): WorkspacePageState {
  const hasTurnOn = /name=["']action["'][^>]*value=["']turn_on["']/i.test(html);
  const hasAddLlo = /name=["']action["'][^>]*value=["']add_llo["']/i.test(html);
  if (!hasTurnOn && !hasAddLlo) {
    throw new Error('not the labs workspace settings page (no turn_on or add_llo form) — a stale labs session, or not a labs-only program');
  }
  const llos = new Set<string>();
  // each LLO row: <input type="hidden" name="action" value="remove_llo"> then <input type="hidden" name="slug" value="…">
  for (const m of html.matchAll(/value=["']remove_llo["'][^>]*>\s*<input[^>]*name=["']slug["'][^>]*value=["']([^"']+)["']/gi)) {
    llos.add(m[1].trim().toLowerCase());
  }
  return { is_workspace: !hasTurnOn && hasAddLlo, llos: [...llos].sort() };
}

/** The urlencoded body of one settings-page POST. */
export function workspaceFormBody(csrfToken: string, action: 'turn_on' | 'add_llo', fields: Record<string, string> = {}): string {
  const p = new URLSearchParams({ csrfmiddlewaretoken: csrfToken, action, ...fields });
  return p.toString();
}

/** What is still to do to make `llos` the workspace's LLOs (never removes one). */
export function workspaceSteps(state: WorkspacePageState, llos: readonly string[]): Array<{ action: 'turn_on' } | { action: 'add_llo'; slug: string }> {
  const steps: Array<{ action: 'turn_on' } | { action: 'add_llo'; slug: string }> = [];
  if (!state.is_workspace) steps.push({ action: 'turn_on' });
  const have = new Set(state.llos);
  for (const slug of [...new Set(llos.map((s) => s.trim().toLowerCase()).filter(Boolean))].sort()) {
    if (!have.has(slug)) steps.push({ action: 'add_llo', slug });
  }
  return steps;
}
