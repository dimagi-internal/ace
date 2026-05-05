/**
 * Tests for `scripts/migrate-drive-layout.ts` — the planner half of the
 * Drive layout migration tool (Tasks 9-10 of the run-folder-readability
 * plan). Covers the pure `planMoves` function with `vi.fn()`-mocked
 * `DriveLike` shape; no live Drive calls.
 */

import { describe, it, expect, vi } from 'vitest';
import { planMoves, executeMoves, type PlannedMove } from '../../scripts/migrate-drive-layout.js';

const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';
const YAML = 'application/x-yaml';
const PNG = 'image/png';

/**
 * Build a vi.fn-backed DriveLike that returns a static `Map<folderId, entries>`
 * for `list(folderId)`. Pass an entry-table keyed by folder ID.
 */
function fakeDrive(entries: Record<string, Array<{ id: string; name: string; mimeType: string }>>) {
  return {
    list: vi.fn(async (folderId: string) => entries[folderId] ?? []),
  };
}

/**
 * Build the standard opp shape used in most tests:
 *   opp/ → runs/ → run-1/ → <runEntries>
 * Pass the entries you want under run-1/, plus an optional sub-folder map.
 */
function oppWithRunEntries(
  runEntries: Array<{ id: string; name: string; mimeType: string }>,
  extraSubFolders: Record<string, Array<{ id: string; name: string; mimeType: string }>> = {},
) {
  return fakeDrive({
    'opp-id': [{ id: 'runs-id', name: 'runs', mimeType: FOLDER }],
    'runs-id': [{ id: 'run-1-id', name: 'run-1', mimeType: FOLDER }],
    'run-1-id': runEntries,
    ...extraSubFolders,
  });
}

