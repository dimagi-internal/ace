/**
 * Did the file ACE uploaded actually come back as a file?
 *
 * ## The class
 *
 * An upload that returns a `fileId` proves the SERVICE ACCOUNT wrote something.
 * It proves nothing about what a reader receives. Three ways that has now gone
 * wrong in this repo, each certified fine by the check in force at the time:
 *
 *   - **ace#902** — a private deliverable passed as an ordinary auth wall.
 *   - **ace#1825** — an anyone-with-link pre-flight that silently shared nothing.
 *   - **ace#1831 / ace#1868** — a `200` on a Drive download URL that is Google's
 *     virus-scan interstitial, not the artifact.
 *
 * `lib/run-surface-audit.ts` closed the last of those on the AUDITOR side
 * (`classifyLink` now judges a 200 by its body). This module is the PRODUCER
 * side: the check a skill runs immediately after its own upload, so a bad
 * artifact never reaches a manifest in the first place. The amendment recorded
 * on ace#1831 states it exactly — *the post-upload check must assert magic
 * bytes, not `200`* — because a `200`-only check certifies both `.xml` files
 * below as fine.
 *
 * Pure and total: no I/O, no network, no throwing. The caller does the
 * credential-free fetch; this decides what came back.
 *
 * ## Measured, not predicted
 *
 * Every rule here comes from one anonymous sweep of run
 * `hh-poverty-targeting/20260828-0702` (2026-09-06, `urllib`, no credentials,
 * `uc?export=download&id=<id>`, first 6 KB):
 *
 * ```
 * journey-learn.mp4            code=200 ct=video/mp4                 magic=b'ftypisom'
 * journey-deliver.mp4          code=200 ct=video/mp4                 magic=b'ftypisom'
 * journey-deliver-FAILURE.png  code=200 ct=image/png                 magic=PNG
 * atlas-report.yaml            code=200 ct=application/octet-stream   magic=b'version:'
 * journey-deliver-FAILURE.xml  code=200 ct=text/html; charset=utf-8   title=Google Drive - Virus scan warning
 * 00-postlearn-landing.xml     code=200 ct=text/html; charset=utf-8   title=Google Drive - Virus scan warning
 * ```
 *
 * Note what that shows and what it does NOT. Two `.xml` files answer with a
 * warning page while a `.yaml`, a `.png` and two `.mp4` from the same folder
 * answer with real bytes — so the discriminator is not the folder, not the
 * permission, and not the size (the `.xml` files are ~19 KB). **They are not
 * private:** they answer `200` with no credentials, so sharing them again
 * changes nothing, and the remedy for that class is different from the remedy
 * for an unshared file. This module reports the distinction; it does not
 * theorise about why Drive draws the line where it does.
 */

/** What the reader actually got. */
export type ReadbackVerdict =
  /** The bytes are the artifact. */
  | 'ok'
  /** 200, but the body is a Google interstitial — the reader never sees the file. */
  | 'interstitial'
  /** The fetch was refused, or answered with a sign-in page. */
  | 'gated'
  /** Real bytes, but not of the type that was uploaded. */
  | 'wrong-type'
  /** Nothing came back at all. */
  | 'unreachable';

export interface ReadbackResult {
  verdict: ReadbackVerdict;
  /** One line naming what was observed, for a verdict note or a halt message. */
  evidence: string;
  /**
   * True when re-sharing the file cannot change the outcome. An interstitial is
   * the case: the file is already anonymously reachable, and the warning page is
   * what anonymous reachability GETS you. Telling these apart matters because
   * the two have opposite remedies, and #1831's first proposed fix
   * (`shareAnyoneWithLink: true` on the forensics upload) is a no-op for it.
   */
  sharingWouldNotHelp: boolean;
}

export interface ReadbackInput {
  /** The uploaded file's name — the extension is what pins the expected type. */
  fileName: string;
  /** HTTP status of the credential-free fetch, or null if it never answered. */
  status: number | null;
  /** `Content-Type` of that response. */
  contentType?: string | null;
  /** First bytes of the body. 16 is enough for every signature below. */
  bytes?: Uint8Array | null;
}

/**
 * Leading-byte signatures, keyed by extension.
 *
 * Deliberately covers only what Phase 6 actually uploads. An unknown extension
 * is NOT a failure — it falls through to the structural checks, which are the
 * ones that caught the real defect. Guessing a signature for a type nobody
 * uploads would be exactly the unfounded prediction CLAUDE.md forbids.
 */
