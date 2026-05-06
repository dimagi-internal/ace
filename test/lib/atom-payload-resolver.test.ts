/**
 * Unit tests for the atom-payload resolvers shared by
 * `commcare_patch_xform` and `commcare_upload_multimedia`.
 *
 * Background: 0.13.25 added a file-path alternative arg next to each
 * atom's inline payload arg, because tool-call wrappers around the
 * MCP host hit practical arg-size limits on real CCHQ form-XML
 * (~12K chars) and PNG payloads (~1.6 MB base64). Exactly one of the
 * two must be supplied — both or neither is a usage error.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolvePatchXformXml,
  resolveUploadMultimediaBytes,
  AtomArgUsageError,
} from '../../lib/atom-payload-resolver.js';

const TMP = mkdtempSync(join(tmpdir(), 'ace-atom-resolver-'));

describe('resolvePatchXformXml', () => {
  it('returns the inline string when only new_xform_xml is given', () => {
    const xml = '<h:html xmlns:h="x"><patched/></h:html>';
    expect(resolvePatchXformXml({ new_xform_xml: xml })).toBe(xml);
  });

  it('reads the file when only new_xform_xml_path is given', () => {
    const xml = '<h:html xmlns:h="x"><from-disk/></h:html>';
    const p = join(TMP, 'patched-form.xml');
    writeFileSync(p, xml, 'utf-8');
    expect(resolvePatchXformXml({ new_xform_xml_path: p })).toBe(xml);
  });

  it('throws AtomArgUsageError when both are given', () => {
    expect(() =>
      resolvePatchXformXml({
        new_xform_xml: '<a/>',
        new_xform_xml_path: '/tmp/whatever',
      }),
    ).toThrow(AtomArgUsageError);
    expect(() =>
      resolvePatchXformXml({
        new_xform_xml: '<a/>',
        new_xform_xml_path: '/tmp/whatever',
      }),
    ).toThrow(/exactly one/);
  });

  it('throws AtomArgUsageError when neither is given', () => {
    expect(() => resolvePatchXformXml({})).toThrow(AtomArgUsageError);
    expect(() => resolvePatchXformXml({})).toThrow(/must supply one/);
  });

  it('preserves whitespace + non-ASCII content from the file as-is', () => {
    // Real forms include newlines, tabs, and the occasional non-ASCII
    // glyph in itext labels. The resolver must NOT munge whitespace or
    // re-encode multibyte chars on the way through.
    const xml = `<h:html xmlns:h="x">
  <h:head>
    <model>
      <itext><translation lang="en"><text id="x-label"><value>Café — naïve</value></text></translation></itext>
    </model>
  </h:head>
</h:html>
`;
    const p = join(TMP, 'unicode-form.xml');
    writeFileSync(p, xml, 'utf-8');
    expect(resolvePatchXformXml({ new_xform_xml_path: p })).toBe(xml);
  });
});

describe('resolveUploadMultimediaBytes', () => {
  it('decodes the base64 string when only file_bytes_base64 is given', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    const out = resolveUploadMultimediaBytes({
      file_bytes_base64: buf.toString('base64'),
    });
    expect(out.equals(buf)).toBe(true);
  });

  it('reads the file as raw bytes when only file_bytes_path is given', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    const p = join(TMP, 'binary.bin');
    writeFileSync(p, buf);
    const out = resolveUploadMultimediaBytes({ file_bytes_path: p });
    expect(out.equals(buf)).toBe(true);
  });

  it('round-trips a typical-size PNG via the file path mode', () => {
    // 1×1 transparent PNG, ~67 bytes — same fixture used in
    // probe-multimedia-upload.ts. Asserts no base64 round-trip happens
    // on the file-path code path.
    const tinyPngB64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const buf = Buffer.from(tinyPngB64, 'base64');
    const p = join(TMP, 'tiny.png');
    writeFileSync(p, buf);
    const out = resolveUploadMultimediaBytes({ file_bytes_path: p });
    expect(out.equals(buf)).toBe(true);
    expect(out.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); // PNG sig
  });

  it('throws AtomArgUsageError when both are given', () => {
    expect(() =>
      resolveUploadMultimediaBytes({
        file_bytes_base64: 'AA==',
        file_bytes_path: '/tmp/whatever',
      }),
    ).toThrow(AtomArgUsageError);
    expect(() =>
      resolveUploadMultimediaBytes({
        file_bytes_base64: 'AA==',
        file_bytes_path: '/tmp/whatever',
      }),
    ).toThrow(/exactly one/);
  });

  it('throws AtomArgUsageError when neither is given', () => {
    expect(() => resolveUploadMultimediaBytes({})).toThrow(AtomArgUsageError);
    expect(() => resolveUploadMultimediaBytes({})).toThrow(/must supply one/);
  });
});
