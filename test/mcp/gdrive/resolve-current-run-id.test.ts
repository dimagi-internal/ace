/**
 * Tests for `resolve_current_run_id` — replaces the dead
 * `opp.yaml.last_run_id` read pattern that three Phase 7 synthetic
 * skills were still using. Lists `<opp>/runs/` and picks the
 * lexicographically-largest folder name (run-ids are `YYYYMMDD-HHMM`,
 * so lex order matches chronological).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleResolveCurrentRunId } from '../../../mcp/google-drive-server.js';

function fakeDrive(opts: {
  oppFolders?: any[];
  subFolders?: any[];
  runs?: any[];
}) {
  const list = vi.fn();
  // resolve_opp_path: oppFolders, then subFolders (inputs+runs)
  list.mockResolvedValueOnce({ data: { files: opts.oppFolders ?? [] } });
  list.mockResolvedValueOnce({ data: { files: opts.subFolders ?? [] } });
  // resolve_current_run_id: runs listing (only fires when runs/ exists)
  if (opts.runs !== undefined) {
    list.mockResolvedValueOnce({ data: { files: opts.runs } });
  }
  return { files: { list } } as any;
}

describe('handleResolveCurrentRunId', () => {
  beforeEach(() => {
    delete process.env.ACE_DRIVE_ROOT_FOLDER_ID;
  });

  it('returns the lexicographically-largest run folder name + id', async () => {
    const drive = fakeDrive({
      oppFolders: [{ id: 'opp-1', name: 'bednet-spot-check' }],
      subFolders: [
        { id: 'inputs-1', name: 'inputs' },
        { id: 'runs-1', name: 'runs' },
      ],
      runs: [
        { id: 'r1', name: '20260524-2354' },
        { id: 'r3', name: '20260526-1334' },
        { id: 'r2', name: '20260525-2013' },
      ],
    });
    const r = await handleResolveCurrentRunId(
      { slug: 'bednet-spot-check', aceRootFolderId: 'ace-root' },
      drive,
    );
    expect(r).toEqual({
      slug: 'bednet-spot-check',
      run_id: '20260526-1334',
      run_folder_id: 'r3',
    });
  });

  it('returns nulls when the opp has no runs yet', async () => {
    const drive = fakeDrive({
      oppFolders: [{ id: 'opp-1', name: 'fresh-opp' }],
      subFolders: [
        { id: 'inputs-1', name: 'inputs' },
        { id: 'runs-1', name: 'runs' },
      ],
      runs: [],
    });
    const r = await handleResolveCurrentRunId(
      { slug: 'fresh-opp', aceRootFolderId: 'ace-root' },
      drive,
    );
    expect(r).toEqual({
      slug: 'fresh-opp',
      run_id: null,
      run_folder_id: null,
    });
  });

  it("returns nulls when the runs/ subfolder doesn't exist yet (first-run opp)", async () => {
    const drive = fakeDrive({
      oppFolders: [{ id: 'opp-1', name: 'never-run' }],
      subFolders: [{ id: 'inputs-1', name: 'inputs' }],
      // no runs entry — resolve_opp_path returns runs_id=null, so the
      // runs listing call should never fire.
    });
    const r = await handleResolveCurrentRunId(
      { slug: 'never-run', aceRootFolderId: 'ace-root' },
      drive,
    );
    expect(r).toEqual({
      slug: 'never-run',
      run_id: null,
      run_folder_id: null,
    });
    // 2 calls only: opp lookup + subfolder lookup. No runs listing.
    expect(drive.files.list).toHaveBeenCalledTimes(2);
  });

  it('propagates "opp not found" from resolve_opp_path', async () => {
    const drive = fakeDrive({ oppFolders: [] });
    await expect(
      handleResolveCurrentRunId(
        { slug: 'missing', aceRootFolderId: 'ace-root' },
        drive,
      ),
    ).rejects.toThrow(/Opp folder "missing" not found/);
  });

  it('falls back to $ACE_DRIVE_ROOT_FOLDER_ID when no aceRootFolderId is passed', async () => {
    process.env.ACE_DRIVE_ROOT_FOLDER_ID = 'env-root';
    const drive = fakeDrive({
      oppFolders: [{ id: 'opp-1', name: 'x' }],
      subFolders: [{ id: 'runs-1', name: 'runs' }],
      runs: [{ id: 'r1', name: '20260101-1200' }],
    });
    const r = await handleResolveCurrentRunId({ slug: 'x' }, drive);
    expect(r.run_id).toBe('20260101-1200');
  });
});
