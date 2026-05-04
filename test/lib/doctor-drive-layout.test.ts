import { describe, it, expect, vi } from 'vitest';
import { detectDuplicateFolders } from '../../lib/doctor-drive-layout.js';

const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';

describe('detectDuplicateFolders', () => {
  it('flags two folders with the same name under one parent', async () => {
    const drive = {
      list: vi.fn().mockResolvedValue([
        { id: 'a', name: 'verdicts', mimeType: FOLDER },
        { id: 'b', name: 'verdicts', mimeType: FOLDER },
        { id: 'c', name: 'gate-briefs', mimeType: FOLDER },
      ]),
    };
    expect(await detectDuplicateFolders('run-folder-id', drive as any)).toEqual([
      { name: 'verdicts', ids: ['a', 'b'] },
    ]);
  });

  it('returns empty when all folder names are unique', async () => {
    const drive = {
      list: vi.fn().mockResolvedValue([
        { id: 'a', name: 'verdicts', mimeType: FOLDER },
        { id: 'b', name: 'gate-briefs', mimeType: FOLDER },
      ]),
    };
    expect(await detectDuplicateFolders('run-folder-id', drive as any)).toEqual([]);
  });

  it('ignores non-folder children (only flags duplicate FOLDER names)', async () => {
    const drive = {
      list: vi.fn().mockResolvedValue([
        { id: 'a', name: 'verdicts', mimeType: FOLDER },
        { id: 'b', name: 'verdicts', mimeType: DOC },  // a doc named 'verdicts' is not a dup folder
      ]),
    };
    expect(await detectDuplicateFolders('run-folder-id', drive as any)).toEqual([]);
  });
});
