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

const OPP_ROOT_WHITELIST = new Set(['opp.yaml', 'inputs', 'runs', 'current']);

/** List opp-root entries (files or folders) that are NOT in the whitelist. */
export async function detectStrayOppRootFiles(
  oppFolderId: string,
  drive: DriveLike,
): Promise<Array<{ id: string; name: string }>> {
  const children = await drive.list(oppFolderId);
  return children
    .filter((c) => !OPP_ROOT_WHITELIST.has(c.name))
    .map((c) => ({ id: c.id, name: c.name }));
}

/** Heuristic: a Drive folder is an "opp folder" if it contains either
 *  an `inputs/` subfolder or an `opp.yaml` entry. Used by the doctor
 *  dispatcher to skip non-opp shared-resource folders at the Drive root.
 */
export async function isOppFolder(folderId: string, drive: DriveLike): Promise<boolean> {
  const children = await drive.list(folderId);
  return children.some(
    (c) => c.name === 'opp.yaml' || (c.name === 'inputs' && c.mimeType === FOLDER_MIME),
  );
}
