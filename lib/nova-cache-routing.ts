/**
 * Correlate the session handoff with the `nova_needs_auth_cache` verdict, so
 * preflight SELECTS a remediation branch instead of printing both and leaving
 * the choice to whoever is reading.
 *
 * ## The defect this closes
 *
 * ace#1769. `/ace:doctor --preflight` emits two blocks, adjacent, on one
 * screen:
 *
 *   nova_needs_auth_cache:
 *     status: fail
 *     cleared: true
 *     remediation: "… FIRST occurrence: Cmd-Q + reopen Claude Code … If you
 *                   have ALREADY restarted once since the last clear … the
 *                   cache is NOT the cause …"
 *   handoff_from_previous_session:
 *     age: 14m ago
 *     reason: 'Nova MCP bound the WRONG PRINCIPAL … A plain restart does NOT
 *              clear this …'
 *
 * Both facts needed to route are present. Nothing relates them. The handoff IS
 * the proof that a restart already happened and did not work, and the cheaper
 * wrong branch is the one listed first — so the operator does the restart the
 * evidence on the same screen already refutes, spends a full app restart
 * discovering it did nothing, and the next session re-derives the diagnosis
 * from scratch. Measured: three consecutive sessions on `spark-facilitator`,
 * ~14 minutes apart, each told by its predecessor that a restart would not
 * work.
 *
 * #1623/#1624 fixed the remediation TEXT and #1791 re-attributed the mechanism.
 * The residue is that nothing selects.
 *
 * ## Why this is worth more now than when it was filed
 *
 * When #1769 was written, both branches terminated in remedies that had failed,
 * so routing chose between two dead ends. `nova_header_readiness` (#1772) then
 * shipped and SELF-HEALS the real cause, and the orchestrator ranks it above
 * this block. The recurrence branch now leads somewhere that works, which makes
 * selecting it the difference between a fix and another restart.
 *
 * ## Why absence of a handoff is not evidence of a first occurrence
 *
 * A session can halt without writing one (crash, kill, a halt on a path that
 * does not call `writeHandoff`). So this routes to exactly two states:
 * `recurrence`, when a FRESH handoff names a Nova auth halt, and `unrouted`
 * otherwise — and `unrouted` emits the shipped conditional string byte for
 * byte. Nothing about the un-evidenced case changes.
 *
 * Pure and total. No I/O, no network, no throwing: the caller supplies the
 * handoff read, this decides.
 */
import type { SessionHandoff } from './session-handoff.js';

/**
 * A handoff `reason` / `established` / `next_command` that names a Nova AUTH
 * halt — as opposed to any other reason a session ended.
 *
 * Every marker is a phrase ACE itself writes into a handoff at this halt, or
 * that an operator writes describing it. `nova` alone is not enough: a handoff
 * saying "Nova finished the Deliver app, resuming at Phase 4" must not route a
 * cache verdict.
 */
const NOVA_AUTH_HALT_MARKERS: RegExp[] = [
  /\bneeds[-_\s]?auth\b/i,
  /\bnova_needs_auth_cache\b/i,
  /\bnova_header_readiness\b/i,
  /\bwrong principal\b/i,
  /\bclear authentication\b/i,
  /\bheaders?[-_]?helper\b/i,
  /\bnova\.hq\.read\b/i,
  /\bscope_missing\b/i,
  /\bcomplete_authentication\b/i,
  /\bauth(?:entication)?\s+halt\b/i,
  /\bmcp-needs-auth-cache\b/i,
];

/** `nova` must also be present — see the marker list above. */
const NAMES_NOVA = /\bnova\b/i;

/**
 * True when this handoff is evidence that a Nova auth halt ALREADY happened and
 * a restart ALREADY followed.
 *
 * Reads `reason`, `established` and `next_command` together: ACE writes the
 * cause into `reason`, but an operator-written handoff often puts it in the
 * established facts instead, and either is equally good evidence.
 */
export function handoffNamesNovaAuthHalt(handoff: SessionHandoff | null | undefined): boolean {
  if (!handoff) return false;
  const text = [handoff.reason ?? '', ...(handoff.established ?? []), handoff.next_command ?? ''].join(
    '\n',
  );
  if (!NAMES_NOVA.test(text)) return false;
  return NOVA_AUTH_HALT_MARKERS.some((r) => r.test(text));
}

export type NovaCacheRouting = 'recurrence' | 'unrouted';

export interface NovaCacheRoute {
  routing: NovaCacheRouting;
  /** The value of the preflight block's `recurrence:` field. */
  recurrence: 'confirmed-by-handoff' | 'not-established';
  /** The single remediation string to print. */
  remediation: string;
}

/**
 * The remediation ACE has shipped since #1791, unchanged. Emitted whenever the
 * handoff does NOT establish a recurrence — including when there is no handoff
 * at all, which is not the same thing as a first occurrence.
 *
 * Kept verbatim (and pinned by a test) so the un-evidenced path is provably
 * untouched by this change.
 */
