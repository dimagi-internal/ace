//
// OCS's upload allowlists, pinned from source — and the branch between them.
//
// Why this exists: dimagi-internal/ace#1296. A 445 KB `.xlsx` was silently
// dropped from a collection upload and only surfaced post-hoc, via the #1016
// count assertion diffing a scraped listing. The obvious fix — pre-flight
// against `SUPPORTED_FILE_TYPES` — would have prevented NOTHING, because
// `.xlsx` IS in that constant. The gate is a BRANCH
// (`apps/documents/views.py::add_collection_files`):
//
//     supported_extensions = (
//         settings.SUPPORTED_FILE_TYPES["file_search"]     # when collection.is_index
//         if collection.is_index
//         else settings.SUPPORTED_FILE_TYPES["collections"]
//     ).split(",")
//
// ACE creates RAG collections with `is_index: true` (`ocs-agent-setup` Step 5),
// so the applicable list is `file_search`, which carries NO spreadsheet format
// at all. Hence: a file can be perfectly valid for a media collection and
// rejected by the indexed one ACE always builds.
//
// Source of truth: dimagi/open-chat-studio `config/settings.py`
// (SUPPORTED_FILE_TYPES) + `apps/documents/views.py` (the is_index branch),
// read 2026-08-14. Transcribed rather than probed because OCS exposes no API
// for it; re-read both when OCS ships a new file-type change.
//

/** Verbatim from `config/settings.py::SUPPORTED_FILE_TYPES`. */
export const OCS_SUPPORTED_FILE_TYPES = {
  /** Applied when `collection.is_index` — the list ACE's RAG collections hit. */
  file_search:
    '.c,.cs,.cpp,.doc,.docx,.html,.java,.json,.md,.pdf,.php,.pptx,.py,.py,.rb,.tex,.txt,.css,.js,.sh,.ts',
  /** Applied to NON-indexed (media) collections only. */
  collections:
    '.txt,.pdf,.doc,.docx,.xls,.xlsx,.csv,.jpg,.jpeg,.png,.gif,.bmp,.webp,.svg,.mp4,.mov,.avi,.mp3,.wav,.html,.htm,' +
    '.css,.js,.xml,.md,.ics,.vcf,.rtf,.tsv,.yaml,.yml,.py,.c',
} as const;

export interface UnsupportedCollectionFile {
  name: string;
  /** Lowercased extension including the dot; `''` when the name carries none. */
  extension: string;
  /** Which allowlist was applied. */
  allowlist: 'file_search' | 'collections';
}

function extensionOf(name: string): string {
  const base = name.split('/').pop() ?? name;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot).toLowerCase();
}

/**
 * Files OCS will reject for this collection shape. Empty means every file is
 * uploadable — NOT that every file will index cleanly (that is a separate
 * async step, `ocs_wait_for_collection_indexing`).
 *
 * `isIndex` defaults to `true`: every ACE collection is indexed, and defaulting
 * to the STRICTER list fails safe. A caller building a media collection passes
 * `false` explicitly.
 */
export function findUnsupportedCollectionFiles(
  names: readonly string[],
  opts: { isIndex?: boolean } = {},
): UnsupportedCollectionFile[] {
  const isIndex = opts.isIndex ?? true;
  const allowlist = isIndex ? 'file_search' : 'collections';
  const allowed = new Set(
    OCS_SUPPORTED_FILE_TYPES[allowlist].split(',').map((e) => e.trim().toLowerCase()),
  );
  const out: UnsupportedCollectionFile[] = [];
  for (const name of names) {
    const extension = extensionOf(name);
    // Mirrors OCS: `if not ext or ext not in supported_extensions`.
    if (!extension || !allowed.has(extension)) out.push({ name, extension, allowlist });
  }
  return out;
}

/** Operator-facing explanation for a pre-flight rejection. */
export function formatUnsupportedFilesError(bad: readonly UnsupportedCollectionFile[]): string {
  const allowlist = bad[0]?.allowlist ?? 'file_search';
  return (
    `ocs_upload_collection_files: ${bad.length} file(s) would be rejected by OCS and silently ` +
    `dropped from the batch:\n` +
    bad.map((b) => `  - ${b.name} (${b.extension || 'no extension'})`).join('\n') +
    `\nThis collection is ${allowlist === 'file_search' ? 'INDEXED' : 'non-indexed'}, so OCS applies ` +
    `its \`${allowlist}\` allowlist: ${OCS_SUPPORTED_FILE_TYPES[allowlist]}\n` +
    (allowlist === 'file_search'
      ? 'Note spreadsheets (.xls/.xlsx/.csv) are accepted for NON-indexed collections and rejected ' +
        'for indexed ones — which is why this is easy to get wrong (ace#1296). Convert the file to ' +
        'a text form ACE can index (.md/.csv->.md extract) and re-run; nothing was uploaded.'
      : 'Remove or convert the listed files and re-run; nothing was uploaded.')
  );
}
