/**
 * Strip embedded `data:` payloads out of a Drive markdown export before the
 * text is handed to a consumer that only wants prose.
 *
 * WHY THIS EXISTS: `drive_read_file(exportAs: 'text/markdown')` on a native
 * Google Doc inlines every embedded image as a base64 `data:` URI. Both OCS
 * upload paths (`ocs-agent-setup` § Step 5, `ocs-knowledge-refresh` § Step 1)
 * read documents that way and push the result straight into an `is_index: true`
 * RAG collection, so the payloads become indexed retrieval content competing
 * with real prose for the bot's retrieval slots.
 *
 * Measured on `bednet-check-2-visit/20260828-0629` (dimagi-internal/ace#1827):
 * the FLW training guide exported at 264,538 bytes carrying ~9 KB of prose and
 * 16 screenshots — a corpus 96% base64 by volume for that file, and 91% across
 * the four-document training pack. Nothing failed; the upload succeeded and
 * indexing reported `ready: true, pending: 0`.
 *
 * ## The export shape is REFERENCE-STYLE, not inline
 *
 * ace#1827 proposed matching `!\[alt\]\(data:image/...\)`. That form does not
 * occur in a real Drive export and the proposed regex matches **zero** of the
 * 16 payloads in the specimen above. What Drive actually emits is a
 * CommonMark link-reference pair, with an EMPTY alt text:
 *
 *     ![][image1]
 *     ...
 *     [image1]: <data:image/png;base64,iVBORw0KGgo...>
 *
 * So the alt text is not where the retrieval signal lives — the caption does,
 * as ordinary prose next to the reference (`— [PersonalID start](https://…)`),
 * and that prose is untouched here. We still preserve an alt when one exists,
 * because the inline form (hand-written markdown in an opp's `inputs/`) does
 * carry one.
 *
 * Pure string in / string out: no I/O, no Drive, no network.
 * CLI wrapper: `scripts/strip-inline-data-uris.ts`.
 */

/** One payload that was removed, for the caller's report. */
export interface StrippedPayload {
  /** The mime type as it appeared in the URI, e.g. `image/png`. */
  mimeType: string;
  /** Bytes of the `data:` URI itself (not the decoded image). */
  bytes: number;
  /** How the payload was written in the source. */
  form: 'inline' | 'reference-definition';
}

export interface StripResult {
  text: string;
  stripped: StrippedPayload[];
  bytesBefore: number;
  bytesAfter: number;
}

/**
 * A `data:` URI body: everything after `data:` up to the closing delimiter.
 * Kept deliberately loose on the mime (`[^;,\s>)]*`) so a `data:;base64,` or a
 * `data:text/plain,` with no base64 marker is caught too — the point is that no
 * inline payload survives, not that we enumerate mime types correctly.
 */
const MIME = String.raw`([^;,\s>)\]]*)`;

/** `![alt](data:...)` / `[label](data:...)` — the inline (hand-written) form. */
const INLINE = new RegExp(String.raw`(!?)\[([^\]]*)\]\(\s*<?data:${MIME}[^)]*\)`, 'g');

/**
 * `[ref]: <data:...>` — the link-reference DEFINITION form, which is what
 * Drive's markdown export emits. Anchored to the start of a line, because a
 * definition is only a definition there.
 */
const REF_DEF = new RegExp(String.raw`^[ \t]*\[([^\]]+)\]:[ \t]*<?data:${MIME}[^>\n]*>?[ \t]*$`, 'gm');

/** A rendered placeholder for a removed image. */
function placeholder(alt: string, mimeType: string): string {
  const kind = mimeType.startsWith('image/') ? 'screenshot' : `embedded ${mimeType || 'file'}`;
  const label = alt.trim();
  return label ? `[${kind}: ${label}]` : `[${kind}]`;
}

/**
 * Remove every embedded `data:` payload, leaving the surrounding prose — and
 * any alt text or link label — intact.
 *
 * Three rewrites, in order:
 *
 * 1. `[ref]: <data:image/png;base64,…>` definitions are DELETED, and `ref` is
 *    remembered so its usages can be rewritten.
 * 2. `![alt][ref]` usages of a deleted definition become `[screenshot: alt]`
 *    (or `[screenshot]` when the export left the alt empty, which it does).
 *    Rewriting rather than deleting keeps the fact that a picture was there —
 *    a reader asking "is there a screenshot of the sign-in screen?" should
 *    still get "yes, see the published guide" rather than silence.
 * 3. Inline `![alt](data:…)` / `[label](data:…)` become `[screenshot: alt]` /
 *    `label`.
 *
 * A reference USAGE whose definition is not a `data:` URI (an ordinary linked
 * image) is left alone.
 */
export function stripInlineDataUris(markdown: string): StripResult {
  const bytesBefore = Buffer.byteLength(markdown, 'utf8');
  const stripped: StrippedPayload[] = [];
  const removedRefs = new Map<string, string>(); // ref label -> mime

  // 1. Reference definitions.
  let text = markdown.replace(REF_DEF, (match, ref: string, mime: string) => {
    stripped.push({
      mimeType: mime,
      bytes: Buffer.byteLength(match, 'utf8'),
      form: 'reference-definition',
    });
    removedRefs.set(ref.toLowerCase(), mime);
    return '';
  });

  // 2. Usages of the definitions we just removed.
  if (removedRefs.size > 0) {
    text = text.replace(/!\[([^\]]*)\]\[([^\]]*)\]/g, (match, alt: string, ref: string) => {
      // `![alt][]` is a collapsed reference: the label IS the alt text.
      const key = (ref.trim() === '' ? alt : ref).toLowerCase();
      const mime = removedRefs.get(key);
      return mime === undefined ? match : placeholder(alt, mime);
    });
  }

  // 3. Inline data URIs.
  text = text.replace(INLINE, (match, bang: string, label: string, mime: string) => {
    stripped.push({ mimeType: mime, bytes: Buffer.byteLength(match, 'utf8'), form: 'inline' });
    return bang === '!' ? placeholder(label, mime) : label;
  });

  // A removed definition leaves an empty line behind; collapse the run.
  text = text.replace(/\n{3,}/g, '\n\n');

  return { text, stripped, bytesBefore, bytesAfter: Buffer.byteLength(text, 'utf8') };
}

/**
 * Does any `data:...;base64,` payload survive in this text?
 *
 * The post-condition `scripts/strip-inline-data-uris.ts` asserts before an
 * upload is allowed to proceed. A ratio heuristic ("this file is 5x its
 * `.source.md` sibling") would only tell you something is probably wrong;
 * this tells you whether the thing we care about is actually gone.
 */
export function hasResidualDataUri(text: string): boolean {
  return /data:[^;,\s>)\]]*;base64,/.test(text);
}
