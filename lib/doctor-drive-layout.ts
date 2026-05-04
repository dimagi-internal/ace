/**
 * Pure-function doctor checks for the ACE Drive layout.
 *
 * Backs the `[Drive layout]` section of `bin/ace-doctor` via the
 * `scripts/doctor-drive-layout.ts` CLI dispatcher. No Drive auth here — the
 * dispatcher injects an authenticated client; this module is unit-testable
 * with `vi.fn()` mocks against the `DriveLike` shape.
 */

export interface DriveEntry {
  id: string;
  name: string;
  mimeType: string;
}

export interface DriveLike {
  list: (folderId: string) => Promise<DriveEntry[]>;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Find folders under `parentFolderId` whose names appear 2+ times. */
export async function detectDuplicateFolders(
  parentFolderId: string,
  drive: DriveLike,
): Promise<Array<{ name: string; ids: string[] }>> {
  const children = await drive.list(parentFolderId);
  const folders = children.filter((c) => c.mimeType === FOLDER_MIME);
  const byName = new Map<string, string[]>();
  for (const f of folders) {
    if (!byName.has(f.name)) byName.set(f.name, []);
    byName.get(f.name)!.push(f.id);
  }
  return [...byName.entries()]
    .filter(([_, ids]) => ids.length > 1)
    .map(([name, ids]) => ({ name, ids }));
}
