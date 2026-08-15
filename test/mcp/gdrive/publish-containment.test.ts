/**
 * ace#1112 / ace#1110 F2 — `drive_set_anyone_with_link` turned any SA-reachable
 * file into a public URL. The credential denylist that shipped stops a secret
 * being uploaded and published; nothing stopped an already-present file being
 * published.
 *
 * Unlike the read-side allowed-roots question (#1110, still open, needs a live
 * Phase 3/6/7 run to enumerate), this one needs no enumeration: every file the
 * atom is legitimately called on lives under ACE_DRIVE_ROOT_FOLDER_ID.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handleSetAnyoneWithLink,
  __resetAceDriveIdCacheForTests,
} from '../../../mcp/google-drive-server.js';

const ACE_DRIVE = '0AIUhETtpTlpcUk9PVA'; // measured on the ACE Shared Drive, 2026-08-14
const ROOT = '1HThsA_0Lr5p1OdI5r-aQ446HlNBaySLz';

const fakeDrive = { files: { get: vi.fn() }, permissions: { create: vi.fn() } };
let savedRoot: string | undefined;

beforeEach(() => {
  __resetAceDriveIdCacheForTests();
  fakeDrive.files.get.mockReset();
  fakeDrive.permissions.create.mockReset();
  fakeDrive.permissions.create.mockResolvedValue({ data: { id: 'perm-1' } });
  savedRoot = process.env.ACE_DRIVE_ROOT_FOLDER_ID;
  process.env.ACE_DRIVE_ROOT_FOLDER_ID = ROOT;
});
afterEach(() => {
  if (savedRoot === undefined) delete process.env.ACE_DRIVE_ROOT_FOLDER_ID;
  else process.env.ACE_DRIVE_ROOT_FOLDER_ID = savedRoot;
});

/** files.get answers per fileId. */
const respond = (map: Record<string, { driveId?: string; name?: string }>) => {
  fakeDrive.files.get.mockImplementation(async ({ fileId }: { fileId: string }) => ({
    data: { id: fileId, name: map[fileId]?.name ?? 'f', driveId: map[fileId]?.driveId },
  }));
};

describe('publishes an ACE artifact', () => {
  it('allows a file on ACE’s own Shared Drive', async () => {
    respond({ 'doc-1': { driveId: ACE_DRIVE }, [ROOT]: { driveId: ACE_DRIVE } });
    const r = await handleSetAnyoneWithLink({ fileId: 'doc-1', role: 'commenter' }, fakeDrive as never);
    expect(r.role).toBe('commenter');
    expect(fakeDrive.permissions.create).toHaveBeenCalled();
  });
});

describe('refuses everything else', () => {
  it('a My Drive file — not an ACE artifact', async () => {
    respond({ 'my-drive-file': { name: 'gws-sa-key.json' }, [ROOT]: { driveId: ACE_DRIVE } });
    await expect(
      handleSetAnyoneWithLink({ fileId: 'my-drive-file' }, fakeDrive as never),
    ).rejects.toThrow(/not on a Shared Drive/);
    expect(fakeDrive.permissions.create).not.toHaveBeenCalled();
  });

  it('a file on a DIFFERENT Shared Drive — "shared" is not the property that matters', async () => {
    respond({ 'other-doc': { driveId: 'someone-elses-drive' }, [ROOT]: { driveId: ACE_DRIVE } });
    await expect(
      handleSetAnyoneWithLink({ fileId: 'other-doc' }, fakeDrive as never),
    ).rejects.toThrow(/not ACE's/);
    expect(fakeDrive.permissions.create).not.toHaveBeenCalled();
  });

  it('names the file, so the refusal is actionable', async () => {
    respond({ 'x': { name: 'someone-elses-notes' }, [ROOT]: { driveId: ACE_DRIVE } });
    await expect(handleSetAnyoneWithLink({ fileId: 'x' }, fakeDrive as never))
      .rejects.toThrow(/someone-elses-notes/);
  });
});

describe('degrades rather than bricking when the root is unconfigured', () => {
  it('still allows a Shared-Drive file', async () => {
    // A misconfigured install that cannot publish at all is a worse failure
    // than a slightly wider rail.
    delete process.env.ACE_DRIVE_ROOT_FOLDER_ID;
    respond({ 'doc-1': { driveId: 'any-shared-drive' } });
    await expect(
      handleSetAnyoneWithLink({ fileId: 'doc-1' }, fakeDrive as never),
    ).resolves.toBeTruthy();
  });

  it('but still refuses a My Drive file', async () => {
    delete process.env.ACE_DRIVE_ROOT_FOLDER_ID;
    respond({ 'doc-1': {} });
    await expect(
      handleSetAnyoneWithLink({ fileId: 'doc-1' }, fakeDrive as never),
    ).rejects.toThrow(/not on a Shared Drive/);
  });

  it('degrades the same way when the root folder is unreachable', async () => {
    fakeDrive.files.get.mockImplementation(async ({ fileId }: { fileId: string }) => {
      if (fileId === ROOT) throw new Error('404');
      return { data: { id: fileId, driveId: 'any-shared-drive' } };
    });
    await expect(
      handleSetAnyoneWithLink({ fileId: 'doc-1' }, fakeDrive as never),
    ).resolves.toBeTruthy();
  });
});

describe('the drive id is resolved once per session', () => {
  it('does not re-probe the root on every publish', async () => {
    respond({ a: { driveId: ACE_DRIVE }, b: { driveId: ACE_DRIVE }, [ROOT]: { driveId: ACE_DRIVE } });
    await handleSetAnyoneWithLink({ fileId: 'a' }, fakeDrive as never);
    await handleSetAnyoneWithLink({ fileId: 'b' }, fakeDrive as never);
    const rootProbes = fakeDrive.files.get.mock.calls.filter(([a]) => a.fileId === ROOT);
    expect(rootProbes).toHaveLength(1);
  });
});
