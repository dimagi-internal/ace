/**
 * dimagi-internal/ace#1831 — the post-upload check must assert MAGIC BYTES,
 * not `200`.
 *
 * ## Where the fixtures come from
 *
 * Every case below is one row of an anonymous sweep of run
 * `hh-poverty-targeting/20260828-0702`, re-run 2026-09-06 (`urllib`, no
 * credentials, `uc?export=download&id=<id>`, first 6 KB + magic bytes):
 *
 * ```
 * journey-learn.mp4            code=200 ct=video/mp4                magic=b'ftypisom'
 * journey-deliver.mp4          code=200 ct=video/mp4                magic=b'ftypisom'
 * journey-deliver-FAILURE.png  code=200 ct=image/png                magic=PNG
 * atlas-report.yaml            code=200 ct=application/octet-stream  magic=b'version:'
 * journey-deliver-FAILURE.xml  code=200 ct=text/html; charset=utf-8  title=Google Drive - Virus scan warning
 * 00-postlearn-landing.xml     code=200 ct=text/html; charset=utf-8  title=Google Drive - Virus scan warning
 * ```
 *
 * The load-bearing test is `certifies nothing on status alone`: a `200`-only
 * check passes all six, including the two nobody can read.
 */

import { describe, expect, it } from 'vitest';
import { classifyUploadReadback, isReadbackFailure } from '../../lib/upload-readback.js';

const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d);
const MP4 = bytes(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d);
const VIRUS_WARNING = text(
  '<!DOCTYPE html><html><head><title>Google Drive - Virus scan warning</title></head>' +
    "<body>Google Drive can't scan this file for viruses. This file is executable and may harm " +
    'your computer. journey-deliver-FAILURE.xml (19k)</body></html>',
);
const SIGN_IN = text(
  '<!DOCTYPE html><html><head><title>Google Drive: Sign-in</title></head><body>…</body></html>',
);

/** The six artifacts, exactly as the sweep observed them. */
const OBSERVED = [
  { fileName: 'journey-learn.mp4', status: 200, contentType: 'video/mp4', bytes: MP4, want: 'ok' },
  { fileName: 'journey-deliver.mp4', status: 200, contentType: 'video/mp4', bytes: MP4, want: 'ok' },
  {
    fileName: 'journey-deliver-FAILURE.png',
    status: 200,
    contentType: 'image/png',
    bytes: PNG,
    want: 'ok',
  },
  {
    fileName: 'atlas-report.yaml',
    status: 200,
    contentType: 'application/octet-stream',
    bytes: text('version: 1\nclassification: matcher-miss\n'),
    want: 'ok',
  },
  {
    fileName: 'journey-deliver-FAILURE.xml',
    status: 200,
    contentType: 'text/html; charset=utf-8',
    bytes: VIRUS_WARNING,
    want: 'interstitial',
  },
  {
    fileName: '00-postlearn-landing.xml',
    status: 200,
    contentType: 'text/html; charset=utf-8',
    bytes: VIRUS_WARNING,
    want: 'interstitial',
  },
] as const;

describe('the real 2026-09-06 sweep', () => {
  it.each(OBSERVED)('$fileName -> $want', (row) => {
    expect(classifyUploadReadback(row).verdict).toBe(row.want);
  });

  /**
   * The whole point. Every artifact answered 200, including the two whose bytes
   * are a warning page, so the check ace#1831 originally proposed — and any
   * `200`/HEAD check — certifies all six.
   */
  it('certifies nothing on status alone — all six answered 200', () => {
    expect(OBSERVED.every((r) => r.status === 200)).toBe(true);
    expect(OBSERVED.filter((r) => isReadbackFailure(classifyUploadReadback(r)))).toHaveLength(2);
  });

  /**
   * The two `.xml` files are NOT private — they answer 200 without credentials.
   * So `shareAnyoneWithLink: true`, which is the fix #1831 proposed for them,
   * is a no-op. Getting this backwards costs a share call and leaves the file
   * exactly as unreadable.
   */
  it('says when re-sharing cannot help', () => {
    const xml = classifyUploadReadback(OBSERVED[4]);
    expect(xml.verdict).toBe('interstitial');
    expect(xml.sharingWouldNotHelp).toBe(true);

    const gated = classifyUploadReadback({
      fileName: 'journey-deliver.mp4',
      status: 403,
      contentType: 'text/html',
      bytes: null,
    });
    expect(gated.verdict).toBe('gated');
    expect(gated.sharingWouldNotHelp).toBe(false);
  });

  it('quotes the interstitial title as evidence, so a verdict note is legible', () => {
    expect(classifyUploadReadback(OBSERVED[4]).evidence).toContain('Virus scan warning');
  });
});

