// lib/xform-acquire.ts
//
// Pure XForm transformation: ensure every IMAGE `<upload>` control in a
// CommCare XForm carries `appearance="acquire"` — the camera-only hint that
// hides the mobile gallery button (contract truth, verified 2026-07-13 against
// commcare-android: `QuestionWidget.ACQUIREFIELD = "acquire"`; the widget hides
// the gallery button when the appearance hint CONTAINS `acquire`).
//
// ## Why this exists as code rather than prose
//
// `app-hq-settings` § Step 3 is a read-modify-write on a live form:
// `commcare_get_form_source` → add one attribute → `commcare_patch_xform`.
// Until ace#1795 the read had no disk-handle mode, so the ONLY way to perform
// the edit was to pull the whole ~30 KB XForm into the model context and
// re-emit all 30 KB verbatim — a lookup string with 101 values, read-aloud
// scripts carrying `&#x2014;`/`&apos;` entities, and a literal `[ \t\r\n]+`
// inside a regex. The model was the transport, so one mis-copied character
// corrupted a live form, and Step 2.65 was skipped on
// `hh-poverty-targeting/20260828-0702` rather than risk it.
//
// With `write_to_path` on the read the bytes can stay on disk — but only if
// something OTHER than the model can perform the edit. That is this file.
//
// ## Why a surgical string splice and not a DOM round trip
//
// `lib/multimedia-xform-patch.ts` parses and re-serializes through
// `@xmldom/xmldom`, which is correct for its job (it inserts new itext
// elements). Here the edit is a single attribute on a start tag, and the whole
// point is fidelity: a serializer round trip is free to re-encode entities,
// normalize attribute quoting, and reorder namespace declarations across the
// ENTIRE document. So this rewrites only the matched `<upload ...>` start tags
// and leaves every other byte identical — which is a property the tests assert
// directly.

/** An image `<upload>` that already declares a non-`acquire` appearance. */
export interface AcquireConflict {
  /** The control's `ref` attribute (or `<unknown ref>` if it has none). */
  ref: string;
  /** The appearance value already present, verbatim. */
  appearance: string;
}

export interface AddAcquireResult {
  /** The XML after the transformation. Byte-identical to the input when `patched` is false. */
  xml: string;
  /** True iff at least one `<upload>` start tag was rewritten. */
  patched: boolean;
  /** `ref`s that were given `appearance="acquire"`. */
  applied: string[];
  /** `ref`s whose appearance already contained `acquire` — idempotent no-ops. */
  alreadyAcquire: string[];
  /**
   * Image uploads carrying a DIFFERENT appearance hint. Never rewritten: a
   * deliberate appearance is not ours to clobber, so the caller halts the form
   * and surfaces the observed value (`app-hq-settings` § Step 3).
   */
  conflicts: AcquireConflict[];
  /** `ref`s of non-image uploads (audio/video/signature) — out of scope, untouched. */
  nonImageUploads: string[];
}

/**
 * Matches an `<upload ...>` START tag (self-closing or not). Deliberately does
 * not try to be a parser: an XForm body's `<upload>` controls are plain start
 * tags, and anything that fails the `mediatype="image/..."` test below is left
 * alone regardless.
 */
const UPLOAD_TAG_RE = /<upload\b[^>]*>/g;

/** Pull one attribute's value out of a start tag. Handles both quote styles. */
function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`);
  const m = re.exec(tag);
  if (!m) return undefined;
  return m[2] !== undefined ? m[2] : m[3];
}

/**
 * Add `appearance="acquire"` to every image `<upload>` that lacks it.
 *
 * Idempotent: re-running on an already-patched form applies nothing and
 * returns `patched: false` with the same refs under `alreadyAcquire`.
 */
export function addAcquireAppearance(xml: string): AddAcquireResult {
  const applied: string[] = [];
  const alreadyAcquire: string[] = [];
  const conflicts: AcquireConflict[] = [];
  const nonImageUploads: string[] = [];

  const out = xml.replace(UPLOAD_TAG_RE, (tag) => {
    const ref = attr(tag, 'ref') ?? '<unknown ref>';
    const mediatype = attr(tag, 'mediatype') ?? '';
    if (!mediatype.startsWith('image/')) {
      nonImageUploads.push(ref);
      return tag;
    }
    const appearance = attr(tag, 'appearance');
    if (appearance !== undefined) {
      if (appearance.includes('acquire')) {
        alreadyAcquire.push(ref);
      } else {
        conflicts.push({ ref, appearance });
      }
      return tag;
    }
    // Splice the attribute in just before the tag's closing `>` (or `/>`),
    // preserving whatever whitespace and attribute order the source had.
    const selfClosing = /\/>$/.test(tag);
    const body = tag.slice(1, selfClosing ? tag.length - 2 : tag.length - 1).replace(/\s+$/, '');
    applied.push(ref);
    return `<${body} appearance="acquire"${selfClosing ? '/>' : '>'}`;
  });

  return {
    xml: out,
    patched: applied.length > 0,
    applied,
    alreadyAcquire,
    conflicts,
    nonImageUploads,
  };
}
