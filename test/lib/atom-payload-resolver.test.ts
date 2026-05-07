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
  resolveEnvSubstitution,
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

describe('resolveEnvSubstitution', () => {
  // Background: jjackson/ace#106 finding 6 — `connect_create_opportunity`
  // used to forward the literal string `${ACE_HQ_API_KEY}` to Connect,
  // surfacing as the misleading "Failed to fetch apps from CommCare HQ"
  // validation error.

  it('passes through strings without ${VAR} unchanged', () => {
    expect(resolveEnvSubstitution('hello world', {})).toBe('hello world');
    expect(resolveEnvSubstitution('', {})).toBe('');
    expect(resolveEnvSubstitution('value with $ and { but no var', {})).toBe(
      'value with $ and { but no var',
    );
  });

  it('substitutes ${VAR} from the supplied env', () => {
    expect(
      resolveEnvSubstitution('${ACE_HQ_API_KEY}', { ACE_HQ_API_KEY: 'secret-40chars' }),
    ).toBe('secret-40chars');
  });

  it('substitutes ${VAR} embedded in a larger string', () => {
    expect(
      resolveEnvSubstitution('Bearer ${TOKEN}', { TOKEN: 'abc123' }),
    ).toBe('Bearer abc123');
  });

  it('substitutes multiple ${VAR} occurrences in one call', () => {
    expect(
      resolveEnvSubstitution('${A}-${B}-${A}', { A: 'x', B: 'y' }),
    ).toBe('x-y-x');
  });

  it('throws when a referenced env var is missing', () => {
    expect(() => resolveEnvSubstitution('${UNSET_VAR}', {})).toThrow(AtomArgUsageError);
    expect(() => resolveEnvSubstitution('${UNSET_VAR}', {})).toThrow(/UNSET_VAR/);
  });

  it('throws when a referenced env var is empty', () => {
    // Empty-string env vars are treated as unset — better to fail loudly
    // than to send an empty API key to Connect.
    expect(() => resolveEnvSubstitution('${API_KEY}', { API_KEY: '' })).toThrow(/API_KEY/);
  });

  it('aggregates multiple missing vars into one error message', () => {
    expect(() => resolveEnvSubstitution('${A}-${B}', {})).toThrow(/A.*B|B.*A/);
  });

  it('preserves a literal `${VAR}` when escaped with a backslash', () => {
    // Edge case: caller actually wants the literal string `${X}` in
    // their payload (e.g. documenting an env var pattern in a
    // description). `\${X}` is the escape hatch.
    expect(resolveEnvSubstitution('\\${X}', { X: 'should-not-substitute' })).toBe('${X}');
  });

  it('mixes substituted and escaped patterns in the same string', () => {
    expect(
      resolveEnvSubstitution('${REAL} and \\${LITERAL}', { REAL: 'x', LITERAL: 'unused' }),
    ).toBe('x and ${LITERAL}');
  });

  it('lower-case names are not substituted (matches typical env var conventions)', () => {
    // Convention: env vars are UPPER_SNAKE_CASE. Lower-case `${var}`
    // patterns pass through to avoid clashing with template syntaxes
    // like JavaScript template-literal placeholders that callers
    // might be storing in ACE artifacts.
    expect(resolveEnvSubstitution('${lower_case}', { lower_case: 'x' })).toBe(
      '${lower_case}',
    );
  });
});
