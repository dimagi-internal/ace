/**
 * Embed screenshots INTO a published Google Doc, after Drive's markdown
 * conversion has already run.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 *
 * A step-by-step field guide whose steps are not SHOWN is not a step-by-step
 * guide. ACE has now shipped that document twice, for two different reasons,
 * and both times every content check passed:
 *
 *   1. `![alt](drive:<fileId>)` — `drive:` is an ACE-INTERNAL reference, not a
 *      URL. Drive's markdown importer drops an image node whose src it cannot
 *      fetch, silently, alt text included (ace#1338).
 *   2. `[alt](https://drive.google.com/file/d/<id>/view)` — the "fix" for (1).
 *      The words came back and the reference is clickable, but a CBF reading
 *      the guide mid-visit gets 44 links where 44 pictures should be
 *      (ace#1418).
 *
 * The mechanism here is the third answer, and the one the surface auditor
 * names: convert the markdown first, then INSERT the images with the Docs API
 * (`insertInlineImage` via `docs_batch_update`).
 *
 * ── Why insertInlineImage and not a fetchable markdown image src ──────
 *
 * Drive's importer DOES fetch a real https image src — measured 2026-08-14
 * against `drive.google.com/uc?export=view&id=…`, `…/uc?export=download&id=…`,
 * `lh3.googleusercontent.com/d/…` and `drive.google.com/thumbnail?id=…`: all
 * four imported as real, anonymously-visible inline images. So the one-step
 * markdown path WOULD work — except for size. The importer takes the image's
 * natural dimensions: a 1080x2400 phone screenshot lands at 675x1499 PT, i.e.
 * 9.4 inches wide on a 6.5-inch page, one and a half PAGES tall, 44 times over.
 * `insertInlineImage` accepts an explicit `objectSize`, so it is the only path
 * that produces a document a human can actually read. That is the whole reason
 * for the two-step shape.
 *
 * ── Where images go ───────────────────────────────────────────────────
 *
 * Where their references already are, and nowhere else. This module never
 * invents a placement: it reads the CONVERTED document and anchors on what the
 * prose already cites —
 *
 *   - a Drive file link       `[Connect home](https://drive.google.com/file/d/<id>/view)`
 *   - a filename citation     ``see `learn-launch-home-tiles.png` ``
 *
 * and appends the cited frames in one new paragraph directly after the
 * paragraph that cites them. No prose is added, removed or reworded.
 *
 * Idempotent: a paragraph that is already followed by its images is skipped,
 * so re-running after a partial failure repairs only what is missing.
 */

/** Docs API `Request` objects — kept structural so this module stays dependency-free. */
export type DocsRequest = Record<string, unknown>;

/** Default rendered width for a phone screenshot, in points (~1.9 inch). */
export const DEFAULT_IMAGE_WIDTH_PT = 140;

/** A Docs body element, structurally typed to what this module reads. */
export interface DocElement {
  startIndex?: number | null;
  endIndex?: number | null;
  paragraph?: {
    elements?: Array<{
      startIndex?: number | null;
      endIndex?: number | null;
      inlineObjectElement?: unknown;
      textRun?: {
        content?: string | null;
        textStyle?: { link?: { url?: string | null } | null } | null;
      } | null;
    }> | null;
  } | null;
  table?: {
    tableRows?: Array<{
      tableCells?: Array<{ content?: DocElement[] | null }> | null;
    }> | null;
  } | null;
}

export interface DocLike {
  body?: { content?: DocElement[] | null } | null;
}

/** One paragraph that cites screenshots, and the frames it cites, in order. */
export interface ImageAnchor {
  /** Document-wide index one past the paragraph's trailing newline. */
  endIndex: number;
  /** Drive file ids cited by this paragraph, in citation order, deduped. */
  fileIds: string[];
  /**
   * True when this paragraph's frames are already on the page — either the
   * paragraph itself holds an inline image, or the paragraph immediately after
   * it is one this module already wrote.
   */
  alreadyIllustrated: boolean;
  /** The citation text, for reporting. */
  excerpt: string;
}

/** Where a filename citation ends. */
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif)\b/gi;
/** Characters that can appear inside a captured frame's filename. */
const FILENAME_CHAR_RE = /[A-Za-z0-9 ._-]/;