const SIGNATURES: Record<string, { name: string; test: (b: Uint8Array) => boolean }> = {
  png: {
    name: 'PNG',
    test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  // ISO-BMFF: a 4-byte size, then the literal `ftyp` at offset 4. The observed
  // brand is `isom`, but the brand is not part of the test — that would fail a
  // perfectly good `mp42` recording.
  mp4: {
    name: 'ISO-BMFF (ftyp)',
    test: (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70,
  },
  jpg: { name: 'JPEG', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  jpeg: { name: 'JPEG', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
};

/** Text types have no magic number; the test is that they are not a web page. */
const TEXTUAL = new Set(['xml', 'yaml', 'yml', 'md', 'txt', 'json', 'csv']);

const decode = (b: Uint8Array | null | undefined, n = 512): string =>
  b ? Buffer.from(b.slice(0, n)).toString('utf8') : '';

const extensionOf = (fileName: string): string =>
  (fileName.split('.').pop() ?? '').toLowerCase();

/**
 * Google's interstitial and sign-in pages, matched on the TITLE rather than on
 * body prose. Both observed verbatim.
 */
const INTERSTITIAL_TITLES: readonly RegExp[] = [
  /Google Drive\s*-\s*Virus scan warning/i,
  /Google Drive\s*-\s*Quota exceeded/i,
];
const SIGNIN_TITLES: readonly RegExp[] = [/Google Drive:\s*Sign-in/i, /Sign in\s*-\s*Google Accounts/i];

const titleOf = (html: string): string => html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? '';

/**
 * Judge one credential-free readback of a file ACE just uploaded.
 *
 * Order matters. The status line is checked first because a refusal is
 * unambiguous; everything after it is the case a status-only check gets wrong.
 */
export function classifyUploadReadback(input: ReadbackInput): ReadbackResult {
  const { fileName, status, contentType, bytes } = input;
  const ct = (contentType ?? '').toLowerCase();
  const ext = extensionOf(fileName);

  if (status === null) {
    return { verdict: 'unreachable', evidence: 'no response', sharingWouldNotHelp: false };
  }
  if (status === 401 || status === 403) {
    return {
      verdict: 'gated',
      evidence: `HTTP ${status} without credentials — the file is not anyone-with-link`,
      sharingWouldNotHelp: false,
    };
  }
  if (status >= 400) {
    return { verdict: 'unreachable', evidence: `HTTP ${status}`, sharingWouldNotHelp: false };
  }

  // An HTML answer where a file's bytes were promised. STRUCTURAL — it does not
  // depend on recognising any particular page, only on the mismatch between
  // "this URL returns a file" and "this response is a document".
  if (ct.startsWith('text/html')) {
    const html = decode(bytes, 4096);
    const title = titleOf(html);
    if (SIGNIN_TITLES.some((r) => r.test(title))) {
      return {
        verdict: 'gated',
        evidence: `HTTP ${status} with a sign-in page ("${title}")`,
        sharingWouldNotHelp: false,
      };
    }
    const known = INTERSTITIAL_TITLES.some((r) => r.test(title));
    return {
      verdict: 'interstitial',
      evidence:
        `HTTP ${status} with content-type ${ct.split(';')[0]} where ${fileName}'s bytes were ` +
        `promised${title ? ` — "${title}"` : ''}${known ? ' (a known Google interstitial)' : ''}`,
      // The file answered 200 to an anonymous fetch, so it IS reachable. Sharing
      // it again changes nothing; this needs a different remedy.
      sharingWouldNotHelp: true,
    };
  }

  const sig = SIGNATURES[ext];
  if (sig) {
    if (!bytes || bytes.length < 8) {
      return {
        verdict: 'wrong-type',
        evidence: `HTTP ${status} but fewer than 8 bytes — no ${sig.name} signature to check`,
        sharingWouldNotHelp: false,
      };
    }
    if (!sig.test(bytes)) {
      return {
        verdict: 'wrong-type',
        evidence: `HTTP ${status} but the leading bytes are not ${sig.name}`,
        sharingWouldNotHelp: false,
      };
    }
    return { verdict: 'ok', evidence: `${sig.name} bytes`, sharingWouldNotHelp: false };
  }

  if (TEXTUAL.has(ext)) {
    const head = decode(bytes, 512).trimStart();
    if (/^<!DOCTYPE html/i.test(head) || /^<html/i.test(head)) {
      const title = titleOf(decode(bytes, 4096));
      return {
        verdict: 'interstitial',
        evidence:
          `HTTP ${status} and the body is an HTML document where ${fileName}'s text was ` +
          `promised${title ? ` — "${title}"` : ''}`,
        sharingWouldNotHelp: true,
      };
    }
    if (!head) {
      return {
        verdict: 'wrong-type',
        evidence: `HTTP ${status} with an empty body`,
        sharingWouldNotHelp: false,
      };
    }
    return { verdict: 'ok', evidence: 'non-HTML text', sharingWouldNotHelp: false };
  }

  // Unknown extension: everything structural passed, so say so plainly rather
  // than inventing a signature.
  return {
    verdict: 'ok',
    evidence: `HTTP ${status}, content-type ${ct || 'unset'} — no signature known for .${ext}`,
    sharingWouldNotHelp: false,
  };
}

/** True when the readback means a reader cannot use the artifact. */
export function isReadbackFailure(r: ReadbackResult): boolean {
  return r.verdict !== 'ok';
}
