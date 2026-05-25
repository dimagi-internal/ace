import { describe, it, expect, vi } from 'vitest';
import yaml from 'yaml';

import {
  handleAppendRows,
  findDecisionsFile,
  writeDecisionsFile,
} from '../../../mcp/decisions-server.js';

/**
 * Fake drive client with queued responses for files.list / files.get /
 * files.export / files.update / files.create. Mirrors the helper pattern
 * already used in test/mcp/gdrive/read-file-retry.test.ts.
 */
function makeFakeDrive() {
  const listQueue: Array<() => any> = [];
  const getQueue: Array<() => any> = [];
  const exportQueue: Array<() => any> = [];
  const updateQueue: Array<(args: any) => any> = [];
  const createQueue: Array<(args: any) => any> = [];
  return {
    queueList(fn: () => any) { listQueue.push(fn); },
    queueGet(fn: () => any) { getQueue.push(fn); },
    queueExport(fn: () => any) { exportQueue.push(fn); },
    queueUpdate(fn: (args: any) => any) { updateQueue.push(fn); },
    queueCreate(fn: (args: any) => any) { createQueue.push(fn); },
    files: {
      list: vi.fn(async () => {
        const fn = listQueue.shift();
        if (!fn) throw new Error('files.list called more times than queued');
        return fn();
      }),
      get: vi.fn(async () => {
        const fn = getQueue.shift();
        if (!fn) throw new Error('files.get called more times than queued');
        return fn();
      }),
      export: vi.fn(async () => {
        const fn = exportQueue.shift();
        if (!fn) throw new Error('files.export called more times than queued');
        return fn();
      }),
      update: vi.fn(async (args: any) => {
        const fn = updateQueue.shift();
        if (!fn) throw new Error('files.update called more times than queued');
        return fn(args);
      }),
      create: vi.fn(async (args: any) => {
        const fn = createQueue.shift();
        if (!fn) throw new Error('files.create called more times than queued');
        return fn(args);
      }),
    },
  };
}

const PINNED_NOW = () => '2026-05-25T20:13:04Z';

const ROW_1 = {
  id: 'archetype-selection',
  phase: '1-design',
  skill: 'idea-to-pdd',
  question: 'Which delivery archetype best fits the intervention?',
  'ai-default': 'atomic-visit',
  options: ['atomic-visit', 'focus-group', 'multi-stage'],
  source: 'idea.md §1',
  status: 'ai-default' as const,
};

const ROW_2_WO = {
  id: 'wo-period-of-performance',
  phase: '1-design',
  skill: 'pdd-to-work-order',
  question: 'what dates bound the work',
  'ai-default': '2026-05-22 to 2026-07-31',
  options: ['2026-05-22 to 2026-07-31'],
  source: 'pdd-timeline',
  status: 'ai-default' as const,
};

describe('findDecisionsFile', () => {
  it('returns null when decisions.yaml does not exist under the run folder', async () => {
    const fake = makeFakeDrive();
    fake.queueList(() => ({ data: { files: [] } }));
    const r = await findDecisionsFile(fake as any, 'run-folder-id');
    expect(r).toBeNull();
  });

  it('reads a Google-Doc-backed decisions.yaml via files.export', async () => {
    const fake = makeFakeDrive();
    fake.queueList(() => ({
      data: {
        files: [{
          id: 'dec-file-id',
          name: 'decisions.yaml',
          mimeType: 'application/vnd.google-apps.document',
        }],
      },
    }));
    fake.queueExport(() => ({ data: 'schema_version: 3\ndecisions: []\n' }));

    const r = await findDecisionsFile(fake as any, 'run-folder-id');
    expect(r).toEqual({
      fileId: 'dec-file-id',
      mimeType: 'application/vnd.google-apps.document',
      content: 'schema_version: 3\ndecisions: []\n',
    });
  });

  it('reads a text/yaml file via files.get alt=media', async () => {
    const fake = makeFakeDrive();
    fake.queueList(() => ({
      data: {
        files: [{ id: 'dec-file-id', name: 'decisions.yaml', mimeType: 'text/yaml' }],
      },
    }));
    fake.queueGet(() => ({ data: 'schema_version: 3\ndecisions: []\n' }));
    const r = await findDecisionsFile(fake as any, 'run-folder-id');
    expect(r?.content).toContain('schema_version: 3');
  });
});

