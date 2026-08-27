import { describe, it, expect, vi } from 'vitest';
import yaml from 'yaml';

import {
  handleAppendRows,
  findDecisionsFile,
  findDecisionOverridesFile,
  writeDecisionsFile,
} from '../../../mcp/decisions-server.js';
import { DECISIONS_SCHEMA_VERSION } from '../../../lib/decisions-schema.js';

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

/**
 * Queue the overrides-lookup chain for a run folder that has NO
 * inputs/decision-overrides.yaml: two files.get parent walks
 * (run folder → runs/ → opp folder) then one files.list that finds no
 * inputs folder.
 */
function queueNoOverrides(fake: ReturnType<typeof makeFakeDrive>) {
  fake.queueGet(() => ({ data: { parents: ['runs-folder-id'] } }));
  fake.queueGet(() => ({ data: { parents: ['opp-folder-id'] } }));
  fake.queueList(() => ({ data: { files: [] } }));
}

const OVERRIDES_YAML = `
schema_version: 1
kind: decision-overrides
opp: bednet-spot-check
updated_at: 2026-07-24T15:02:11Z
overrides:
  - id: archetype-selection
    phase: idea-to-design
    question: Which delivery archetype best fits the intervention?
    ai_default: atomic-visit
    override: focus-group
    override_reasoning: Village-level enrollment; atomic-visit triples FLW days.
    decided_by: expert@partner.org
    decided_at: 2026-07-24T14:58:02Z
    source_run_id: 20260722-1341
`;

/**
 * Queue the overrides-lookup chain that FINDS an x-yaml overrides file:
 * parent walk (2 gets) → inputs folder list → overrides file list →
 * alt=media content get.
 */
function queueOverridesFound(fake: ReturnType<typeof makeFakeDrive>, content: string) {
  fake.queueGet(() => ({ data: { parents: ['runs-folder-id'] } }));
  fake.queueGet(() => ({ data: { parents: ['opp-folder-id'] } }));
  fake.queueList(() => ({ data: { files: [{ id: 'inputs-folder-id' }] } }));
  fake.queueList(() => ({
    data: {
      files: [{ id: 'overrides-file-id', name: 'decision-overrides.yaml', mimeType: 'application/x-yaml' }],
    },
  }));
  fake.queueGet(() => ({ data: content }));
}

const ROW_1 = {
  id: 'archetype-selection',
  phase: '1-design',
  skill: 'idea-to-pdd',
  question: 'Which delivery archetype best fits the intervention?',
  'ai-default': 'atomic-visit',
  options: ['atomic-visit', 'focus-group', 'multi-stage'],
  source: 'idea.md §1',
  status: 'ai-default' as const,
  evidence_basis: 'stated' as const,
  value_set_by: "ace" as const,
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
  evidence_basis: 'inferred' as const,
  value_set_by: "external" as const,
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
    queueNoOverrides(fake);
    fake.queueCreate((args: any) => {
      expect(args.requestBody.name).toBe('decisions.yaml');
      expect(args.requestBody.parents).toEqual(['run-folder-id']);
      expect(args.requestBody.mimeType).toBe('application/vnd.google-apps.document');
      const body = args.media.body as string;
      // A freshly-seeded log is written at the current schema version (v4).
      const parsed = yaml.parse(body);
      expect(parsed.schema_version).toBe(DECISIONS_SCHEMA_VERSION);
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
      overridesApplied: [],
      rulingsApplied: [],
      rulingsSkippedUnattributed: [],
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
    queueNoOverrides(fake);
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
    queueNoOverrides(fake);

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
      overridesApplied: [],
      rulingsApplied: [],
      rulingsSkippedUnattributed: [],
    });
    expect(fake.files.update).not.toHaveBeenCalled();
    expect(fake.files.create).not.toHaveBeenCalled();
  });
});

