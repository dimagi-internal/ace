/**
 * Tests for `resolve_opp_path` — the atom that collapses the 3-call dance
 * (list ACE root → find opp by name → list opp root → find inputs/ + runs/)
 * into one call.
 *
 * What this verifies:
 *   - happy path returns all three folder IDs from two files.list calls
 *   - runs_id is null when the runs/ subfolder doesn't exist yet
 *     (first-run opp)
 *   - missing opp raises a typed error
 *   - ambiguous slug (multiple folders with the same name) raises a
 *     typed error
 *   - falls back to $ACE_DRIVE_ROOT_FOLDER_ID when aceRootFolderId is omitted
 *   - escapes single quotes in slug + root id for the q clause
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleResolveOppPath } from '../../../mcp/google-drive-server.js';

function fakeDrive(opts: {
  oppFolders?: any[];
  subFolders?: any[];
}) {
  const list = vi
    .fn()
    .mockResolvedValueOnce({ data: { files: opts.oppFolders ?? [] } })
    .mockResolvedValueOnce({ data: { files: opts.subFolders ?? [] } });
  return { files: { list } } as any;
}

describe('handleResolveOppPath', () => {
  beforeEach(() => {
    delete process.env.ACE_DRIVE_ROOT_FOLDER_ID;
  });

  it('returns opp_root_id, inputs_id, runs_id in 2 files.list calls', async () => {
    const drive = fakeDrive({
      oppFolders: [{ id: 'opp-1', name: 'turmeric-survey' }],
      subFolders: [
        { id: 'inputs-1', name: 'inputs' },
        { id: 'runs-1', name: 'runs' },
      ],
    });
    const r = await handleResolveOppPath(
      { slug: 'turmeric-survey', aceRootFolderId: 'ace-root' },
      drive,
    );
    expect(r).toEqual({
      slug: 'turmeric-survey',
      ace_root_id: 'ace-root',
      opp_root_id: 'opp-1',
      inputs_id: 'inputs-1',
      runs_id: 'runs-1',
    });
    expect(drive.files.list).toHaveBeenCalledTimes(2);
  });

  it('returns runs_id=null when the runs/ subfolder does not exist yet (first-run opp)', async () => {
    const drive = fakeDrive({
      oppFolders: [{ id: 'opp-1', name: 'turmeric-survey' }],
      subFolders: [{ id: 'inputs-1', name: 'inputs' }],
    });
    const r = await handleResolveOppPath(
      { slug: 'turmeric-survey', aceRootFolderId: 'ace-root' },
      drive,
    );
    expect(r.inputs_id).toBe('inputs-1');
    expect(r.runs_id).toBeNull();
  });

  it('throws when the opp folder is not found under ACE root', async () => {
    const drive = fakeDrive({ oppFolders: [], subFolders: [] });
    await expect(
      handleResolveOppPath(
        { slug: 'missing-opp', aceRootFolderId: 'ace-root' },
        drive,
      ),
    ).rejects.toThrow(/Opp folder "missing-opp" not found/);
  });

  it('throws when multiple folders share the same slug (ambiguous)', async () => {
    const drive = fakeDrive({
      oppFolders: [
        { id: 'opp-a', name: 'duplicate' },
        { id: 'opp-b', name: 'duplicate' },
      ],
    });
    await expect(
      handleResolveOppPath(
        { slug: 'duplicate', aceRootFolderId: 'ace-root' },
        drive,
      ),
    ).rejects.toThrow(/Multiple folders named "duplicate"/);
  });

  it('falls back to $ACE_DRIVE_ROOT_FOLDER_ID when no aceRootFolderId is passed', async () => {
    process.env.ACE_DRIVE_ROOT_FOLDER_ID = 'env-root';
    const drive = fakeDrive({
      oppFolders: [{ id: 'opp-1', name: 'x' }],
      subFolders: [],
    });
    const r = await handleResolveOppPath({ slug: 'x' }, drive);
    expect(r.ace_root_id).toBe('env-root');
  });

  it("throws when $ACE_DRIVE_ROOT_FOLDER_ID is unset and no override is passed", async () => {
    const drive = fakeDrive({});
    await expect(handleResolveOppPath({ slug: 'x' }, drive)).rejects.toThrow(
      /ACE_DRIVE_ROOT_FOLDER_ID is not set/,
    );
  });

  it("escapes single quotes in slug and root id for the q clause", async () => {
    const drive = fakeDrive({
      oppFolders: [{ id: 'opp-1', name: "it's-a-slug" }],
      subFolders: [],
    });
    await handleResolveOppPath(
      { slug: "it's-a-slug", aceRootFolderId: "root'with'quotes" },
      drive,
    );
    expect(drive.files.list.mock.calls[0][0].q).toContain("'root\\'with\\'quotes'");
    expect(drive.files.list.mock.calls[0][0].q).toContain("'it\\'s-a-slug'");
  });
});
