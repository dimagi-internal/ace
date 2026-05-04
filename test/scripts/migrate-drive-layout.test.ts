/**
 * Tests for `scripts/migrate-drive-layout.ts` — the planner half of the
 * Drive layout migration tool (Tasks 9-10 of the run-folder-readability
 * plan). Covers the pure `planMoves` function with `vi.fn()`-mocked
 * `DriveLike` shape; no live Drive calls.
 */

import { describe, it, expect, vi } from 'vitest';
import { planMoves } from '../../scripts/migrate-drive-layout.js';

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
    expect(moves).toEqual([
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
    expect(moves).toEqual([]);
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

  it('preserves nested folder hierarchy for qa-plan/walkthrough-recipes', async () => {
    const drive = fakeDrive({
      'opp-id': [{ id: 'runs-id', name: 'runs', mimeType: FOLDER }],
      'runs-id': [{ id: 'run-1-id', name: 'run-1', mimeType: FOLDER }],
      'run-1-id': [
        { id: 'qp-id', name: 'qa-plan', mimeType: FOLDER },
      ],
      'qp-id': [
        { id: 'wr-id', name: 'walkthrough-recipes', mimeType: FOLDER },
      ],
      'wr-id': [
        { id: 'lm-id', name: 'learn-module-1.yaml', mimeType: YAML },
      ],
    });
    const moves = await planMoves('opp-id', drive as any);
    expect(moves).toContainEqual({
      fileId: 'lm-id',
      from: 'qa-plan/walkthrough-recipes/learn-module-1.yaml',
      to: '5-qa-and-training/qa-plan/walkthrough-recipes/learn-module-1.yaml',
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
    expect(moves).toHaveLength(2);
    const a = moves.find((m) => m.fileId === 'pdd-A-id');
    const b = moves.find((m) => m.fileId === 'pdd-B-id');
    expect(a?.runFolderId).toBe('run-A-id');
    expect(b?.runFolderId).toBe('run-B-id');
    expect(a?.to).toBe('1-design/idea-to-pdd.md');
    expect(b?.to).toBe('1-design/idea-to-pdd.md');
  });
});
