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
import { tmpdir, homedir } from 'node:os';
import {
  resolveUpdateFileContent,
  resolveInlineOrLocalFile,
  prepareWritePath,
  resolvePatchXformXml,
  resolveUploadMultimediaBytes,
  resolveEnvSubstitution,
  ENV_ALLOW,
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

  it.each([
    ['standalone',                  '${ACE_HQ_API_KEY}',  { ACE_HQ_API_KEY: 'secret-40chars' }, 'secret-40chars'],
    ['embedded in larger string',   'Bearer ${TOKEN}',    { TOKEN: 'abc123' },                  'Bearer abc123'],
    ['multiple occurrences',        '${A}-${B}-${A}',     { A: 'x', B: 'y' },                   'x-y-x'],
  ] as const)('substitutes ${VAR} (%s)', (_label, input, env, expected) => {
    expect(resolveEnvSubstitution(input, env)).toBe(expected);
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

describe('resolveEnvSubstitution — allowlist (security audit 2026-07-31)', () => {
  // The MCP process env holds every secret in .env. The `allow` param stops
  // a tool argument from naming an arbitrary secret var (e.g. a prompt-
  // injected `${ACE_HQ_PASSWORD}` in a phone-number field) and shipping the
  // resolved value outbound. See the F1/preflight exfil finding.
  const env = {
    ACE_HQ_API_KEY: 'hq-key-40',
    ACE_HQ_EU_API_KEY: 'hq-eu-key',
    ACE_HQ_USERNAME: 'ace@dimagi-ai.com',
    ACE_E2E_PHONE: '+74260000101',
    ACE_E2E_PHONE_LOCAL: '0000101',
    ACE_HQ_PASSWORD: 'super-secret',
    LABS_MCP_TOKEN: 'labs-token',
    OCS_API_TOKEN: 'ocs-token',
    ACE_WEB_PAT_TOKEN: 'pat-token',
  };

  it('expands an allowlisted var', () => {
    expect(resolveEnvSubstitution('${ACE_HQ_API_KEY}', env, ENV_ALLOW.hqApiKey)).toBe('hq-key-40');
    expect(resolveEnvSubstitution('${ACE_HQ_EU_API_KEY}', env, ENV_ALLOW.hqApiKey)).toBe('hq-eu-key');
    expect(resolveEnvSubstitution('${ACE_HQ_USERNAME}', env, ENV_ALLOW.hqUsername)).toBe('ace@dimagi-ai.com');
    expect(resolveEnvSubstitution('${ACE_E2E_PHONE}', env, ENV_ALLOW.e2ePhone)).toBe('+74260000101');
    expect(resolveEnvSubstitution('${ACE_E2E_PHONE_LOCAL}', env, ENV_ALLOW.e2ePhone)).toBe('0000101');
  });

  it.each([
    ['password via api_key field', '${ACE_HQ_PASSWORD}', ENV_ALLOW.hqApiKey],
    ['labs token via api_key field', '${LABS_MCP_TOKEN}', ENV_ALLOW.hqApiKey],
    ['ocs token via phone field', '${OCS_API_TOKEN}', ENV_ALLOW.e2ePhone],
    ['pat token via username field', '${ACE_WEB_PAT_TOKEN}', ENV_ALLOW.hqUsername],
    ['api key via phone field', '${ACE_HQ_API_KEY}', ENV_ALLOW.e2ePhone],
  ] as const)('rejects a non-allowlisted var (%s)', (_label, input, allow) => {
    expect(() => resolveEnvSubstitution(input, env, allow)).toThrow(AtomArgUsageError);
    expect(() => resolveEnvSubstitution(input, env, allow)).toThrow(/substitution rejected/);
  });

  it('the rejection message names the var but NOT its resolved value', () => {
    try {
      resolveEnvSubstitution('${ACE_HQ_PASSWORD}', env, ENV_ALLOW.hqApiKey);
      throw new Error('expected a throw');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('ACE_HQ_PASSWORD');
      expect(msg).not.toContain('super-secret');
    }
  });

  it('rejects a denied var even when another allowed var is present', () => {
    expect(() =>
      resolveEnvSubstitution('${ACE_HQ_API_KEY}-${LABS_MCP_TOKEN}', env, ENV_ALLOW.hqApiKey),
    ).toThrow(/LABS_MCP_TOKEN/);
  });

  it('omitting allow keeps back-compat (any UPPER_SNAKE var expands)', () => {
    expect(resolveEnvSubstitution('${LABS_MCP_TOKEN}', env)).toBe('labs-token');
  });
});

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1218 — path-param parity across MCP atoms:
// drive_update_file gains localFilePath (the read half of read-modify-write
// was free via writeToPath; the write half paid full file size in context
// twice), and caller-supplied write paths create parent dirs + require
// absolute paths, matching drive_read_file's writeToPath (#1247, absorbed).
// ---------------------------------------------------------------------------

describe('resolveUpdateFileContent (#1218)', () => {
  it('rejects both args supplied', () => {
    expect(() =>
      resolveUpdateFileContent({ content: 'x', localFilePath: '/tmp/y.md' }),
    ).toThrow(/exactly one/);
  });

  it('rejects neither arg supplied', () => {
    expect(() => resolveUpdateFileContent({})).toThrow(/must supply one/);
  });

  it('returns small inline content verbatim', () => {
    expect(resolveUpdateFileContent({ content: 'hello' })).toBe('hello');
  });

  it('reads the file at localFilePath as utf-8', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ace-upd-'));
    const p = join(dir, 'patched.md');
    writeFileSync(p, '# patched\n');
    expect(resolveUpdateFileContent({ localFilePath: p })).toBe('# patched\n');
  });

  it('refuses oversized inline content with a typed error naming localFilePath', () => {
    // Mirrors drive_read_file's 40,000-char inline ceiling so the expensive
    // path is loud, not the silent default.
    const big = 'x'.repeat(40_001);
    expect(() => resolveUpdateFileContent({ content: big })).toThrow(
      /oversized_inline_content.*localFilePath/s,
    );
  });

  it('accepts content exactly at the ceiling', () => {
    const atLimit = 'x'.repeat(40_000);
    expect(resolveUpdateFileContent({ content: atLimit })).toBe(atLimit);
  });
});

describe('prepareWritePath (#1218 / #1247)', () => {
  it('creates missing parent directories and returns the path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ace-wp-'));
    const target = join(dir, 'does', 'not', 'exist', 'yet', 'a.ccz');
    expect(prepareWritePath(target)).toBe(target);
    writeFileSync(target, 'ok'); // the write the atom performs next must succeed
  });

  it('is a no-op when the parent already exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ace-wp2-'));
    const target = join(dir, 'b.ccz');
    expect(prepareWritePath(target)).toBe(target);
  });

  it('rejects a relative path with a typed error', () => {
    // The MCP server's CWD is the plugin cache, not the caller's project —
    // a relative path writes somewhere unexpected (same guard as
    // drive_read_file's writeToPath).
    expect(() => prepareWritePath('relative/a.ccz')).toThrow(/not_absolute/);
  });
});

