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

import yaml from 'js-yaml';
import {
  assertManifestReadable,
  collectCaptureEntries,
  type CaptureManifestLike,
  type ManifestReadabilityReport,
} from './capture-manifest.js';
import {
  extractDriveFileId,
  imageRefsOnUnvalidatedSlide,
} from './training-deck-spec.js';

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
  /**
   * Citable frames the shared reader found in the manifest (ace#2236).
   *
   * Read this BEFORE reading `findings`. Zero here with a non-empty `findings`
   * means the manifest is unreadable, not that the producer cited wrong ids —
   * the failure presents as universal `unknown-id` and gets triaged at the
   * wrong artifact every time.
   */
  manifest_frames: number;
  /**
   * Present only when the manifest does not read back cleanly. Carries the
   * container the producer actually wrote to, by name.
   */
  manifest_readability?: ManifestReadabilityReport;
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
 * A published TRAINING-DECK SPEC carries something a rendered document does
 * not: an INVENTORY.
 *
 * `manifest.{opp,common,template}` is the resolution map — every alias the
 * deck COULD place, lifted wholesale from `app-screenshot-capture_manifest.yaml`
 * by `training-deck-generate` § step 5 — and the slides then place a handful of
 * them by `@alias`. To a whole-text scan the two are indistinguishable, so
 * every frame the run CAPTURED read as a frame the deck ASSERTS OVER, and the
 * skill's own BLOCKER became unpassable by construction on a correctly-authored
 * spec: the only ways to satisfy it were to back-fill `shows:` onto dozens of
 * frames nobody cites, or to stop reading the gate.
 *
 * Measured on spark-facilitator/20260907-1120: 10 images on slides, and
 * `{cited_total: 91, backed: 13, findings: 66 x no-shows + 12 x
 * duplicate-cited}` — every finding naming a frame no slide cites. (ace#2238)
 *
 * So for a deck spec the citations are derived the way a reader of the RENDERED
 * DECK would see them: what the slides place, resolved through the map. The
 * gate is not relaxed — an inventory entry a slide DOES place is judged exactly
 * as before, and so is any Drive link elsewhere in the spec (a slide body, a
 * note): the exemption is scoped to the map itself, not to the document.
 *
 * Returns `null` when the text is not a deck spec, which is the signal to fall
 * back to the whole-text scan that is right for every rendered artifact.
 */
export function extractDeckSpecCitations(published: string): string[] | null {
  let doc: unknown;
  try {
    doc = yaml.load(published);
  } catch {
    return null; // not YAML at all — a rendered Doc, markdown, prose
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const d = doc as Record<string, unknown>;
  const manifest = d.manifest;
  if (!Array.isArray(d.modules)) return null;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;

  // The resolution map, in `resolveManifest` precedence: opp > common > template.
  const merged = new Map<string, string>();
  // Every row, including one a later bucket overrides — the subtraction below
  // is over TEXT, and an overridden row is still a line in the document.
  const allValues: string[] = [];
  for (const bucket of ['template', 'common', 'opp'] as const) {
    const entries = (manifest as Record<string, unknown>)[bucket];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
    for (const [alias, value] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      merged.set(alias, value);
      allValues.push(value);
    }
  }

  const placed: string[] = [];
  // Ids a slide placed by writing the Drive URL out in full: those occur in
  // the document text too, so the loose-citation arithmetic below must not
  // count them a second time.
  const placedLiterally = new Map<string, number>();
  for (const mod of d.modules) {
    const slides = (mod as Record<string, unknown> | null)?.slides;
    if (!Array.isArray(slides)) continue;
    for (const slide of slides) {
      for (const ref of imageRefsOnUnvalidatedSlide(slide)) {
        const alias = ref.startsWith('@') ? ref.slice(1) : ref;
        const value = merged.get(alias);
        let id: string | null;
        if (value !== undefined) {
          id = extractDriveFileId(value);
        } else if (/^https?:\/\//.test(ref)) {
          // An inline URL: a Drive one is a citation, an external one is not.
          id = extractDriveFileId(ref);
          if (id) bump(placedLiterally, id);
        } else {
          // An alias the map does not carry. Kept VERBATIM so it lands as
          // `unknown-id` — a slide asserting over a frame that does not exist
          // is the same defect whether the generator invented the alias or
          // the id, and dropping it would let the fence pass the spec that
          // step 9's `@alias` resolution check is meant to fail.
          id = ref;
        }
        if (!id) continue;
        placed.push(id);
      }
    }
  }

  // Everything ELSE a reader can see in the spec — a Drive link in a slide
  // body or a note — is read the way a rendered document is read. Only the map
  // ROWS are exempt, and only as rows: each contributes exactly one textual
  // occurrence, so subtracting that leaves any other mention standing, even
  // for an id the map also carries.
  const outside = tally(extractCitedFileIds(published));
  for (const value of allValues) {
    for (const id of extractCitedFileIds(value)) outside.set(id, (outside.get(id) ?? 0) - 1);
  }
  for (const [id, n] of placedLiterally) outside.set(id, (outside.get(id) ?? 0) - n);
  for (const [id, n] of outside) for (let i = 0; i < n; i++) placed.push(id);

  return placed;
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function tally(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) bump(counts, id);
  return counts;
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
 *
 * It also fails when the MANIFEST does not read back (ace#2236). This is the
 * boundary that carries the loudness because it is the only required step that
 * already holds both halves — the published artifact and the manifest — and
 * `_training-template.md` calls it the one that decides. The pre-write helpers
 * cannot carry it: their failure mode on an unreadable manifest is silence, and
 * that silence IS the defect, not a symptom of it.
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
  // A deck spec's citations are what its SLIDES place; every other artifact's
  // are what its text shows (ace#2238).
  const cited = extractDeckSpecCitations(args.published) ?? extractCitedFileIds(args.published);
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

  const readability = assertManifestReadable(args.manifest as CaptureManifestLike);

  return {
    ok: findings.length === 0 && readability.ok,
    cited_total: cited.length,
    cited_distinct: seen.size,
    backed,
    findings,
    manifest_frames: frames.length,
    ...(readability.ok ? {} : { manifest_readability: readability }),
  };
}
