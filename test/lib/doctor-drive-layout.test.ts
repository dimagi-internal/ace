import { describe, it, expect, vi } from 'vitest';
import {
  detectDuplicateFolders,
  detectStrayOppRootFiles,
  isOppFolder,
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

describe('isOppFolder', () => {
  it('returns true when folder contains opp.yaml', async () => {
    const drive = {
      list: vi.fn().mockResolvedValue([
        { id: 'a', name: 'opp.yaml', mimeType: DOC },
        { id: 'b', name: 'inputs', mimeType: FOLDER },
      ]),
    };
    expect(await isOppFolder('opp', drive as any)).toBe(true);
  });

  it('returns true when folder contains an inputs/ subfolder (no opp.yaml yet)', async () => {
    const drive = {
      list: vi.fn().mockResolvedValue([
        { id: 'b', name: 'inputs', mimeType: FOLDER },
      ]),
    };
    expect(await isOppFolder('opp', drive as any)).toBe(true);
  });

  it('returns false when folder has neither marker (e.g. PDD shared folder)', async () => {
    const drive = {
      list: vi.fn().mockResolvedValue([
        { id: 'a', name: 'pdd-vaccine.gdoc', mimeType: DOC },
        { id: 'b', name: 'pdd-turmeric.gdoc', mimeType: DOC },
      ]),
    };
    expect(await isOppFolder('shared', drive as any)).toBe(false);
  });

  it('treats a file named "inputs" (not folder) as non-marker', async () => {
    const drive = {
      list: vi.fn().mockResolvedValue([
        { id: 'b', name: 'inputs', mimeType: DOC },  // doc, not folder
      ]),
    };
    expect(await isOppFolder('opp', drive as any)).toBe(false);
  });
});
