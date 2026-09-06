//
// Byte-distinctness for the CROSS-OPP common screenshot pool
// (`ACE/_common/connect-screenshots/<version>/`), built by
// `skills/common-screenshot-capture`.
//
// Why this is NOT `lib/capture-manifest.ts` (dimagi-internal/ace#1832)
// ------------------------------------------------------------------
// ace#866 already taught the PER-JOURNEY producer to hash every frame and mark
// byte-identical ones `duplicate_of: <canonical-step>`, and `capture-manifest`
// is the consumer half. That remedy is right there and WRONG here, and the
// difference is what this file exists to encode.
//
// In a journey, two byte-identical frames mean two recipe steps observed ONE
// moment. Redirecting the later step to the earlier one loses nothing: the
// canonical frame genuinely is what both steps saw.
//
// A pool alias is not a step — it is a SEMANTIC PROMISE. `sync-button` means
// "a picture of the sync control"; `connect-home` means "a picture of the
// Connect home screen". When those two aliases resolve to the same bytes, at
// least one of them is making a false promise, and no redirect can repair it:
// pointing `@sync-button` at the `connect-home` frame is exactly the defect,
// not the fix. A deck citing it captions the Connect home screen as the sync
// control, and a field worker is told to look for a control that is not in the
// picture.
//
// So the pool's rule is REJECT, not redirect.
//
// Why the whole group is quarantined and no alias is auto-elected
// ---------------------------------------------------------------
// A journey has an ordering that carries meaning (recipe order — the first
// step to observe a state owns it). A pool has none. `connect-home` and
// `sync-button` are captured by two independent recipes with no defined
// precedence between them, so "keep the first" would be a coin flip on which
// caption a trainee reads.
//
// This helper therefore DETECTS and REPORTS; it never elects a winner. Which
// alias is wrong is answerable — but only from the recipes, by a human or an
// agent that reads them, and that answer belongs in the recipe, not in a
// tiebreak rule here. (For the founding instance the answer was legible:
// `mcp/mobile/recipes/baseline/03-sync-button.yaml` takes
// `takeScreenshot: "sync-button"` BEFORE its own `tapOn: action_sync`, from a
// pre-state its own header declares identical to `00-connect-home.yaml`'s
// post-state. The duplicate is produced by construction, every time.)
//
// Ground truth for the founding instance, fetched unauthenticated 2026-09-06:
//   connect-home  1nUv5Yw4Z4L3xyXCU9xYZvrQBk9cLZADC
//   sync-button   1BqFXsUju_wFaIDYNsviTInBbOgGMzibp
//   md5  4d1c205591270cc4638b439c3a9981ff  (both)
//   sha256 b7b4eeac3d7e0f39c521999934e5b00c68e86dc409a9a3210ec4dca3407d61d2 (both)
//   242,393 bytes, 1080x2400 (both); `cmp` reports no difference.
//

/** One asset as the pool build sees it, before `manifest.yaml` is written. */
export interface PoolAsset {
  /** Manifest key / `@<alias>` reference used by the deck templates. */
  alias: string;
  /**
   * Content hash. Any digest works as long as ONE digest is used for the whole
   * pool — the check is equality between assets, never against a known value.
   * Callers pass `md5 -q` or `shasum -a 256` output.
   */
  digest: string;
  /** Provenance, for the operator-facing report. Not used in the comparison. */
  source?: 'live' | 'fixture' | 'template';
  [k: string]: unknown;
}

/** Two or more aliases that resolved to the same bytes. */
export interface AliasCollision {
  digest: string;
  /** Every colliding alias, sorted, so the report is stable across runs. */
  aliases: string[];
}

export interface PoolDistinctnessReport {
  verdict: 'pass' | 'fail';
  collisions: AliasCollision[];
  /**
   * Every alias in every collision group. These MUST NOT be published as
   * `source: live`; the pool build marks them `placeholder: true` so the deck
   * renders a visible empty slot rather than a confidently wrong caption.
   */
  quarantine: string[];
  /** Aliases safe to publish as captured. */
  publishable: string[];
}

function normalize(assets: readonly PoolAsset[]): PoolAsset[] {
  return assets.filter(
    (a) =>
      a &&
      typeof a.alias === 'string' &&
      a.alias.length > 0 &&
      typeof a.digest === 'string' &&
      a.digest.length > 0,
  );
}

/**
 * Groups of aliases sharing one digest. An asset with a missing or empty
 * `alias`/`digest` is ignored rather than grouped: a pool entry with no digest
 * has not been hashed yet, and grouping every un-hashed entry together would
 * manufacture a collision out of absent evidence — the one failure mode that
 * would get this check switched off.
 */
export function findAliasCollisions(assets: readonly PoolAsset[]): AliasCollision[] {
  const byDigest = new Map<string, string[]>();
  for (const a of normalize(assets)) {
    const list = byDigest.get(a.digest) ?? [];
    // An alias repeated verbatim is one entry, not a collision with itself.
    if (!list.includes(a.alias)) list.push(a.alias);
    byDigest.set(a.digest, list);
  }
  return [...byDigest.entries()]
    .filter(([, aliases]) => aliases.length > 1)
    .map(([digest, aliases]) => ({ digest, aliases: [...aliases].sort() }))
    .sort((a, b) => (a.aliases[0] < b.aliases[0] ? -1 : a.aliases[0] > b.aliases[0] ? 1 : 0));
}

/**
 * The pool-build gate. `verdict: 'fail'` on ANY collision — this is a hard
 * fail, not a warn, because a warn is what a mislabelled asset survives.
 */
export function classifyPoolDistinctness(
  assets: readonly PoolAsset[],
): PoolDistinctnessReport {
  const collisions = findAliasCollisions(assets);
  const quarantined = new Set(collisions.flatMap((c) => c.aliases));
  const all = normalize(assets).map((a) => a.alias);
  return {
    verdict: collisions.length > 0 ? 'fail' : 'pass',
    collisions,
    quarantine: [...quarantined].sort(),
    publishable: [...new Set(all.filter((alias) => !quarantined.has(alias)))].sort(),
  };
}

/**
 * Operator-facing lines for the skill's `auto_surfaced` block. Names the
 * recipe-shaped cause, because every instance found so far has had one: a
 * recipe that screenshots before its own state-changing command.
 */
export function describePoolCollisions(collisions: readonly AliasCollision[]): string[] {
  return collisions.map(
    (c) =>
      `[BLOCKER] Pool aliases ${c.aliases.map((a) => `\`${a}\``).join(' and ')} are ` +
      `byte-identical (digest ${c.digest}). At least one alias promises a surface it ` +
      `does not show. Read each alias's recipe: the usual cause is a ` +
      `\`takeScreenshot\` placed BEFORE the action that would make the surface ` +
      `distinct. Fix the recipe and re-capture; do not publish either alias as ` +
      `\`source: live\` until they differ.`,
  );
}
