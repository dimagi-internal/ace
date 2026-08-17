/**
 * Class-level ratchet for dimagi-internal/ace#1110.
 *
 * The credential denylist (`assertNotCredentialPath`) was wired across the
 * read/upload path arguments — drive_upload_binary, drive_update_file,
 * commcare_download_ccz, commcare_patch_xform, commcare_upload_multimedia,
 * ocs_upload_collection_files — and the issue recorded it as covering "all
 * six path args (reads AND writes)".
 *
 * It did not. Three WRITE sinks were skipped: drive_read_file.writeToPath,
 * drive_download_binary.writeToPath, and ocs_download_file.writeToPath. Each
 * carried only `path.isAbsolute()`, which is a correctness check (the MCP
 * subprocess's cwd is the plugin cache, so a relative path lands somewhere
 * surprising) and NOT a containment one. A write sink is an overwrite
 * primitive: a "download" onto `.env`, a git hook, or `~/.ssh/authorized_keys`
 * is a clobber, and the isAbsolute check happily permits all three.
 *
 * Three point tests would have closed those three. This ratchet closes the
 * CLASS: any NEW writeToPath sink added to an MCP server must be guarded too,
 * or this fails. That is the difference between fixing the instance and making
 * the instance impossible — see CLAUDE.md § "Class-level preventers".
 *
 * It is deliberately a source-level check. The gdrive handlers are exported
 * and have real behavioral tests (see read-file-paging / download-binary), but
 * the OCS handler is inline in its `server.tool` registration and has no seam;
 * asserting the wiring is what is actually available without a refactor whose
 * only purpose would be testability.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SERVERS = [
  'mcp/google-drive-server.ts',
  'mcp/ocs-server.ts',
  'mcp/connect-server.ts',
  'mcp/mobile-server.ts',
];

/** Every line that actually writes bytes to a caller-supplied path. */
const WRITE_CALL = /\b(?:fs|fsSync|fsNode)?\.?writeFileSync\s*\(\s*(\w+)/;

describe('every writeToPath sink is credential-guarded (#1110)', () => {
  for (const rel of SERVERS) {
    it(`${rel}: no unguarded write to a caller-supplied path`, () => {
      let src: string;
      try {
        src = readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
      } catch {
        return; // server not present in this checkout — nothing to assert
      }

      const lines = src.split('\n');
      const offenders: string[] = [];

      lines.forEach((line, i) => {
        const m = line.match(WRITE_CALL);
        if (!m) return;
        const target = m[1];
        // Only caller-supplied destinations are in scope. A write to an
        // internally-derived path (a temp file, a computed cache entry) is
        // not an injection surface.
        if (!/^(writeToPath|safePath|write_to_path)$/.test(target)) return;

        // Look back a bounded window for the guard on this handler.
        const window = lines.slice(Math.max(0, i - 25), i).join('\n');
        if (/assertNotCredentialPath\s*\(/.test(window)) return;

        offenders.push(`${rel}:${i + 1} — writeFileSync(${target}) with no assertNotCredentialPath above it`);
      });

      expect(
        offenders,
        `Unguarded writeToPath sink(s). A write sink is an overwrite primitive:\n` +
          `path.isAbsolute() is a correctness check, not containment.\n` +
          `Add assertNotCredentialPath(<path>, { atom: '<atom>' }) before the write.\n` +
          offenders.join('\n'),
      ).toEqual([]);
    });
  }

  it('the ratchet actually detects an unguarded sink (negative control)', () => {
    // Without this, a regex that silently matched nothing would "pass" forever.
    const fake = [
      'async function handler(args) {',
      '  const { writeToPath } = args;',
      '  fs.mkdirSync(path.dirname(writeToPath), { recursive: true });',
      '  fs.writeFileSync(writeToPath, body);',
      '}',
    ];
    const hits = fake.filter((l, i) => {
      const m = l.match(WRITE_CALL);
      if (!m || !/^(writeToPath|safePath|write_to_path)$/.test(m[1])) return false;
      return !/assertNotCredentialPath\s*\(/.test(fake.slice(0, i).join('\n'));
    });
    expect(hits).toHaveLength(1);
  });
});