describe('planMoves', () => {
  it('maps a single old leaf path to its new path', async () => {
    const drive = oppWithRunEntries([
      { id: 'pdd-id', name: 'pdd.md', mimeType: DOC },
    ]);
    const moves = await planMoves('opp-id', drive as any);
    const fileMoves = moves.filter((m) => m.action === 'move');
    expect(fileMoves).toEqual([
      {
        fileId: 'pdd-id',
        from: 'pdd.md',
        to: '1-design/idea-to-pdd.md',
        action: 'move',
        runFolderId: 'run-1-id',
      },
    ]);
  });

  it('skips opp-level identity entries (no move emitted for run_state.yaml)', async () => {
    const drive = oppWithRunEntries([
      { id: 'state-id', name: 'run_state.yaml', mimeType: YAML },
    ]);
    const moves = await planMoves('opp-id', drive as any);
    expect(moves.filter((m) => m.action === 'move')).toEqual([]);
  });

  it('emits coalesce-folder for duplicate sibling folder names under a run', async () => {
    const drive = fakeDrive({
      'opp-id': [{ id: 'runs-id', name: 'runs', mimeType: FOLDER }],
      'runs-id': [{ id: 'run-1-id', name: 'run-1', mimeType: FOLDER }],
      'run-1-id': [
        { id: 'verdicts-a', name: 'verdicts', mimeType: FOLDER },
        { id: 'verdicts-b', name: 'verdicts', mimeType: FOLDER },
      ],
      'verdicts-a': [],
      'verdicts-b': [],
    });
    const moves = await planMoves('opp-id', drive as any);
    const coalesces = moves.filter((m) => m.action === 'coalesce-folder');
    expect(coalesces).toHaveLength(1);
    expect(coalesces[0]).toMatchObject({
      action: 'coalesce-folder',
      from: 'verdicts/',
      to: 'verdicts/',
      runFolderId: 'run-1-id',
    });
  });

  it('recursively walks nested folders (gate-briefs/idea-to-pdd.md)', async () => {
    const drive = fakeDrive({
      'opp-id': [{ id: 'runs-id', name: 'runs', mimeType: FOLDER }],
      'runs-id': [{ id: 'run-1-id', name: 'run-1', mimeType: FOLDER }],
      'run-1-id': [
        { id: 'gb-id', name: 'gate-briefs', mimeType: FOLDER },
      ],
      'gb-id': [
        { id: 'gb-itp-id', name: 'idea-to-pdd.md', mimeType: DOC },
      ],
    });
    const moves = await planMoves('opp-id', drive as any);
    expect(moves).toContainEqual({
      fileId: 'gb-itp-id',
      from: 'gate-briefs/idea-to-pdd.md',
      to: '1-design/idea-to-pdd_gate-brief.md',
      action: 'move',
      runFolderId: 'run-1-id',
    });
  });

  it('renames 0.12.0 6-llo-manager/ leaves to 7-execution-manager/ in 0.13.0', async () => {
    const drive = fakeDrive({
      'opp-id': [{ id: 'runs-id', name: 'runs', mimeType: FOLDER }],
      'runs-id': [{ id: 'run-1-id', name: 'run-1', mimeType: FOLDER }],
      'run-1-id': [
        { id: 'lm-id', name: '6-llo-manager', mimeType: FOLDER },
      ],
      'lm-id': [
        { id: 'rec-id', name: 'llo-launch_record.md', mimeType: DOC },
      ],
    });
    const moves = await planMoves('opp-id', drive as any);
    expect(moves).toContainEqual({
      fileId: 'rec-id',
      from: '6-llo-manager/llo-launch_record.md',
      to: '7-execution-manager/llo-launch_record.md',
      action: 'move',
      runFolderId: 'run-1-id',
    });
  });

  it('handles dated qa-captures (2026-05-04-ocs-chat-deep.md)', async () => {
    const drive = fakeDrive({
      'opp-id': [{ id: 'runs-id', name: 'runs', mimeType: FOLDER }],
      'runs-id': [{ id: 'run-1-id', name: 'run-1', mimeType: FOLDER }],
      'run-1-id': [
        { id: 'qc-id', name: 'qa-captures', mimeType: FOLDER },
      ],
      'qc-id': [
        { id: 'cap-id', name: '2026-05-04-ocs-chat-deep.md', mimeType: DOC },
      ],
    });
    const moves = await planMoves('opp-id', drive as any);
    expect(moves).toContainEqual({
      fileId: 'cap-id',
      from: 'qa-captures/2026-05-04-ocs-chat-deep.md',
      to: '4-ocs/ocs-chatbot-qa_transcript-deep.md',
      action: 'move',
      runFolderId: 'run-1-id',
    });
  });

  it('handles screenshots/ binary files (preserves nested path under 5-qa-and-training/screenshots/)', async () => {
    const drive = fakeDrive({
      'opp-id': [{ id: 'runs-id', name: 'runs', mimeType: FOLDER }],
      'runs-id': [{ id: 'run-1-id', name: 'run-1', mimeType: FOLDER }],
      'run-1-id': [
        { id: 'ss-id', name: 'screenshots', mimeType: FOLDER },
      ],
      'ss-id': [
        { id: 'learn-id', name: 'learn', mimeType: FOLDER },
      ],
      'learn-id': [
        { id: 'png-id', name: '01-welcome.png', mimeType: PNG },
      ],
    });
    const moves = await planMoves('opp-id', drive as any);
    expect(moves).toContainEqual({
      fileId: 'png-id',
      from: 'screenshots/learn/01-welcome.png',
      to: '5-qa-and-training/screenshots/learn/01-welcome.png',
      action: 'move',
      runFolderId: 'run-1-id',
    });
  });

  it('walks runs/<run-id>/ subfolders and populates runFolderId per-run', async () => {
    const drive = fakeDrive({
      'opp-id': [{ id: 'runs-id', name: 'runs', mimeType: FOLDER }],
      'runs-id': [
        { id: 'run-A-id', name: 'run-A', mimeType: FOLDER },
        { id: 'run-B-id', name: 'run-B', mimeType: FOLDER },
      ],
      'run-A-id': [
        { id: 'pdd-A-id', name: 'pdd.md', mimeType: DOC },
      ],
      'run-B-id': [
        { id: 'pdd-B-id', name: 'pdd.md', mimeType: DOC },
      ],
    });
    const moves = await planMoves('opp-id', drive as any);
    const fileMoves = moves.filter((m) => m.action === 'move');
    expect(fileMoves).toHaveLength(2);
    const a = fileMoves.find((m) => m.fileId === 'pdd-A-id');
    const b = fileMoves.find((m) => m.fileId === 'pdd-B-id');
    expect(a?.runFolderId).toBe('run-A-id');
    expect(b?.runFolderId).toBe('run-B-id');
    expect(a?.to).toBe('1-design/idea-to-pdd.md');
    expect(b?.to).toBe('1-design/idea-to-pdd.md');
  });
});

