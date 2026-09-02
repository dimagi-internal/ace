/**
 * ace#1780 — the gdrive WRITE atoms took their payload inline only, while
 * their read-side siblings had taken a path handle for months.
 *
 * `drive_read_file` and `drive_download_binary` both have `writeToPath`;
 * `drive_update_file` and `drive_upload_binary` both have `localFilePath`.
 * `drive_create_file` and `drive_create_doc_from_markdown` had NEITHER, so a
 * ~52 KB PDD went through the model as a tool argument — twice, because
 * `idea-to-pdd` steps 6 and 6b write the same document to two Drive files.
 *
 * The COST half is ~13k output tokens per emission. The CORRECTNESS half is
 * worse: step 6b's whole premise is that the two copies are byte-identical
 * (that is what makes `run-surface-audit`'s DOC-FIDELITY check meaningful),
 * and with inline-only payloads the agent typed the document out twice
 * independently with nothing verifying the two emissions matched.
 *
 * Source-level on purpose: `mcp/google-drive-server.ts` does a top-level
 * `await server.connect(transport)`, so importing it connects stdio — the
 * same reason test/mcp/registration-coverage.test.ts parses statically.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');
const server = readFileSync(join(REPO, 'mcp/google-drive-server.ts'), 'utf8');

/** The source of one `server.tool('<name>', …)` registration + its handler. */
function toolSource(tool: string): string {
  const at = server.indexOf(`'${tool}',`);
  expect(at, `${tool} is not registered in mcp/google-drive-server.ts`).toBeGreaterThan(-1);
  const next = server.indexOf('server.tool(', at);
  return server.slice(at, next === -1 ? server.length : next);
}

/** The Zod parameter keys of one registration. */
function schemaKeys(tool: string): string[] {
  const src = toolSource(tool);
  const seg = src.slice(0, src.indexOf('async ('));
  return [...new Set([...seg.matchAll(/^\s{4}([a-zA-Z_][a-zA-Z0-9_]*):\s*z\./gm)].map((m) => m[1]))];
}

const WRITE_ATOMS = ['drive_create_file', 'drive_create_doc_from_markdown'] as const;
const INLINE_PARAM: Record<string, string> = {
  drive_create_file: 'content',
  drive_create_doc_from_markdown: 'markdown',
};

describe.each(WRITE_ATOMS)('%s takes a path handle (ace#1780)', (tool) => {
  const keys = schemaKeys(tool);
  const src = toolSource(tool);
  const inlineParam = INLINE_PARAM[tool];

  it('the extractor found the registration', () => {
    expect(keys).toContain('parentFolderId');
    expect(keys).toContain(inlineParam);
  });

  it('exposes localFilePath — the ESTABLISHED write-side name, not a third one', () => {
    // `drive_update_file` and `drive_upload_binary` already take
    // `localFilePath`. A new name for the same idea (fromPath, sourcePath, …)
    // makes the pairing unguessable, which is its own defect.
    expect(keys).toContain('localFilePath');
  });

  it('makes the inline param OPTIONAL so localFilePath can stand alone', () => {
    // A required inline param would make the handle unreachable: every caller
    // would still have to send the payload.
    const seg = src.slice(0, src.indexOf('async ('));
    expect(seg).toMatch(new RegExp(`${inlineParam}: z\\.string\\(\\)\\.optional\\(\\)`));
  });

  it('enforces exactly-one through the shared resolver, not ad-hoc in the handler', () => {
    expect(src).toMatch(/resolveInlineOrLocalFile\(\{/);
    expect(src).toMatch(new RegExp(`inlineParam: '${inlineParam}'`));
    expect(src).toMatch(new RegExp(`atom: '${tool}'`));
  });

  it('does NOT impose an inline size ceiling', () => {
    // Deliberate in ace#1780 (the handle is additive; a refusal changes the
    // contract for every existing caller), and now a MEASURED decision
    // (ace#1907): over 1,572 live text artifacts, 40,000 sits below the p99
    // and would hard-fail a recurring write in six unconverted producers
    // across Phases 2/3/5/6/8. The ceiling is sequenced behind converting
    // them.
    //
    // If this assertion fails you are adding one — read
    // test/lib/create-atom-inline-ceiling.test.ts first (and ace#1918): it enumerates
    // exactly which producers each candidate number breaks.
    expect(src).not.toMatch(/inlineCeiling/);
  });

  it('names localFilePath in its description so a caller can find it', () => {
    const desc = src.slice(0, src.indexOf('  {\n'));
    expect(desc).toMatch(/localFilePath/);
  });
});

describe('the write-side param family stays consistent', () => {
  it('all four text/binary write atoms use localFilePath', () => {
    for (const tool of ['drive_update_file', 'drive_upload_binary', ...WRITE_ATOMS]) {
      expect(schemaKeys(tool), `${tool} should take localFilePath`).toContain('localFilePath');
    }
  });

  it('no write atom introduces a rival name for the same idea', () => {
    for (const tool of ['drive_update_file', 'drive_upload_binary', ...WRITE_ATOMS]) {
      const keys = schemaKeys(tool);
      for (const rival of ['fromPath', 'sourcePath', 'inputPath', 'readFromPath']) {
        expect(keys, `${tool} introduced a rival to localFilePath`).not.toContain(rival);
      }
    }
  });
});
