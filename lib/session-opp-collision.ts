/**
 * "Another session on this host is already driving THIS opportunity."
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A WARNING, AND EXPLICITLY NOT A REFUSAL
 *
 * ace#1821 gave concurrent ACE sessions a per-session AVD name, per-session
 * ports, and cross-session contention detection. All of that is about the
 * DEVICE: two sessions must not cold-boot one emulator. This module is about
 * the OPPORTUNITY, which is a different resource with different rules.
 *
 * The operator's framing, verbatim:
 *
 *   "What would confuse the AI is if multiple AI agents are trying to run
 *    against the SAME opp since it will change the state of things like learn.
 *    But that's an error I can live with since it would be my own fault."
 *
 * So this is a LEGIBILITY fix, not a gate. Refusing here would be wrong on its
 * own terms — it would block a choice the operator is entitled to make, and it
 * would do so on evidence that is structurally incomplete (see the
 * cross-account limit below). The failure mode it prevents is not "the run
 * breaks"; it is "the run breaks and nobody can see why", which is exactly the
 * shape of ace#1821: every per-session number was correct and the truth was
 * only visible from outside any one session.
 *
 * It is also not a device-state guard. Connect's Learn completion is one-way
 * per `(test user, opportunity)` (CLAUDE.md § Gotchas), so two sessions on one
 * opp can consume a precondition neither can restore. A warning that names the
 * other session's pid is what turns that from a mystery into a decision.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT CAN AND CANNOT SEE
 *
 * The evidence is `~/.ace/sessions/*.lock.json`, which is a per-`$HOME` path.
 * On a host where two macOS accounts both run ACE — the exact configuration
 * ace#1821 measured, nine live MCPs under one account and one under the other
 * — the other account's locks are not merely unread, they are UNREADABLE.
 * `lib/mobile-contention.ts` reads `ps` for precisely this reason, and `ps`
 * cannot see an opp slug. So: absence of a collision is NOT evidence of
 * absence. That asymmetry is another reason this must not be a gate.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CLASSIFICATION: unit-test truth.
 *
 * Per CLAUDE.md — "does this change alter what is sent to, or matched against,
 * the device?" No. The inputs are JSON lock-file contents and environment
 * strings; the output is a set of pids and a string printed to stderr. Nothing
 * is sent to a device and nothing is matched against a device response.
 */

/** The opp/run this MCP session is working on, when it has been told. */
export interface SessionOppContext {
  opp_slug?: string;
  run_id?: string;
}

/**
 * Just enough of a session lock to reason about opp collisions. Structurally a
 * subset of `SessionLock` (`mcp/mobile/session-lock.ts`) so either can be
 * passed here; kept separate so this module stays free of the MCP's I/O.
 */
export interface SessionLockView {
  mcp_pid: number;
  started_at?: string;
  avd_name?: string;
  opp_slug?: string;
  run_id?: string;
}

const clean = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
};

/**
 * Resolve this session's opp context: an explicit per-call value wins, then
 * the environment.
 *
 * The env fallback matters because every MCP server reads `.env` once at module
 * load, so an `.env` write needs a full Claude Code restart to take effect
 * (CLAUDE.md § MCP changes need a full Claude restart) — while a call argument
 * needs none. The call argument is therefore the reliable path and the env is
 * the convenience; both are optional, and with neither set this whole feature
 * is inert and the lock is byte-identical to today's.
 */
export function resolveSessionOppContext(
  explicit: SessionOppContext | undefined,
  env: Record<string, string | undefined> = {},
): SessionOppContext {
  const opp_slug = clean(explicit?.opp_slug) ?? clean(env.ACE_OPP_SLUG);
  const run_id = clean(explicit?.run_id) ?? clean(env.ACE_RUN_ID);
  const out: SessionOppContext = {};
  if (opp_slug) out.opp_slug = opp_slug;
  if (run_id) out.run_id = run_id;
  return out;
}

/**
 * Merge a context patch into an existing lock, dropping empty values so a
 * blank argument can never erase a real one.
 *
 * Returns a NEW object; never mutates. Undefined/blank fields in the patch are
 * ignored rather than written as `undefined`, because `JSON.stringify` drops
 * `undefined` keys and a half-written lock reads as a lock that was never told
 * its opp — indistinguishable from the real thing.
 */
export function mergeSessionLockContext<T extends SessionLockView>(
  existing: T,
  patch: SessionOppContext & { avd_name?: string },
): T {
  const next: T = { ...existing };
  const opp = clean(patch.opp_slug);
  const run = clean(patch.run_id);
  const avd = clean(patch.avd_name);
  if (opp) next.opp_slug = opp;
  if (run) next.run_id = run;
  if (avd) next.avd_name = avd;
  return next;
}

/**
 * Other live sessions whose lock names the SAME opp as ours.
 *
 * Self-exclusion is by pid. Comparison is exact on the trimmed slug — no
 * case-folding and no fuzzy matching, because a false positive here prints a
 * scary warning about a run that is not actually colliding, and the operator
 * learns to ignore the message. An empty own-slug yields no collisions at all:
 * a session that was never told its opp has nothing to collide on.
 */
export function detectOppCollisions(
  self: { mcp_pid: number; opp_slug?: string },
  others: readonly SessionLockView[],
): SessionLockView[] {
  const mine = clean(self.opp_slug);
  if (!mine) return [];
  return others
    .filter((o) => o.mcp_pid !== self.mcp_pid && clean(o.opp_slug) === mine)
    .slice()
    .sort((a, b) => a.mcp_pid - b.mcp_pid);
}

/**
 * The operator-facing line. Returns null when there is nothing to say, so the
 * caller's happy path stays silent.
 *
 * Names each other session's pid, run id and AVD, because "another session is
 * using this opp" is not actionable and "pid 5784, run 20260905-0912, on
 * ACE_Pixel_API_34_b" is — that is enough to find the window, read its
 * transcript, or kill it. It states outright that nothing was blocked, so the
 * message cannot be misread as the cause of a later failure.
 */
export function describeOppCollision(
  oppSlug: string | undefined,
  collisions: readonly SessionLockView[],
): string | null {
  const mine = clean(oppSlug);
  if (!mine || collisions.length === 0) return null;
  const who = collisions
    .map((c) => {
      const bits = [`pid ${c.mcp_pid}`];
      if (c.run_id) bits.push(`run ${c.run_id}`);
      if (c.avd_name) bits.push(`avd ${c.avd_name}`);
      if (c.started_at) bits.push(`since ${c.started_at}`);
      return bits.join(', ');
    })
    .join('; ');
  const n = collisions.length;
  return (
    `opp '${mine}' is ALSO being driven by ${n} other live session${n === 1 ? '' : 's'} ` +
    `on this host (${who}). Proceeding — this is a warning, not a block. ` +
    `Two sessions on one opportunity share its Connect state, and Learn completion ` +
    `is one-way per (test user, opportunity), so whichever finishes Learn first ` +
    `consumes it for both. Only same-account sessions are visible here ` +
    `(~/.ace/sessions is per-$HOME), so this is a floor, not a count.`
  );
}