describe('findDecisionOverridesFile', () => {
  it('returns null when the opp has no inputs folder', async () => {
    const fake = makeFakeDrive();
    queueNoOverrides(fake);
    const r = await findDecisionOverridesFile(fake as any, 'run-folder-id');
    expect(r).toBeNull();
  });

  it('returns null when inputs exists but has no decision-overrides.yaml', async () => {
    const fake = makeFakeDrive();
    fake.queueGet(() => ({ data: { parents: ['runs-folder-id'] } }));
    fake.queueGet(() => ({ data: { parents: ['opp-folder-id'] } }));
    fake.queueList(() => ({ data: { files: [{ id: 'inputs-folder-id' }] } }));
    fake.queueList(() => ({ data: { files: [] } }));
    const r = await findDecisionOverridesFile(fake as any, 'run-folder-id');
    expect(r).toBeNull();
  });

  it('returns null when the run folder has no parents (defensive)', async () => {
    const fake = makeFakeDrive();
    fake.queueGet(() => ({ data: {} }));
    const r = await findDecisionOverridesFile(fake as any, 'run-folder-id');
    expect(r).toBeNull();
  });

  it('reads an application/x-yaml overrides file via files.get alt=media', async () => {
    const fake = makeFakeDrive();
    queueOverridesFound(fake, OVERRIDES_YAML);
    const r = await findDecisionOverridesFile(fake as any, 'run-folder-id');
    expect(r?.fileId).toBe('overrides-file-id');
    expect(r?.content).toContain('kind: decision-overrides');
  });

  it('reads a Google-Doc-backed overrides file via files.export', async () => {
    const fake = makeFakeDrive();
    fake.queueGet(() => ({ data: { parents: ['runs-folder-id'] } }));
    fake.queueGet(() => ({ data: { parents: ['opp-folder-id'] } }));
    fake.queueList(() => ({ data: { files: [{ id: 'inputs-folder-id' }] } }));
    fake.queueList(() => ({
      data: {
        files: [{
          id: 'overrides-file-id',
          name: 'decision-overrides.yaml',
          mimeType: 'application/vnd.google-apps.document',
        }],
      },
    }));
    fake.queueExport(() => ({ data: OVERRIDES_YAML }));
    const r = await findDecisionOverridesFile(fake as any, 'run-folder-id');
    expect(r?.content).toContain('kind: decision-overrides');
  });
});

describe('handleAppendRows — reviewer decision-overrides (ace#933)', () => {
  it('binds a saved override onto a raised row and reports it', async () => {
    const fake = makeFakeDrive();
    fake.queueList(() => ({ data: { files: [] } }));
    queueOverridesFound(fake, OVERRIDES_YAML);
    fake.queueCreate((args: any) => {
      const parsed = yaml.parse(args.media.body as string);
      expect(parsed.decisions).toHaveLength(1);
      expect(parsed.decisions[0]).toMatchObject({
        id: 'archetype-selection',
        status: 'overridden',
        override: 'focus-group',
        'ai-default': 'atomic-visit',
      });
      expect(parsed.decisions[0].override_reasoning).toContain('Village-level');
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
    expect(r.overridesApplied).toEqual(['archetype-selection']);
    expect(r.added).toBe(1);
  });

  it('rejects an overrides file whose opp does not match the call', async () => {
    const fake = makeFakeDrive();
    fake.queueList(() => ({ data: { files: [] } }));
    queueOverridesFound(
      fake,
      OVERRIDES_YAML.replace('opp: bednet-spot-check', 'opp: some-other-opp'),
    );
    await expect(
      handleAppendRows(
        {
          runFolderId: 'run-folder-id',
          opportunity: 'bednet-spot-check',
          run_id: '20260525-2013',
          rows: [ROW_1],
        },
        fake as any,
        { now: PINNED_NOW },
      ),
    ).rejects.toThrowError(/IDENTITY_MISMATCH|some-other-opp/);
  });

  it('fails loud on a malformed overrides file instead of silently dropping review intent', async () => {
    const fake = makeFakeDrive();
    fake.queueList(() => ({ data: { files: [] } }));
    queueOverridesFound(fake, 'schema_version: 1\nkind: decision-overrides\n');
    await expect(
      handleAppendRows(
        {
          runFolderId: 'run-folder-id',
          opportunity: 'bednet-spot-check',
          run_id: '20260525-2013',
          rows: [ROW_1],
        },
        fake as any,
        { now: PINNED_NOW },
      ),
    ).rejects.toThrowError(/decision-overrides/);
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
