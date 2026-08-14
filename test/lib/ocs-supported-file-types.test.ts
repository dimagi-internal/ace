/**
 * dimagi-internal/ace#1296 — an `.xlsx` was silently dropped from an OCS
 * collection upload, and the atom only discovered it post-hoc by diffing a
 * scraped listing (the #1016 count assertion doing its job, expensively).
 *
 * The issue hypothesised a `SUPPORTED_FILE_TYPES` pre-flight. Reading the OCS
 * source shows a pre-flight against the list it names would have prevented
 * NOTHING — `.xlsx` IS in `SUPPORTED_FILE_TYPES["collections"]`. The real gate
 * is a branch (`apps/documents/views.py::add_collection_files`):
 *
 *     supported_extensions = (
 *         settings.SUPPORTED_FILE_TYPES["file_search"]     # when collection.is_index
 *         if collection.is_index
 *         else settings.SUPPORTED_FILE_TYPES["collections"]
 *     ).split(",")
 *
 * ACE's RAG collections are created `is_index: true` (ocs-agent-setup Step 5),
 * so the applicable list is `file_search` — which has NO spreadsheet formats at
 * all. That is why the workbook died, and why the obvious fix would have been
 * a plausible guess that shipped nothing.
 */
import { describe, it, expect } from 'vitest';

import {
  OCS_SUPPORTED_FILE_TYPES,
  findUnsupportedCollectionFiles,
} from '../../lib/ocs-supported-file-types.js';

describe('OCS supported file types, pinned from source (#1296)', () => {
  it('keeps the two lists distinct — the branch is the whole point', () => {
    expect(OCS_SUPPORTED_FILE_TYPES.file_search).toContain('.md');
    expect(OCS_SUPPORTED_FILE_TYPES.collections).toContain('.xlsx');
    // The trap: xlsx is fine for a NON-indexed collection and rejected for an
    // indexed one. A single merged list would re-create ace#1296.
    expect(OCS_SUPPORTED_FILE_TYPES.file_search).not.toContain('.xlsx');
  });

  it('flags the live casualty for an INDEXED collection (ACE default)', () => {
    const files = [
      '01-pdd.md',
      'FCAP App + M&E — Monitoring indicators + form catalog (Spark/Enock).xlsx',
      '03-training-flw-guide.md',
    ];
    const bad = findUnsupportedCollectionFiles(files, { isIndex: true });
    expect(bad).toHaveLength(1);
    expect(bad[0].name).toMatch(/\.xlsx$/);
    expect(bad[0].extension).toBe('.xlsx');
  });

  it('does NOT flag the same file for a non-indexed collection', () => {
    const bad = findUnsupportedCollectionFiles(['book.xlsx'], { isIndex: false });
    expect(bad).toEqual([]);
  });

  it('is case-insensitive on the extension', () => {
    expect(findUnsupportedCollectionFiles(['REPORT.XLSX'], { isIndex: true })).toHaveLength(1);
    expect(findUnsupportedCollectionFiles(['NOTES.MD'], { isIndex: true })).toEqual([]);
  });

  it('flags a file with no extension at all (OCS requires one)', () => {
    // `if not ext or ext not in supported_extensions` — a bare name is invalid.
    expect(findUnsupportedCollectionFiles(['README'], { isIndex: true })).toHaveLength(1);
  });

  it('accepts the formats ACE actually indexes', () => {
    const files = ['a.md', 'b.txt', 'c.pdf', 'd.docx', 'e.json', 'f.html'];
    expect(findUnsupportedCollectionFiles(files, { isIndex: true })).toEqual([]);
  });
});
