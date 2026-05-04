import { describe, it, expect, vi } from 'vitest';
import {
  detectDuplicateFolders,
  detectStrayOppRootFiles,
} from '../../lib/doctor-drive-layout.js';

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

describe('detectStrayOppRootFiles', () => {
  it('flags files at opp root that are not in the whitelist', async () => {
    const drive = {
      list: vi.fn().mockResolvedValue([
        { id: 'a', name: 'opp.yaml', mimeType: DOC },
        { id: 'b', name: 'inputs', mimeType: FOLDER },
        { id: 'c', name: 'runs', mimeType: FOLDER },
        { id: 'd', name: '2026-05-03-connect-opp-setup-attempt-3.md', mimeType: DOC },
      ]),
    };
    expect(await detectStrayOppRootFiles('opp-folder-id', drive as any)).toEqual([
      { id: 'd', name: '2026-05-03-connect-opp-setup-attempt-3.md' },
    ]);
  });

  it('passes when only whitelisted entries exist', async () => {
    const drive = {
      list: vi.fn().mockResolvedValue([
        { id: 'a', name: 'opp.yaml', mimeType: DOC },
        { id: 'b', name: 'inputs', mimeType: FOLDER },
        { id: 'c', name: 'runs', mimeType: FOLDER },
        { id: 'd', name: 'current', mimeType: FOLDER },
      ]),
    };
    expect(await detectStrayOppRootFiles('opp-folder-id', drive as any)).toEqual([]);
  });

  it('flags non-whitelisted folders too (not just files)', async () => {
    const drive = {
      list: vi.fn().mockResolvedValue([
        { id: 'a', name: 'opp.yaml', mimeType: DOC },
        { id: 'b', name: 'commcare-patches', mimeType: FOLDER },  // not in whitelist
      ]),
    };
    const r = await detectStrayOppRootFiles('opp-folder-id', drive as any);
    expect(r.map((x) => x.name)).toContain('commcare-patches');
  });
});