/**
 * Candidate filenames for a `.png` occurrence, longest first.
 *
 * A screenshot filename can contain SPACES — `app-screenshot-capture` names
 * frames after the tapped row, e.g. `learn-tap-module-form-row-Your role and
 * what gets paid.x.png`. So a citation cannot be lexed by "no spaces", and a
 * greedy space-tolerant pattern instead swallows the sentence in front of it
 * (`Tumbuka. See learn-launch-home-tiles.png` matched whole, resolving to
 * nothing). The resolution is to take the maximal candidate and hand the
 * caller every left-trimmed prefix at a word boundary, longest first — the
 * name map decides which one is real.
 */
export function filenameCandidates(text: string, extEnd: number): string[] {
  let start = extEnd;
  while (start > 0 && FILENAME_CHAR_RE.test(text[start - 1])) start--;
  const span = text.slice(start, extEnd);
  const out: string[] = [span];
  for (let i = 0; i < span.length; i++) {
    if (span[i] === ' ' && i + 1 < span.length) out.push(span.slice(i + 1));
  }
  return out;
}

/**
 * Pull a Drive file id out of any of the URL shapes ACE emits or a human
 * pastes. Returns null for a non-Drive URL (a Connect opportunity link, an HQ
 * app link, a mailto:) — those are not screenshots and must not be embedded.
 */
export function driveFileIdFromUrl(url: string): string | null {
  if (!/^https?:\/\/(?:[a-z0-9-]+\.)*google(?:usercontent)?\.com\//i.test(url)) return null;
  const patterns = [
    /\/file\/d\/([A-Za-z0-9_-]{20,})/,
    /\/d\/([A-Za-z0-9_-]{20,})/,
    /[?&]id=([A-Za-z0-9_-]{20,})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

/**
 * The image URI handed to the Docs API. Google fetches it server-side WITHOUT
 * the caller's credentials, which is why `app-screenshot-capture` uploads the
 * PNGs `anyone: reader` — an unshared frame is fetched as a login page and the
 * insert fails loudly rather than embedding garbage.
 */
export function driveImageUri(fileId: string): string {
  return `https://drive.google.com/uc?export=view&id=${fileId}`;
}

/**
 * True for a paragraph this module wrote: one or more inline images and no
 * text beyond whitespace. That shape is what makes a re-run a no-op.
 */
export function isImageOnlyParagraph(el: DocElement | undefined): boolean {
  const elements = el?.paragraph?.elements;
  if (!elements?.length) return false;
  let images = 0;
  for (const pe of elements) {
    if (pe.inlineObjectElement) { images++; continue; }
    if (pe.textRun && !/^\s*$/.test(pe.textRun.content ?? '')) return false;
    if (!pe.textRun && !pe.inlineObjectElement) return false;
  }
  return images > 0;
}

function walkParagraphs(content: DocElement[] | null | undefined, out: DocElement[]): void {
  for (const el of content ?? []) {
    if (el.paragraph) out.push(el);
    if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) walkParagraphs(cell.content, out);
      }
    }
  }
}

/**
 * Find every paragraph that cites screenshots.
 *
 * `resolveName` maps a cited filename (`journey-deliver-submitted.png`) to a
 * Drive file id, or null when the run captured no such frame. An unresolvable
 * citation is NOT an anchor and is reported by the caller — a guide that names
 * a frame the run never captured is a different defect, and this module must
 * not paper over it by silently embedding something else.
 */