describe('resolveInlineOrLocalFile — the shared write-side handle (#1780)', () => {
  it('refuses both inline and localFilePath, naming the atom and its inline param', () => {
    expect(() =>
      resolveInlineOrLocalFile({
        atom: 'drive_create_doc_from_markdown', inlineParam: 'markdown',
        inline: 'x', localFilePath: '/tmp/y.md',
      }),
    ).toThrow(/drive_create_doc_from_markdown: pass exactly one of markdown or localFilePath/);
  });

  it('refuses neither', () => {
    expect(() =>
      resolveInlineOrLocalFile({ atom: 'drive_create_file', inlineParam: 'content' }),
    ).toThrow(/drive_create_file: must supply one of content or localFilePath/);
  });

  it('returns the inline payload unchanged when no ceiling is set', () => {
    // The create atoms deliberately ship with NO ceiling (ace#1780): the
    // handle is additive, a refusal is a contract change for every caller.
    const big = 'x'.repeat(200_000);
    expect(
      resolveInlineOrLocalFile({ atom: 'drive_create_file', inlineParam: 'content', inline: big }),
    ).toBe(big);
  });

  it('reads utf-8 off disk when localFilePath is given', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'ace-inline-')), 'pdd.md');
    writeFileSync(p, '# PDD\n\nem—dash and “smart quotes”\n', 'utf-8');
    expect(
      resolveInlineOrLocalFile({ atom: 'drive_create_doc_from_markdown', inlineParam: 'markdown', localFilePath: p }),
    ).toBe('# PDD\n\nem—dash and “smart quotes”\n');
  });

  it('gives BYTE-IDENTICAL results for two atoms reading the same file — the ace#1780 correctness half', () => {
    // idea-to-pdd steps 6 + 6b write one document to two Drive files. Inline,
    // that is two independent emissions with nothing verifying they match.
    const p = join(mkdtempSync(join(tmpdir(), 'ace-inline-')), 'pdd.md');
    const body = '# PDD\n\n' + 'paragraph\n'.repeat(5_000);
    writeFileSync(p, body, 'utf-8');
    const rendered = resolveInlineOrLocalFile({ atom: 'drive_create_doc_from_markdown', inlineParam: 'markdown', localFilePath: p });
    const companion = resolveInlineOrLocalFile({ atom: 'drive_create_file', inlineParam: 'content', localFilePath: p });
    expect(rendered).toBe(companion);
    expect(rendered).toBe(body);
  });

  it('still refuses a credential path (ace#1110 F2), naming the calling atom', () => {
    // Assert the GUARD's message, not merely "it threw" — an ENOENT from a
    // path that happens not to exist would satisfy a bare .toThrow() and the
    // test would pass with the guard deleted.
    expect(() =>
      resolveInlineOrLocalFile({
        atom: 'drive_create_file', inlineParam: 'content',
        localFilePath: join(homedir(), '.ssh', 'id_rsa'),
      }),
    ).toThrow(/drive_create_file: refusing to touch .* basename matches/);
  });

  it('refuses a credential path that EXISTS, so the guard is what rejects it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ace-inline-'));
    const p = join(dir, '.env');
    writeFileSync(p, 'ACE_HQ_PASSWORD=hunter2\n', 'utf-8');
    expect(() =>
      resolveInlineOrLocalFile({
        atom: 'drive_create_doc_from_markdown', inlineParam: 'markdown', localFilePath: p,
      }),
    ).toThrow(/drive_create_doc_from_markdown: refusing to touch/);
  });

  it('honours an inlineCeiling when one IS supplied', () => {
    expect(() =>
      resolveInlineOrLocalFile({
        atom: 'drive_update_file', inlineParam: 'content',
        inline: 'x'.repeat(11), inlineCeiling: 10,
      }),
    ).toThrow(/oversized_inline_content.*localFilePath/s);
  });
});