describe('handleAppendRows', () => {
  it('creates a new Google Doc when decisions.yaml is absent', async () => {
    const fake = makeFakeDrive();
    fake.queueList(() => ({ data: { files: [] } }));
    fake.queueCreate((args: any) => {
      expect(args.requestBody.name).toBe('decisions.yaml');
      expect(args.requestBody.parents).toEqual(['run-folder-id']);
      expect(args.requestBody.mimeType).toBe('application/vnd.google-apps.document');
      const body = args.media.body as string;
      // The body must be parseable v3 YAML with the row we passed.
      const parsed = yaml.parse(body);
      expect(parsed.schema_version).toBe(3);
      expect(parsed.opportunity).toBe('bednet-spot-check');
      expect(parsed.run_id).toBe('20260525-2013');
      expect(parsed.generated_at).toBe('2026-05-25T20:13:04Z');
      expect(parsed.decisions).toHaveLength(1);
      expect(parsed.decisions[0].id).toBe('archetype-selection');
      return { data: { id: 'new-file-id', modifiedTime: 't', version: '1' } };
    });

    const r = await handleAppendRows(
      {
        runFolderId: 'run-folder-id',
        opportunity: 'bednet-spot-check',
        run_id: '20260525-2013',
        rows: [ROW_1],
      },
      fake as any,
      { now: PINNED_NOW },
    );

    expect(r).toEqual({
      fileId: 'new-file-id',
      added: 1,
      skipped: [],
      total: 1,
      modifiedTime: 't',
      revisionVersion: '1',
      created: true,
    });
    expect(fake.files.create).toHaveBeenCalledTimes(1);
    expect(fake.files.update).not.toHaveBeenCalled();
  });

  it('appends to an existing log via files.update', async () => {
    const existingContent = yaml.stringify({
      schema_version: 3,
      opportunity: 'bednet-spot-check',
      run_id: '20260525-2013',
      generated_at: '2026-05-25T20:13:04Z',
      decisions: [ROW_1],
    });
    const fake = makeFakeDrive();
    fake.queueList(() => ({
      data: {
        files: [{
          id: 'dec-file-id',
          name: 'decisions.yaml',
          mimeType: 'application/vnd.google-apps.document',
        }],
      },
    }));
    fake.queueExport(() => ({ data: existingContent }));
    fake.queueUpdate((args: any) => {
      expect(args.fileId).toBe('dec-file-id');
      const body = args.media.body as string;
      const parsed = yaml.parse(body);
      expect(parsed.decisions.map((d: any) => d.id)).toEqual([
        'archetype-selection',
        'wo-period-of-performance',
      ]);
      return { data: { id: 'dec-file-id', modifiedTime: 't2', version: '2' } };
    });

    const r = await handleAppendRows(
      {
        runFolderId: 'run-folder-id',
        opportunity: 'bednet-spot-check',
        run_id: '20260525-2013',
        rows: [ROW_2_WO],
      },
      fake as any,
    );

    expect(r).toMatchObject({
      fileId: 'dec-file-id',
      added: 1,
      skipped: [],
      total: 2,
      created: false,
    });
  });

  it('is a no-op when all rows are already present (no write call)', async () => {
    const existingContent = yaml.stringify({
      schema_version: 3,
      opportunity: 'bednet-spot-check',
      run_id: '20260525-2013',
      generated_at: '2026-05-25T20:13:04Z',
      decisions: [ROW_1, ROW_2_WO],
    });
    const fake = makeFakeDrive();
    fake.queueList(() => ({
      data: {
        files: [{
          id: 'dec-file-id',
          name: 'decisions.yaml',
          mimeType: 'application/vnd.google-apps.document',
        }],
      },
    }));
    fake.queueExport(() => ({ data: existingContent }));

    const r = await handleAppendRows(
      {
        runFolderId: 'run-folder-id',
        opportunity: 'bednet-spot-check',
        run_id: '20260525-2013',
        rows: [ROW_1, ROW_2_WO],
      },
      fake as any,
    );

    expect(r).toEqual({
      fileId: 'dec-file-id',
      added: 0,
      skipped: ['archetype-selection', 'wo-period-of-performance'],
      total: 2,
      created: false,
    });
    expect(fake.files.update).not.toHaveBeenCalled();
    expect(fake.files.create).not.toHaveBeenCalled();
  });
});

describe('writeDecisionsFile', () => {
  it('creates when existingFileId is null', async () => {
    const fake = makeFakeDrive();
    fake.queueCreate((args: any) => {
      expect(args.media.body).toBe('content');
      return { data: { id: 'new', modifiedTime: 't', version: '1' } };
    });
    const r = await writeDecisionsFile(fake as any, {
      runFolderId: 'rf',
      existingFileId: null,
      content: 'content',
    });
    expect(r).toEqual({ fileId: 'new', modifiedTime: 't', revisionVersion: '1' });
  });

  it('updates when existingFileId is set', async () => {
    const fake = makeFakeDrive();
    fake.queueUpdate((args: any) => {
      expect(args.fileId).toBe('existing');
      return { data: { id: 'existing', modifiedTime: 't2', version: '5' } };
    });
    const r = await writeDecisionsFile(fake as any, {
      runFolderId: 'rf',
      existingFileId: 'existing',
      content: 'content',
    });
    expect(r).toEqual({ fileId: 'existing', modifiedTime: 't2', revisionVersion: '5' });
  });
});