export function unroutedRemediation(cleared: boolean, ctx: { cacheFile: string; clearResult: string }): string {
  const head = cleared
    ? 'plugin:nova:nova was stuck in needs-auth cache despite valid NOVA_API_KEY; the stale entry has been CLEARED automatically. FIRST occurrence: Cmd-Q + reopen Claude Code, then re-run your command (MCP subprocesses only rebind on a full restart). If you have ALREADY restarted once since the last clear and nova still exposes only authenticate/complete_authentication, the cache is NOT the cause: '
    : `plugin:nova:nova stuck in needs-auth cache despite valid NOVA_API_KEY; auto-clear did not apply (${ctx.clearResult}). Clear it from ${ctx.cacheFile} then Cmd-Q + reopen Claude Code (run /ace:doctor for the exact node one-liner). If you have ALREADY restarted once since the last clear and nova still exposes only authenticate/complete_authentication, the cache is NOT the cause: `;
  return `${head}NO Authorization header is reaching Nova. Claude Code 2.1.238+ stopped passing its process env to nova's env-dependent headersHelper, which emits {} -- the client then falls back to OAuth, whose token lacks nova.hq.read (voidcraft-labs/nova-plugin#52; the earlier stored-OAuth-precedence explanation was DISPROVED 2026-08-25 by logs showing 'No access token in storage'). Read the nova_header_readiness block, which OUTRANKS this one and installs the static-header override automatically, THEN Cmd-Q + reopen. Do NOT go to /mcp: 'Clear authentication' removes an OAuth token but restores no credential, so the session re-prompts OAuth immediately, and 'Authenticate' mints a token without nova.hq.read.`;
}

/**
 * The recurrence branch, alone.
 *
 * The "FIRST occurrence: Cmd-Q + reopen" sentence is ABSENT — not
 * de-emphasised, absent. That is the whole point: the handoff quoted alongside
 * it is proof that the restart already happened, so leaving the instruction on
 * screen leaves the cheaper wrong branch as the first thing read.
 */
export function recurrenceRemediation(handoffAgeMins: number, ctx: { cacheFile: string; cleared: boolean; clearResult: string }): string {
  const clearNote = ctx.cleared
    ? 'The stale entry has been cleared again, which will not change the outcome either.'
    : `Auto-clear did not apply (${ctx.clearResult}); clearing ${ctx.cacheFile} by hand will not change the outcome either.`;
  return (
    `RECURRENCE — a handoff written ${handoffAgeMins}m ago names a Nova auth halt, so a restart has ALREADY been done since the last clear and did not work. Do NOT restart-and-hope; the cache is NOT the cause. ${clearNote} ` +
    "NO Authorization header is reaching Nova: Claude Code 2.1.238+ stopped passing its process env to nova's env-dependent headersHelper, which emits {} -- the client then falls back to OAuth, whose token lacks nova.hq.read (voidcraft-labs/nova-plugin#52; the stored-OAuth-precedence explanation was DISPROVED 2026-08-25 by logs showing 'No access token in storage'). " +
    'DO THIS: (1) read the nova_header_readiness block, which OUTRANKS this one and installs the static-header override automatically; (2) THEN Cmd-Q + reopen Claude Code, which is what binds it; (3) verify BOTH list_projects returns the PAT project AND get_hq_connection returns configured:true. ' +
    "Do NOT go to /mcp: 'Clear authentication' removes an OAuth token but restores no credential, so the session re-prompts OAuth immediately, and 'Authenticate' mints a token without nova.hq.read."
  );
}

/**
 * Select the branch. The only decision in this module.
 *
 * `handoff` must be the FRESH read — a stale one says nothing about this
 * session, and treating an expired handoff as proof of a recurrence would route
 * a genuine first occurrence away from the restart that would have fixed it.
 */
export function routeNovaCacheRemediation(opts: {
  cleared: boolean;
  cacheFile: string;
  clearResult: string;
  /** The fresh handoff, or null when there is none / it is stale. */
  handoff: SessionHandoff | null;
  handoffAgeMs?: number;
}): NovaCacheRoute {
  const { cleared, cacheFile, clearResult, handoff, handoffAgeMs = 0 } = opts;
  if (handoffNamesNovaAuthHalt(handoff)) {
    return {
      routing: 'recurrence',
      recurrence: 'confirmed-by-handoff',
      remediation: recurrenceRemediation(Math.round(handoffAgeMs / 60000), {
        cacheFile,
        cleared,
        clearResult,
      }),
    };
  }
  return {
    routing: 'unrouted',
    recurrence: 'not-established',
    remediation: unroutedRemediation(cleared, { cacheFile, clearResult }),
  };
}
