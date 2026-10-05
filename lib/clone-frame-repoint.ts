/**
 * lib/clone-frame-repoint.ts
 *
 * Re-point a cloned run's documents at frames the clone re-captured
 * (`skills/clone-to-new-workspace` § Step 4e, ace#2697).
 *
 * The problem: Step 2 copies the source run and re-points every Drive id at
 * the copy (lib/clone-readback.ts). Then Step 4b rebuilds Connect in the
 * partner's orgs, and Phase 4 re-captures `4-connect/previews/<slug>/` in the
 * new holding org. A re-capture REPLACES the folder's contents
 * (lib/output-previews.ts), so the frames get new ids. The training docs still
 * link the earlier frames, and those frames show the SOURCE org's header. On
 * spark/spark-facilitator/20261004-1706 the LLO guide named the clone's
 * opportunity but its two Connect frames read "ace-nm-org". The re-embed step
 * worked from the stale links, so it put the source frames back.
 *
 * The fix pairs each cited id that is no longer a live file in the target run
 * with the live file at the same run-relative path (`4-connect/previews/
 * connect-opportunity/01-overview.png`). That path is the stable key: a
 * re-capture keeps the folder and the frame name and changes only the id. A
 * cited IMAGE that has no live counterpart in the target run is `foreign`. An
 * outside reviewer would see another tenancy's screen, or be unable to open it
 * at all. The clone is not done while one remains.
 *
 * Pure: `scripts/clone-asset-rewrite.ts` walks Drive and resolves each cited
 * id's path.
 */

import { driveFileIdFromUrl } from './doc-image-embed.js';

/** A live (non-trashed) file in the TARGET run, path relative to the run folder. */
export interface LiveFile {
  id: string;
  path: string;
}

/** A Drive id a document cites or embeds, resolved by the caller. */
export interface CitedFile {
  id: string;
  /** Run-relative path when the file sits in the source or target run folder; null when outside both (or unreadable). */
  path: string | null;
  /** image/* — only images can be `foreign`; a link to another document is not a frame. */
  isImage: boolean;
  /**
   * A cross-opp baseline frame (`ACE/_common/connect-screenshots/<version>/`,
   * `connect-baseline-screenshots`). It lives outside every run on purpose and
   * shows Connect's generic onboarding screens, with no org on them. Never foreign.
   */
  shared?: boolean;
  /** Where it was found, for the report. */
  where?: string;
}

export interface FrameRepointPlan {
  /** stale id → live id at the same run path; feed to `rewriteDriveIds`. */
  ids: Record<string, string>;
  /** Cited images with no live counterpart in the target run — the blocker list. */
  foreign: CitedFile[];
}

const URL_RE = /https?:\/\/[^\s)\]"'<>]+/g;

/** Every Drive file id cited by URL in a text (markdown link, bare URL, `uc?export=view&id=`). */
export function citedDriveIds(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text ?? '').matchAll(URL_RE)) {
    const id = driveFileIdFromUrl(m[0]);
    if (id) out.add(id);
  }
  return [...out];
}

/**
 * Ids of the images EMBEDDED in a Google Doc (`inlineObjects[].…imageProperties.sourceUri`).
 * Docs keep the sourceUri the image was inserted from, which for ACE is
 * `driveImageUri(fileId)`. This is how the read-back sees an embedded frame
 * even after its citing link was rewritten.
 */
export function embeddedImageIds(doc: unknown): string[] {
  const objs = (doc as { inlineObjects?: Record<string, unknown> } | null)?.inlineObjects ?? {};
  const out = new Set<string>();
  for (const o of Object.values(objs)) {
    const uri = (o as any)?.inlineObjectProperties?.embeddedObject?.imageProperties?.sourceUri;
    const id = typeof uri === 'string' ? driveFileIdFromUrl(uri) : null;
    if (id) out.add(id);
  }
  return [...out];
}

/**
 * Pair every cited id that is not live in the target run with the live file at
 * the same run-relative path. A cited image with no such file is foreign. A
 * cited non-image with no live counterpart is left alone: it is a link, not a
 * frame, and Step 2's read-back owns stray source ids.
 */
export function planFrameRepoint(cited: readonly CitedFile[], live: readonly LiveFile[]): FrameRepointPlan {
  const liveIds = new Set(live.map((f) => f.id));
  const byPath = new Map<string, string>();
  for (const f of live) if (!byPath.has(f.path)) byPath.set(f.path, f.id);
  const plan: FrameRepointPlan = { ids: {}, foreign: [] };
  const seen = new Set<string>();
  for (const c of cited) {
    if (seen.has(c.id) || liveIds.has(c.id)) continue;
    seen.add(c.id);
    const to = c.path ? byPath.get(c.path) : undefined;
    if (to && to !== c.id) plan.ids[c.id] = to;
    else if (c.isImage && !c.shared) plan.foreign.push(c);
  }
  return plan;
}

/**
 * The read-back. After the plan is applied and the docs are re-embedded, every
 * image a document embeds must be a live file in the target run. Returns the
 * ids that are not. `shared` baseline frames (see `CitedFile.shared`) are exempt.
 */
export function embeddedOutsideRun(
  embedded: readonly string[],
  live: readonly LiveFile[],
  shared: ReadonlySet<string> = new Set(),
): string[] {
  const liveIds = new Set(live.map((f) => f.id));
  return [...new Set(embedded)].filter((id) => !liveIds.has(id) && !shared.has(id));
}
