/**
 * dimagi-internal/ace#2212 — a `write_to_path` docstring must describe the shape
 * the code actually writes.
 *
 * `connect_list_programs` and `connect_list_opportunities` both gained
 * `write_to_path` in ace#1799, because both org-wide reads overflow the
 * tool-result cap on `ai-demo-space` and `connect-program-setup` MANDATES both
 * (Step 2's unfiltered reuse scan, Step 4a's Σ). Both docstrings promised to
 * write the "array":
 *
 *     'If set, write the full untruncated `programs` array as JSON ...'
 *     'If set, write the full `opportunities` array as JSON ...'
 *
 * Both implementations write an OBJECT WRAPPING that array:
 *
 *     fs.writeFileSync(dest, JSON.stringify({ programs }, null, 2), 'utf8');
 *     fs.writeFileSync(dest, JSON.stringify({ opportunities: res.opportunities }, ...));
 *
 * So the obvious `JSON.parse(file).map(...)` throws. Observed on
 * `spark-facilitator/20260907-1120` Phase 4 Step 2: the read came back
 * `dict | keys: ['programs']` against a docstring promising a list.
 *
 * Cheap in isolation, but it is paid by EVERY Phase 4 run on a mature org, and
 * the docstrings also claimed to "mirror `commcare_download_ccz`'s
 * `write_to_path`" — which writes raw CCZ BYTES, so the one cross-reference an
 * agent could have checked pointed at a third, different format.
 *
 * The fix was the docs, not the shape: the wrapper is self-describing and
 * consistent across both atoms, and changing the payload would silently break
 * any caller already written against the real behaviour.
 *
 * This test pins DOC-TO-CODE AGREEMENT rather than either side alone. A future
 * change to the written shape fails here until the docstring is updated with
 * it, which is the actual invariant — the defect was never that one side was
 * wrong, it was that the two disagreed and only the runtime knew.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, '../../../../mcp/connect-server.ts');
const source = fs.readFileSync(SERVER, 'utf8');

/**
 * The `.describe(...)` text of the `write_to_path` param that sits closest
 * above the given `writeFileSync` call — i.e. the doc a caller of THAT atom
 * reads. Deliberately positional rather than name-based: both atoms declare a
 * param literally called `write_to_path`, so a name lookup cannot tell them
 * apart.
 */
function docstringGoverning(writeCallSubstring: string): string {
  const writeIdx = source.indexOf(writeCallSubstring);
  expect(
    writeIdx,
    `expected to find the write call ${JSON.stringify(writeCallSubstring)} in mcp/connect-server.ts`,
  ).toBeGreaterThan(-1);

  const before = source.slice(0, writeIdx);
  const declIdx = before.lastIndexOf('write_to_path: z.string()');
  expect(
    declIdx,
    `expected a write_to_path declaration above ${JSON.stringify(writeCallSubstring)}`,
  ).toBeGreaterThan(-1);

  // The describe() argument runs to the end of that source line.
  const lineEnd = source.indexOf('\n', declIdx);
  return source.slice(declIdx, lineEnd === -1 ? undefined : lineEnd);
}

describe('ace#2212 — write_to_path docstrings match the shape actually written', () => {
  const cases = [
    {
      atom: 'connect_list_programs',
      write: "JSON.stringify({ programs }",
      key: 'programs',
    },
    {
      atom: 'connect_list_opportunities',
      write: "JSON.stringify({ opportunities: res.opportunities }",
      key: 'opportunities',
    },
  ] as const;

  for (const { atom, write, key } of cases) {
    describe(atom, () => {
      it('still writes an object wrapping the array (the premise this test pins)', () => {
        expect(source).toContain(write);
      });

      it('documents the OBJECT shape, naming the key a caller must read', () => {
        const doc = docstringGoverning(write);
        expect(
          doc,
          `${atom}'s write_to_path docstring must state that the file holds ` +
            `{"${key}": [...]}, because that is what the code writes`,
        ).toContain(`{"${key}": [...]}`);
      });

      it('does not promise a bare array', () => {
        const doc = docstringGoverning(write);
        // The exact phrasing that was wrong, in both atoms, for the whole
        // lifetime of the ace#1799 fix that introduced them.
        expect(doc).not.toContain('array as JSON');
        expect(doc).not.toMatch(/write the full (untruncated )?\S+ array\b/);
      });

      it('does not claim the FORMAT mirrors commcare_download_ccz, which writes raw bytes', () => {
        const doc = docstringGoverning(write);
        expect(doc).not.toMatch(/Mirrors `commcare_download_ccz`'s `write_to_path`\./);
      });
    });
  }
});