export function collectImageAnchors(
  doc: DocLike,
  resolveName: (filename: string) => string | null,
): { anchors: ImageAnchor[]; unresolvedCitations: string[] } {
  const paragraphs: DocElement[] = [];
  walkParagraphs(doc.body?.content, paragraphs);

  const anchors: ImageAnchor[] = [];
  const unresolvedCitations: string[] = [];
  for (let pi = 0; pi < paragraphs.length; pi++) {
    const el = paragraphs[pi];
    const endIndex = el.endIndex;
    if (typeof endIndex !== 'number') continue;

    const ids: string[] = [];
    let alreadyIllustrated = false;
    let text = '';

    for (const pe of el.paragraph?.elements ?? []) {
      if (pe.inlineObjectElement) alreadyIllustrated = true;
      const run = pe.textRun;
      if (!run) continue;
      text += run.content ?? '';
      const url = run.textStyle?.link?.url;
      if (url) {
        const id = driveFileIdFromUrl(url);
        if (id) ids.push(id);
      }
    }

    for (const m of text.matchAll(IMAGE_EXT_RE)) {
      const extEnd = m.index! + m[0].length;
      const candidates = filenameCandidates(text, extEnd);
      let resolved = false;
      for (const candidate of candidates) {
        const id = resolveName(candidate);
        if (id) { ids.push(id); resolved = true; break; }
      }
      // A citation naming a frame the run never captured is a DIFFERENT
      // defect (the guide cites a screenshot that does not exist). Surface it
      // rather than quietly embedding some other frame in its place.
      if (!resolved) unresolvedCitations.push(candidates[candidates.length - 1] ?? '');
    }

    const deduped = [...new Set(ids)];
    if (!deduped.length) continue;
    anchors.push({
      endIndex,
      // The images this module writes land in a NEW paragraph AFTER the citing
      // one, so asking only "does the citing paragraph hold an image?" always
      // answers no and a second run appends a second copy of every frame.
      // Measured live: a re-run took the FLW guide from 44 images to 88.
      // Idempotency has to look where the images actually went.
      alreadyIllustrated: alreadyIllustrated || isImageOnlyParagraph(paragraphs[pi + 1]),
      fileIds: deduped,
      excerpt: text.trim().slice(0, 80),
    });
  }
  return { anchors, unresolvedCitations };
}

export interface EmbedOptions {
  /** Rendered width in points. Height is derived per image to keep aspect. */
  widthPt?: number;
  /** Natural pixel dimensions per file id; missing entries render square. */
  naturalSize?: (fileId: string) => { width: number; height: number } | null;
  /** Override the image URI (tests). */
  uriFor?: (fileId: string) => string;
}

/**
 * Build the batchUpdate requests that append each anchor's frames in a new
 * paragraph directly after the citing paragraph.
 *
 * Emitted in DESCENDING document order on purpose: every insertion shifts the
 * indices of everything after it, so working backwards keeps every index in
 * this batch valid against the document as it was read. Getting this wrong
 * does not error — it silently places images in the wrong paragraphs.
 */
export function buildEmbedRequests(anchors: ImageAnchor[], opts: EmbedOptions = {}): DocsRequest[] {
  const widthPt = opts.widthPt ?? DEFAULT_IMAGE_WIDTH_PT;
  const uriFor = opts.uriFor ?? driveImageUri;
  const naturalSize = opts.naturalSize ?? (() => null);

  const pending = anchors
    .filter((a) => !a.alreadyIllustrated && a.fileIds.length > 0)
    .sort((a, b) => b.endIndex - a.endIndex);

  const requests: DocsRequest[] = [];
  for (const anchor of pending) {
    const end = anchor.endIndex;
    // Split off a fresh paragraph AFTER this one: the inserted newline takes
    // index end-1, pushing the paragraph's own newline to end, so the new
    // (empty) paragraph begins at `end`.
    requests.push({ insertText: { location: { index: end - 1 }, text: '\n' } });

    let cursor = 0;
    anchor.fileIds.forEach((fileId, i) => {
      const natural = naturalSize(fileId);
      const aspect = natural && natural.width > 0 ? natural.height / natural.width : 1;
      requests.push({
        insertInlineImage: {
          location: { index: end + cursor },
          uri: uriFor(fileId),
          objectSize: {
            width: { magnitude: widthPt, unit: 'PT' },
            height: { magnitude: Number((widthPt * aspect).toFixed(2)), unit: 'PT' },
          },
        },
      });
      cursor += 1;
      if (i < anchor.fileIds.length - 1) {
        requests.push({ insertText: { location: { index: end + cursor }, text: ' ' } });
        cursor += 1;
      }
    });

    // The citing paragraph is often a numbered step. Splitting it would give
    // the image paragraph its own number and renumber the whole list, so the
    // new paragraph is stripped back to plain body text.
    const range = { startIndex: end, endIndex: end + cursor + 1 };
    requests.push({ deleteParagraphBullets: { range } });
    requests.push({
      updateParagraphStyle: {
        range,
        paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        fields: 'namedStyleType',
      },
    });
  }
  return requests;
}

/** Count inline images actually present in a document. */
export function countInlineImages(doc: DocLike): number {
  const paragraphs: DocElement[] = [];
  walkParagraphs(doc.body?.content, paragraphs);
  let n = 0;
  for (const el of paragraphs) {
    for (const pe of el.paragraph?.elements ?? []) if (pe.inlineObjectElement) n++;
  }
  return n;
}
