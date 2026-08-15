/**
 * Converge concurrent `findOrCreate` writers onto one file.
 *
 * ace#1417. `findOrCreate: true` is CHECK-THEN-ACT, not atomic: list by name +
 * parent, update on a hit, create on a miss. Two writers of the same artifact
 * name both miss the lookup and both create, which is exactly the duplicate the
 * flag exists to prevent. Drive itself permits same-named siblings, so nothing
 * upstream rejects the second create.
 *
 * The window is not milliseconds. Hit live on bednet-check-2-visit/20260814-2019
 * Phase 1: a subagent published a 43 KB PDD via
 * `drive_create_doc_from_markdown` (~6.5 minutes in flight) while the parent
 * issued the identical call. Both returned `reused: false` with different
 * fileIds, and `1-design/` held two `idea-to-pdd.md`. It was caught only
 * because both responses happened to be read side by side.
 *
 * Blast radius is the one #1324 already argued: `verify_phase_artifacts` walks
 * the phase folder and matches by NAME, so both copies satisfy "present" while
 * a name-based read may resolve either. On that run the two copies DIFFERED —
 * one carried a later correction — so the wrong resolution would have shipped a
 * PDD missing its `## Program Parameters` handoff to Phases 2, 3, 6 and 8.
 *
 * ## The protocol
 *
 * Create first, then reconcile. After creating, re-list the siblings and pick a
 * canonical one by a rule every writer computes identically. Then:
 *
 *   - **won** (we are canonical) — keep ours, touch nothing else;
 *   - **lost** — write our content into the canonical file, then trash the file
 *     WE created, and return the canonical id.
 *
 * Two properties make this safe. A writer only ever trashes a file it created
 * itself, so a race can never destroy another writer's document. And the loser
 * applies its content to the winner rather than discarding it, which is exactly
 * what `findOrCreate` would have done had it seen the file — last writer wins
 * on content, the same as the sequential case.
 *
 * This does not make the operation atomic; Drive offers no uniqueness
 * constraint to make it so. It makes the outcome CONVERGE, which is the
 * property the callers actually need.
 */

export interface DriveSibling {
  id: string;
  /** RFC 3339. Absent on a client that did not request the field. */
  createdTime?: string | null;
}

/**
 * The canonical sibling: earliest `createdTime`, ties broken by lexicographic
 * id. Deterministic and total, so every writer picks the same one from the same
 * set without coordinating. A sibling with no `createdTime` sorts last — an
 * unknown creation time must never win, or two writers could disagree.
 */
export function pickCanonical(siblings: readonly DriveSibling[]): DriveSibling | undefined {
  if (siblings.length === 0) return undefined;
  return [...siblings].sort((a, b) => {
    const at = a.createdTime ?? '';
    const bt = b.createdTime ?? '';
    if (at !== bt) {
      if (!at) return 1;
      if (!bt) return -1;
      return at < bt ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}

export type ReconcileOutcome =
  /** Only one sibling, or we are canonical. Keep what we made. */
  | { action: 'keep'; canonicalId: string }
  /** We lost. Write our content into `canonicalId`, then trash `trashId`. */
  | { action: 'adopt'; canonicalId: string; trashId: string };

/**
 * Decide what a writer should do after creating `ourId`.
 *
 * `siblings` must be the post-create listing for the same name + parent,
 * including our own new file. Pure — the caller performs the Drive calls.
 */
export function reconcileAfterCreate(
  ourId: string,
  siblings: readonly DriveSibling[],
): ReconcileOutcome {
  const canonical = pickCanonical(siblings);
  // Defensive: an empty or self-only listing means there is nothing to
  // reconcile against. Never trash on incomplete information.
  if (!canonical || canonical.id === ourId) return { action: 'keep', canonicalId: ourId };
  if (!siblings.some((s) => s.id === ourId)) return { action: 'keep', canonicalId: ourId };
  return { action: 'adopt', canonicalId: canonical.id, trashId: ourId };
}
