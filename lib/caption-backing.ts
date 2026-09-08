//
// Does the PUBLISHED artifact only assert over frames someone actually looked at?
//
// Every other screenshot check in ACE answers "which file is this?" —
// `canonicalCaptures` (is it an alias), `findDuplicateCitations` (is it a
// second use), file_id resolution (does it exist). None answers "what is in
// the picture?", and that is the only question a caption can get wrong.
//
// Measured on turmeric-market-study/20260828-1108: an FLW guide and a 50-slide
// deck passed schema validation, 100% file_id resolution, zero duplicate
// citations, visual coverage 1.00 and 49 anonymously-verified inline images —
// and both captioned `journey-learn-posttest-result` as the certification
// result. It is the lesson menu with a "1 form sent to server!" toast. There is
// no score on it, and no frame of the score existed at all, because the recipe
// submits straight past the pass/fail label.
//
// Why this is a FENCE and not another helper: the first attempt at fixing this
// class shipped `framesCitedWithoutShows`, which takes a caller-supplied list
// of cited steps. Its only callers were its own tests — a producer had to
// remember to call it AND to hand it an honest list, which is two chances to
// skip the check. This function takes the PUBLISHED document instead and
// derives the citations from it, so there is nothing to curate: whatever the
// reader can see is what gets checked.
//

import { collectCaptureEntries, type CaptureManifestLike } from './capture-manifest.js';

export interface CaptionBackingFinding {
  /** Drive fileId as it appears in the published document. */
  file_id: string;
  /** Manifest step name, when the id is known to the manifest. */
  step?: string;
  reason:
    | 'no-shows'          // cited, known, but nobody recorded what it shows
    | 'duplicate-cited'   // cited an alias frame as though it were its own moment
    | 'unknown-id';       // cited an id the manifest does not contain at all
}

export interface CaptionBackingReport {
  ok: boolean;
  cited_total: number;
  cited_distinct: number;
  backed: number;
  findings: CaptionBackingFinding[];
}

interface ManifestFrame {
  step: string;
  file_id: string;
  shows?: string;
  duplicate_of?: string;
}

/**
 * Pull every Drive fileId a published document cites.
 *
 * Covers the two forms ACE artifacts actually use: the markdown LINK form
 * mandated by ace#1338 (`https://drive.google.com/file/d/<id>/view`) and the
 * `uc?export=view&id=<id>` form the deck specs use for Slides image imports.
 * Order is preserved; duplicates are kept so the caller can see re-use.
 */
export function extractCitedFileIds(published: string): string[] {
  const out: string[] = [];
  const patterns = [
    /https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,})/g,
    /https:\/\/drive\.google\.com\/uc\?export=view&(?:amp;)?id=([A-Za-z0-9_-]{10,})/g,
  ];
  for (const re of patterns) {
    for (const m of published.matchAll(re)) out.push(m[1]);
  }
  return out;
}

/**
 * Flatten a capture manifest into the frames a PUBLISHED artifact could cite.
 *
 * The walk over the containers in the wild — `captures[]`,
 * `journeys[].screenshots[]`, `journeys[].steps[]`, `journeys[].duplicates[]`,
 * with `step_name` accepted as an alias for `step` — lives in
 * `collectCaptureEntries` (`lib/capture-manifest.ts`), and this is the only
 * thing this function adds on top: a frame must carry a `file_id`, because a
 * citation is a fileId and an entry without one cannot be cited.
 *
 * It reads through the shared reader because it used to own a SECOND copy of
 * that walk, and the copies drifted in both directions. ace#2104 taught this
 * one `journeys[].steps[]` after `bednet-check-2-visit/20260902-1555` flattened
 * to ZERO frames and all 16 per-opp citations came back `unknown-id` —
 * including four the producer had itself written a `shows:` for, an UNFIXABLE
 * blocker whose only remedy is dropping every image, i.e. the hollow deck
 * ace#856's coverage gate exists to prevent. `capture-manifest.ts` was not
 * taught the same thing, so for four months its guards silently returned empty
 * on every real manifest and reported clean (ace#2224). One reader, so neither
 * failure can recur on one side only.
 */
export function flattenManifestFrames(manifest: unknown): ManifestFrame[] {
  const out: ManifestFrame[] = [];
  for (const e of collectCaptureEntries(manifest as CaptureManifestLike)) {
    // Duplicates are normally listed WITHOUT a file_id (they are not
    // published); the ones that carry one are kept so citing them is caught.
    const fileId = e.file_id;
    if (typeof fileId !== 'string' || !fileId) continue;
    out.push({
      step: e.step,
      file_id: fileId,
      shows: typeof e.shows === 'string' ? e.shows : undefined,
      duplicate_of: typeof e.duplicate_of === 'string' ? e.duplicate_of : undefined,
    });
  }
  return out;
}

/**
 * The fence. `ok` is false when the published artifact cites any frame that
 * nobody described, cites an alias as a distinct moment, or cites an id the
 * manifest does not know.
 *
 * A document citing NO frames is `ok` — a text-only artifact asserts nothing
 * over a screen, which is the honest outcome this check exists to make
 * available. Failing it would push producers toward decorative citations.
 */
export function classifyCaptionBacking(args: {
  published: string;
  manifest: unknown;
  /**
   * fileIds that are legitimately outside the per-opp manifest — the shared
   * `_common/connect-screenshots` pool and committed deck-template artwork.
   * They are not this run's work product and have no `shows` to record.
   */
  poolFileIds?: readonly string[];
}): CaptionBackingReport {
  const cited = extractCitedFileIds(args.published);
  const frames = flattenManifestFrames(args.manifest);
  const byId = new Map<string, ManifestFrame>();
  for (const f of frames) if (!byId.has(f.file_id)) byId.set(f.file_id, f);
  const pool = new Set(args.poolFileIds ?? []);

  const findings: CaptionBackingFinding[] = [];
  const seen = new Set<string>();
  let backed = 0;

  for (const id of cited) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (pool.has(id)) {
      backed++;
      continue;
    }
    const f = byId.get(id);
    if (!f) {
      findings.push({ file_id: id, reason: 'unknown-id' });
      continue;
    }
    if (f.duplicate_of) {
      findings.push({ file_id: id, step: f.step, reason: 'duplicate-cited' });
      continue;
    }
    if (!f.shows || !f.shows.trim()) {
      findings.push({ file_id: id, step: f.step, reason: 'no-shows' });
      continue;
    }
    backed++;
  }

  return {
    ok: findings.length === 0,
    cited_total: cited.length,
    cited_distinct: seen.size,
    backed,
    findings,
  };
}