// ── executeMoves ─────────────────────────────────────────────────
//
// executeMoves talks to a googleapis-style `Drive` client, not the simpler
// DriveLike used by planMoves. Mock `files.list / files.create / files.update
// / files.delete / files.get`.

function makeFakeGoogleDrive() {
  return {
    files: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
    },
  };
}

describe('executeMoves', () => {
  it('single move: ensures phase folder exists, then files.update with addParents/removeParents', async () => {
    const d = makeFakeGoogleDrive();
    // No existing 1-design/ folder under run-1-id
    d.files.list.mockResolvedValueOnce({ data: { files: [] } });
    // Folder create returns its id
    d.files.create.mockResolvedValueOnce({
      data: { id: 'phase-1-id', name: '1-design' },
    });
    // The file move: get the current parents, then update
    d.files.get.mockResolvedValueOnce({
      data: { parents: ['run-1-id'] },
    });
    d.files.update.mockResolvedValueOnce({
      data: { id: 'pdd-id', name: 'idea-to-pdd.md' },
    });

    const moves: PlannedMove[] = [{
      fileId: 'pdd-id',
      from: 'pdd.md',
      to: '1-design/idea-to-pdd.md',
      action: 'move',
      runFolderId: 'run-1-id',
    }];

    const result = await executeMoves('opp-id', moves, d as any);

    expect(d.files.create).toHaveBeenCalledOnce();
    const folderCreateArgs = d.files.create.mock.calls[0]![0];
    expect(folderCreateArgs.requestBody.name).toBe('1-design');
    expect(folderCreateArgs.requestBody.parents).toEqual(['run-1-id']);
    expect(folderCreateArgs.requestBody.mimeType).toBe('application/vnd.google-apps.folder');

    // Then update the file: addParents=phase-1-id, removeParents=run-1-id, name=new leaf
    expect(d.files.update).toHaveBeenCalledOnce();
    const updateArgs = d.files.update.mock.calls[0]![0];
    expect(updateArgs.fileId).toBe('pdd-id');
    expect(updateArgs.addParents).toBe('phase-1-id');
    expect(updateArgs.removeParents).toBe('run-1-id');
    expect(updateArgs.requestBody.name).toBe('idea-to-pdd.md');

    expect(result.executed).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('move into a new phase folder: files.create folder first, then files.update for the file', async () => {
    const d = makeFakeGoogleDrive();
    d.files.list.mockResolvedValueOnce({ data: { files: [] } });
    d.files.create.mockResolvedValueOnce({
      data: { id: 'phase-2-id', name: '2-commcare' },
    });
    d.files.get.mockResolvedValueOnce({ data: { parents: ['run-1-id'] } });
    d.files.update.mockResolvedValueOnce({
      data: { id: 'app-summary-id', name: 'pdd-to-learn-app_summary.md' },
    });

    const moves: PlannedMove[] = [{
      fileId: 'app-summary-id',
      from: 'app-summaries/learn-app-summary.md',
      to: '2-commcare/pdd-to-learn-app_summary.md',
      action: 'move',
      runFolderId: 'run-1-id',
    }];

    await executeMoves('opp-id', moves, d as any);

    // create-then-update ordering
    const createCallOrder = d.files.create.mock.invocationCallOrder[0]!;
    const updateCallOrder = d.files.update.mock.invocationCallOrder[0]!;
    expect(createCallOrder).toBeLessThan(updateCallOrder);
  });

  it('coalesce-folder: moves children of dup into canonical, then deletes the dup', async () => {
    const d = makeFakeGoogleDrive();
    // Coalesce action: list both same-name siblings via list-of-siblings query
    // Two `verdicts/` siblings: verdicts-a (canonical, lex-min) and verdicts-b (dup)
    d.files.list
      // First list: find both `verdicts` folders under runFolderId to determine canonical
      .mockResolvedValueOnce({
        data: {
          files: [
            { id: 'verdicts-b', name: 'verdicts', mimeType: 'application/vnd.google-apps.folder' },
            { id: 'verdicts-a', name: 'verdicts', mimeType: 'application/vnd.google-apps.folder' },
          ],
        },
      })
      // Then list children of dup (verdicts-b)
      .mockResolvedValueOnce({
        data: {
          files: [
            { id: 'child-1-id', name: 'foo.yaml', mimeType: 'application/x-yaml' },
          ],
        },
      });

    // Move child: get its parents, then update
    d.files.get.mockResolvedValueOnce({ data: { parents: ['verdicts-b'] } });
    d.files.update.mockResolvedValueOnce({
      data: { id: 'child-1-id', name: 'foo.yaml' },
    });
    // Delete the dup
    d.files.delete.mockResolvedValueOnce({ data: {} });

    const moves: PlannedMove[] = [{
      fileId: 'verdicts-b',
      from: 'verdicts/',
      to: 'verdicts/',
      action: 'coalesce-folder',
      runFolderId: 'run-1-id',
    }];

    await executeMoves('opp-id', moves, d as any);

    // Child moved: addParents=verdicts-a (canonical), removeParents=verdicts-b
    const updateArgs = d.files.update.mock.calls[0]![0];
    expect(updateArgs.fileId).toBe('child-1-id');
    expect(updateArgs.addParents).toBe('verdicts-a');
    expect(updateArgs.removeParents).toBe('verdicts-b');

    // Dup deleted last
    expect(d.files.delete).toHaveBeenCalledWith({
      fileId: 'verdicts-b',
      supportsAllDrives: true,
    });
  });

  it('folder cache: two moves into the same phase folder only call files.create once', async () => {
    const d = makeFakeGoogleDrive();
    // First lookup of 2-commcare/ — empty
    d.files.list.mockResolvedValueOnce({ data: { files: [] } });
    // Folder create: returns id once
    d.files.create.mockResolvedValueOnce({
      data: { id: 'phase-2-id', name: '2-commcare' },
    });
    // Two file gets + two file updates
    d.files.get
      .mockResolvedValueOnce({ data: { parents: ['run-1-id'] } })
      .mockResolvedValueOnce({ data: { parents: ['run-1-id'] } });
    d.files.update
      .mockResolvedValueOnce({ data: { id: 'a-id', name: 'a.md' } })
      .mockResolvedValueOnce({ data: { id: 'b-id', name: 'b.md' } });

    const moves: PlannedMove[] = [
      {
        fileId: 'a-id',
        from: 'app-summaries/learn-app-summary.md',
        to: '2-commcare/pdd-to-learn-app_summary.md',
        action: 'move',
        runFolderId: 'run-1-id',
      },
      {
        fileId: 'b-id',
        from: 'app-summaries/deliver-app-summary.md',
        to: '2-commcare/pdd-to-deliver-app_summary.md',
        action: 'move',
        runFolderId: 'run-1-id',
      },
    ];

    await executeMoves('opp-id', moves, d as any);

    // Cache hit: files.create only called once for the folder
    expect(d.files.create).toHaveBeenCalledOnce();
    expect(d.files.update).toHaveBeenCalledTimes(2);
  });
});

// ── Task 12: planner emissions for create-shortcut + delete-empty ──

describe('planMoves: create-shortcut emissions', () => {
  it('emits one create-shortcut per CURRENT_TARGETS pointing at the lex-largest run', async () => {
    const drive = fakeDrive({
      'opp-id': [{ id: 'runs-id', name: 'runs', mimeType: FOLDER }],
      'runs-id': [
        { id: 'run-A-id', name: '20260501-1000', mimeType: FOLDER },
        { id: 'run-B-id', name: '20260503-1234', mimeType: FOLDER }, // latest by lex
      ],
      'run-A-id': [],
      'run-B-id': [],
    });
    const moves = await planMoves('opp-id', drive as any);
    const shortcuts = moves.filter((m) => m.action === 'create-shortcut');
    // Three CURRENT_TARGETS expected per the plan.
    expect(shortcuts).toHaveLength(3);
    // All point at the latest run (run-B-id).
    for (const s of shortcuts) {
      expect(s.runFolderId).toBe('run-B-id');
      expect(s.fileId).toBe('run-B-id');
    }
    // Spot-check the names + targets we expect.
    const byName = new Map(shortcuts.map((s) => [s.from, s.to]));
    expect(byName.get('connect-opp-summary.md')).toBe('3-connect/connect-opp-setup.md');
    expect(byName.get('connect-program-summary.md')).toBe('3-connect/connect-program-setup.md');
    expect(byName.get('ocs-agent-config.md')).toBe('4-ocs/ocs-agent-setup.md');
  });

  it('emits no create-shortcut actions when no runs exist', async () => {
    const drive = fakeDrive({
      'opp-id': [{ id: 'runs-id', name: 'runs', mimeType: FOLDER }],
      'runs-id': [],
    });
    const moves = await planMoves('opp-id', drive as any);
    expect(moves.filter((m) => m.action === 'create-shortcut')).toHaveLength(0);
  });
});

describe('planMoves: delete-empty emissions', () => {
  it('emits delete-empty for known legacy folders that will have no children after moves', async () => {
    // verdicts/ contains a single file that will move out → folder becomes empty.
    const drive = fakeDrive({
      'opp-id': [{ id: 'runs-id', name: 'runs', mimeType: FOLDER }],
      'runs-id': [{ id: 'run-1-id', name: 'run-1', mimeType: FOLDER }],
      'run-1-id': [
        { id: 'verdicts-id', name: 'verdicts', mimeType: FOLDER },
      ],
      'verdicts-id': [
        { id: 'v-itp-id', name: 'idea-to-pdd.yaml', mimeType: YAML },
      ],
    });
    const moves = await planMoves('opp-id', drive as any);
    const deletes = moves.filter((m) => m.action === 'delete-empty');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({
      action: 'delete-empty',
      fileId: 'verdicts-id',
      from: 'verdicts/',
      runFolderId: 'run-1-id',
    });
  });

  it('does NOT emit delete-empty for unknown folder names', async () => {
    // `random-junk/` is not in the legacy list.
    const drive = fakeDrive({
      'opp-id': [{ id: 'runs-id', name: 'runs', mimeType: FOLDER }],
      'runs-id': [{ id: 'run-1-id', name: 'run-1', mimeType: FOLDER }],
      'run-1-id': [
        { id: 'rj-id', name: 'random-junk', mimeType: FOLDER },
      ],
      'rj-id': [],
    });
    const moves = await planMoves('opp-id', drive as any);
    expect(moves.filter((m) => m.action === 'delete-empty')).toHaveLength(0);
  });

  it('does NOT emit delete-empty when the legacy folder has children remaining after moves', async () => {
    // `verdicts/` has an unmapped file that won't move (no migration target).
    // The folder is still non-empty after the planned moves, so we should not delete.
    const drive = fakeDrive({
      'opp-id': [{ id: 'runs-id', name: 'runs', mimeType: FOLDER }],
      'runs-id': [{ id: 'run-1-id', name: 'run-1', mimeType: FOLDER }],
      'run-1-id': [
        { id: 'verdicts-id', name: 'verdicts', mimeType: FOLDER },
      ],
      'verdicts-id': [
        { id: 'orphan-id', name: 'mystery-verdict.yaml', mimeType: YAML },
      ],
    });
    const moves = await planMoves('opp-id', drive as any);
    expect(moves.filter((m) => m.action === 'delete-empty')).toHaveLength(0);
  });
});

describe('executeMoves: create-shortcut + delete-empty handlers', () => {
  it('create-shortcut: walks segments to resolve targetId, ensures current/, deletes prior, creates shortcut', async () => {
    const d = makeFakeGoogleDrive();
    // 1. resolveTargetIdByPath: walks "3-connect" → "connect-opp-setup.md"
    d.files.list
      .mockResolvedValueOnce({
        data: { files: [{ id: 'phase-3-id', name: '3-connect', mimeType: 'application/vnd.google-apps.folder' }] },
      })
      .mockResolvedValueOnce({
        data: { files: [{ id: 'opp-summary-id', name: 'connect-opp-setup.md', mimeType: 'application/vnd.google-apps.document' }] },
      })
      // 2. find-or-create current/ folder under opp-id
      .mockResolvedValueOnce({ data: { files: [] } })
      // 3. list existing same-name shortcuts under current/
      .mockResolvedValueOnce({ data: { files: [{ id: 'old-shortcut-id' }] } });

    // current/ folder create
    d.files.create
      .mockResolvedValueOnce({ data: { id: 'current-folder-id', name: 'current' } })
      // shortcut create
      .mockResolvedValueOnce({ data: { id: 'new-shortcut-id', name: 'connect-opp-summary.md' } });

    // delete the prior same-name shortcut
    d.files.delete.mockResolvedValueOnce({ data: {} });

    const moves: PlannedMove[] = [{
      fileId: 'run-B-id',
      from: 'connect-opp-summary.md',
      to: '3-connect/connect-opp-setup.md',
      action: 'create-shortcut',
      runFolderId: 'run-B-id',
    }];

    const result = await executeMoves('opp-id', moves, d as any);
    expect(result.executed).toBe(1);
    expect(result.errors).toHaveLength(0);

    // The prior same-name was deleted.
    expect(d.files.delete).toHaveBeenCalledWith({
      fileId: 'old-shortcut-id',
      supportsAllDrives: true,
    });

    // Shortcut was created under current-folder-id with the resolved target.
    const shortcutCreate = d.files.create.mock.calls.find(
      (c) => c[0].requestBody?.mimeType === 'application/vnd.google-apps.shortcut',
    );
    expect(shortcutCreate).toBeDefined();
    expect(shortcutCreate![0].requestBody.parents).toEqual(['current-folder-id']);
    expect(shortcutCreate![0].requestBody.shortcutDetails).toEqual({ targetId: 'opp-summary-id' });
    expect(shortcutCreate![0].requestBody.name).toBe('connect-opp-summary.md');
  });

  it('delete-empty: re-lists; deletes only when confirmed empty', async () => {
    const d = makeFakeGoogleDrive();
    // Defensive re-list returns no children.
    d.files.list.mockResolvedValueOnce({ data: { files: [] } });
    d.files.delete.mockResolvedValueOnce({ data: {} });

    const moves: PlannedMove[] = [{
      fileId: 'verdicts-id',
      from: 'verdicts/',
      to: 'verdicts/',
      action: 'delete-empty',
      runFolderId: 'run-1-id',
    }];

    const result = await executeMoves('opp-id', moves, d as any);
    expect(result.executed).toBe(1);
    expect(d.files.delete).toHaveBeenCalledWith({
      fileId: 'verdicts-id',
      supportsAllDrives: true,
    });
  });

  it('delete-empty: skips deletion when re-list shows children appeared after plan', async () => {
    const d = makeFakeGoogleDrive();
    // Defensive re-list shows a child appeared.
    d.files.list.mockResolvedValueOnce({
      data: { files: [{ id: 'late-arrival-id' }] },
    });

    const moves: PlannedMove[] = [{
      fileId: 'verdicts-id',
      from: 'verdicts/',
      to: 'verdicts/',
      action: 'delete-empty',
      runFolderId: 'run-1-id',
    }];

    const result = await executeMoves('opp-id', moves, d as any);
    expect(result.executed).toBe(0);
    expect(d.files.delete).not.toHaveBeenCalled();
  });
});