describe('the pre-#2040 state recorded in the issue body', () => {
  /**
   * As FILED (2026-08-31) the same ids returned Drive's sign-in page. Kept as a
   * case because it is the class ace#902 / ace#1825 are about, and because the
   * two must not collapse into one verdict: a sign-in page means "share it", an
   * interstitial means "sharing will not help".
   */
  it('a sign-in page reads as GATED, never as an interstitial', () => {
    const r = classifyUploadReadback({
      fileName: 'journey-deliver.mp4',
      status: 200,
      contentType: 'text/html; charset=utf-8',
      bytes: SIGN_IN,
    });
    expect(r.verdict).toBe('gated');
    expect(r.sharingWouldNotHelp).toBe(false);
  });
});

describe('magic-byte checks', () => {
  it('a PNG that is not a PNG is wrong-type, not ok', () => {
    expect(
      classifyUploadReadback({
        fileName: 'step-01.png',
        status: 200,
        contentType: 'image/png',
        bytes: text('not an image at all, but long enough'),
      }).verdict,
    ).toBe('wrong-type');
  });

  it('accepts any ISO-BMFF brand, not just the one that was observed', () => {
    const mp42 = bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32);
    expect(
      classifyUploadReadback({ fileName: 'j.mp4', status: 200, contentType: 'video/mp4', bytes: mp42 })
        .verdict,
    ).toBe('ok');
  });

  it('a truncated body cannot pass a signature check', () => {
    expect(
      classifyUploadReadback({
        fileName: 'j.mp4',
        status: 200,
        contentType: 'video/mp4',
        bytes: bytes(0, 0, 0),
      }).verdict,
    ).toBe('wrong-type');
  });

  it('an empty text file is wrong-type', () => {
    expect(
      classifyUploadReadback({
        fileName: 'atlas-report.yaml',
        status: 200,
        contentType: 'text/plain',
        bytes: text(''),
      }).verdict,
    ).toBe('wrong-type');
  });

  /**
   * An `.xml` served as `text/plain` whose BODY is HTML still fails. The
   * content-type header is the server's claim; the bytes are the artifact.
   */
  it('catches an HTML body even when the content-type does not admit it', () => {
    expect(
      classifyUploadReadback({
        fileName: 'dump.xml',
        status: 200,
        contentType: 'text/plain',
        bytes: VIRUS_WARNING,
      }).verdict,
    ).toBe('interstitial');
  });

  it('does not invent a signature for a type ACE does not upload', () => {
    const r = classifyUploadReadback({
      fileName: 'thing.ccz',
      status: 200,
      contentType: 'application/zip',
      bytes: text('PK\u0003\u0004 anything'),
    });
    expect(r.verdict).toBe('ok');
    expect(r.evidence).toContain('no signature known');
  });

  it('an unreachable fetch is not silently ok', () => {
    expect(
      classifyUploadReadback({ fileName: 'j.mp4', status: null, bytes: null }).verdict,
    ).toBe('unreachable');
    expect(
      classifyUploadReadback({ fileName: 'j.mp4', status: 500, bytes: null }).verdict,
    ).toBe('unreachable');
  });
});
