/**
 * Tests for `generate_inputs_manifest` — the atom that replaces the
 * hand-assembled inputs-manifest.yaml step at every /ace:run start.
 *
 * What this verifies:
 *   - shortcuts surface `resolved_target_id` + `resolved_target_mime_type`
 *   - `input_key` is kebab-cased and strips short alphanumeric extensions
 *     (".docx", ".yaml") but NOT trailing words past a dot
 *   - pagination is followed end-to-end (drive.files.list pageToken loop)
 *   - non-shortcut files do NOT get spurious resolved_* fields
 */

import { describe, it, expect, vi } from 'vitest';
import { handleGenerateInputsManifest } from '../../../mcp/google-drive-server.js';

const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

function fakeDrive(pages: any[][]) {
  const list = vi.fn();
  pages.forEach((files, i) => {
    list.mockResolvedValueOnce({
      data: {
        files,
        nextPageToken: i < pages.length - 1 ? `pt-${i + 1}` : undefined,
      },
    });
  });
  return { files: { list } } as any;
}

describe('handleGenerateInputsManifest', () => {
  it('returns a single-page manifest with file_id, name, mime_type, and kebab-cased input_key', async () => {
    const drive = fakeDrive([
      [
        { id: 'f1', name: 'Sample PDD.docx', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-05-24T10:00:00Z' },
        { id: 'f2', name: 'Notes.md', mimeType: 'text/markdown' },
      ],
    ]);
    const r = await handleGenerateInputsManifest({ folderId: 'folder-1' }, drive);
    expect(r.folder_id).toBe('folder-1');
    expect(r.files).toHaveLength(2);
    expect(r.files[0]).toMatchObject({
      file_id: 'f1',
      name: 'Sample PDD.docx',
      mime_type: 'application/vnd.google-apps.document',
      input_key: 'sample-pdd',
      modified_time: '2026-05-24T10:00:00Z',
    });
    expect(r.files[1].input_key).toBe('notes');
    expect(r.files[0].resolved_target_id).toBeUndefined();
  });

  it('resolves shortcut targetId + targetMimeType when MIME is application/vnd.google-apps.shortcut', async () => {
    const drive = fakeDrive([
      [
        {
          id: 'sc-1',
          name: 'PDD draft (shortcut)',
          mimeType: SHORTCUT_MIME,
          shortcutDetails: {
            targetId: 'real-pdd-id',
            targetMimeType: 'application/vnd.google-apps.document',
          },
        },
      ],
    ]);
    const r = await handleGenerateInputsManifest({ folderId: 'folder-1' }, drive);
    expect(r.files[0]).toMatchObject({
      file_id: 'sc-1',
      resolved_target_id: 'real-pdd-id',
      resolved_target_mime_type: 'application/vnd.google-apps.document',
    });
  });

  it('follows pageToken across multiple pages', async () => {
    const drive = fakeDrive([
      [{ id: 'a', name: 'a.txt', mimeType: 'text/plain' }],
      [{ id: 'b', name: 'b.txt', mimeType: 'text/plain' }],
      [{ id: 'c', name: 'c.txt', mimeType: 'text/plain' }],
    ]);
    const r = await handleGenerateInputsManifest({ folderId: 'folder-1' }, drive);
    expect(r.files.map((f) => f.file_id)).toEqual(['a', 'b', 'c']);
    expect(drive.files.list).toHaveBeenCalledTimes(3);
    // Second + third calls carry pageToken
    expect(drive.files.list.mock.calls[1][0].pageToken).toBe('pt-1');
    expect(drive.files.list.mock.calls[2][0].pageToken).toBe('pt-2');
  });

  it("does not treat a long trailing word as an extension (e.g. 'design.notes.markdown')", async () => {
    const drive = fakeDrive([
      [
        { id: '1', name: 'design notes', mimeType: 'application/vnd.google-apps.document' },
        { id: '2', name: 'cohort.design.notes.markdown', mimeType: 'text/markdown' },
      ],
    ]);
    const r = await handleGenerateInputsManifest({ folderId: 'folder-1' }, drive);
    expect(r.files[0].input_key).toBe('design-notes');
    // 'markdown' is 8 chars + alphanumeric → still treated as ext
    expect(r.files[1].input_key).toBe('cohort-design-notes');
  });

  // ace#1648 — Step 5c now MANDATES recording each direct-child subfolder's
  // {folder_id, name} under `subfolders_not_listed:`, because
  // `pdd-to-deliver-app` Step 4k resolves the `[FIXED]` source instrument from
  // the manifest and a vendor bundle is naturally a subfolder. That contract is
  // only satisfiable because this atom returns subfolders alongside files,
  // carrying the Drive folder mime type — Step 5c was dropping them, not the
  // atom. Pinned so a future "the inputs manifest should only list files"
  // cleanup cannot make the workbook unaddressable again.
  it('returns direct-child SUBFOLDERS alongside files, so Step 5c can record their ids (ace#1648)', async () => {
    const FOLDER_MIME = 'application/vnd.google-apps.folder';
    const drive = fakeDrive([
      [
        {
          id: '1yHIe99FfKl-tTaRlgNsweuNfruXE-gJf',
          name: 'INSTRUMENT — Nigeria PPI 2020 (official, extracted verbatim).md',
          mimeType: 'text/markdown',
        },
        {
          id: '1b4f1tXT1YYyROelmt761oUX7XOsAqtut',
          name: 'official-nigeria-ppi-2020 (povertyindex.org)',
          mimeType: FOLDER_MIME,
        },
      ],
    ]);
    const r = await handleGenerateInputsManifest({ folderId: 'folder-1' }, drive);
    const subfolders = r.files.filter((f) => f.mime_type === FOLDER_MIME);
    expect(
      subfolders,
      'A subfolder of inputs/ must stay addressable from the manifest — dropping it is ' +
        'how the [FIXED] instrument workbook became unresolvable and Step 4k silently skipped.',
    ).toHaveLength(1);
    expect(subfolders[0].file_id).toBe('1b4f1tXT1YYyROelmt761oUX7XOsAqtut');
    expect(subfolders[0].name).toBe('official-nigeria-ppi-2020 (povertyindex.org)');
  });

  it('escapes single quotes in folderId for the q clause', async () => {
    const drive = fakeDrive([[]]);
    await handleGenerateInputsManifest({ folderId: "id'with'quotes" }, drive);
    expect(drive.files.list.mock.calls[0][0].q).toContain("'id\\'with\\'quotes' in parents");
  });
});
