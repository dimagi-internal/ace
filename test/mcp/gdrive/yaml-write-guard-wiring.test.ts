/**
 * dimagi-internal/ace#2866 — the wiring half.
 *
 * `yamlParseWriteRefusal` is only worth anything if every atom that can write
 * a `.yaml` file actually calls it. The guards live inside the `server.tool`
 * closures rather than in the exported `handleCreateFile` / `handleUploadBinary`
 * helpers, so there is no handler to drive end to end from here; what IS
 * checkable, and what would silently regress, is the chain at each call site.
 *
 * This is a structural ratchet, and it is honest about that: it proves the
 * guard is REACHED by all three write paths. What the guard then DOES is
 * proven behaviourally in test/lib/yaml-parse-write-guard.test.ts.
 *
 * The specific hole it pins is the one ace#2866 came through. The QA/verdict
 * guards used to run on `drive_update_file` only behind a content sniff
 * (`/^skill:\s*\S+-(qa|eval)\s*$/m`) — a cost dodge, because reading the file
 * NAME meant an extra `files.get`. So an in-place rewrite of any other state
 * file was checked by nothing, which is exactly the atom the broken `opp.yaml`
 * was repaired through. The name now comes free off the mimeType read that
 * handler already performs unconditionally.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '../../../mcp/google-drive-server.ts');
const src = fs.readFileSync(SERVER, 'utf8');

describe('every Drive write path reaches the YAML parse guard (ace#2866)', () => {
  it('imports it', () => {
    expect(src).toMatch(
      /import \{[^}]*yamlParseWriteRefusal[^}]*\} from '\.\.\/lib\/qa-result-write-guard\.js'/,
    );
  });

  it('calls it on all three write atoms', () => {
    // drive_create_file, drive_update_file, drive_upload_binary.
    const calls = src.match(/yamlParseWriteRefusal\(/g) ?? [];
    expect(calls.length).toBe(3);
  });

  it('chains it AFTER the narrower QA and verdict guards at each site', () => {
    // `qa ?? verdict ?? yaml` — the specific, actionable message wins when the
    // file has a shape worth naming; the parse floor catches everything else.
    const chains = src.match(
      /qaResultWriteRefusal\([^;]*?\?\?[\s\S]{0,200}?verdictWriteRefusal\([^;]*?\?\?[\s\S]{0,200}?yamlParseWriteRefusal\(/g,
    ) ?? [];
    expect(chains.length).toBe(3);
  });

  it('drive_update_file reads the file NAME from the metadata call it already makes', () => {
    // If this reverts to `fields: 'mimeType'`, the update path has no name to
    // key the guards on and the sniff-gated hole reopens.
    // (`parents` rides along for the grade's artifact_sha256 stamp, ace#3092.)
    expect(src).toMatch(/drive\.files\.get\(\{ fileId, fields: 'name, mimeType(?:, parents)?', supportsAllDrives: true \}\)/);
  });

  it('no longer gates the update-path guards behind a content sniff', () => {
    // The `^skill: <x>-qa$` sniff was the cost dodge that left every other
    // state file unchecked on in-place rewrite.
    expect(src).not.toMatch(/\^skill:\\s\*\\S\+-\(qa\|eval\)/);
  });

  it('refuses before any Drive write at every site', () => {
    // Each guard result is returned as an error, never logged and continued.
    const returns = src.match(/if \((?:qaRefusal|writeRefusal)\) return error\((?:qaRefusal|writeRefusal)\);/g) ?? [];
    expect(returns.length).toBe(3);
  });
});
