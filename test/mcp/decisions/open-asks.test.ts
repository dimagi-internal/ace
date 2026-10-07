/**
 * `decisions_open_asks` (mcp/decisions-server.ts): open asks are a FILTER over
 * the run's decisions.yaml, never a file (operator decision 2026-10-07,
 * ace#2757). The atom reads the run's log, the opp's saved rulings and — for
 * the carried check only — the PREVIOUS run's decisions.yaml (the newest older
 * sibling run folder that has one). It writes nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import yaml from 'yaml';

import { handleOpenAsks } from '../../../mcp/decisions-server.js';
import { parseDecisionsYaml, serializeDecisionsLog, type DecisionRow } from '../../../lib/decisions-schema.js';

const DIR = join(__dirname, '..', '..', 'fixtures', 'decisions-backfill', 'spark-facilitator-20261001-2208');
const SPARK = parseDecisionsYaml(readFileSync(join(DIR, 'decisions.yaml'), 'utf8'));

const RCT: DecisionRow = {
  id: 'rct-sample-overlap',
  phase: '1-design',
  skill: 'idea-to-pdd',
  question: 'May the pilot work in communities that are in the impact study sample?',
  'ai-default': 'Exclude study communities',
  options: ['Exclude study communities', 'Allow study communities'],
  source: 'PDD § Evaluation design',
  status: 'ai-default',
  evidence_basis: 'inferred',
  value_set_by: 'external',
  plain: 'The pilot assumes it will not work in communities that are part of the impact study.',
  plain_question: 'May the pilot work in communities that are part of the impact study?',
  review_ask: 'required-before',
  needed_by: 'award',
  owner: 'partner',
  answer_channel: 'review',
  confirm_reason: 'The award could pick study communities, and nothing in the sources says whether that is allowed.',
};

interface FakeOpts {
  /** This run's decisions.yaml text. */
  decisions: string;
  /** Sibling run folders under runs/ by name → their decisions.yaml text (null = folder without one). */
  siblings?: Record<string, string | null>;
  overrides?: string;
}

const THIS_RUN = '20261001-2208';

function fakeDrive(o: FakeOpts) {
  const siblings: Record<string, string | null> = { [THIS_RUN]: o.decisions, ...(o.siblings ?? {}) };
  const folderId = (name: string) => (name === THIS_RUN ? 'run' : `run:${name}`);
  const decisionsById: Record<string, string> = {};
  for (const [name, text] of Object.entries(siblings)) if (text !== null) decisionsById[`dec:${folderId(name)}`] = text;
  const parents: Record<string, string> = { run: 'runs', runs: 'opp' };
  const fake = {
    files: {
      get: vi.fn(async (a: { fileId: string; alt?: string }) => {
        if (a.alt === 'media') {
          if (a.fileId === 'ov') return { data: o.overrides };
          throw new Error(`unexpected media read ${a.fileId}`);
        }
        return { data: { id: a.fileId, parents: parents[a.fileId] ? [parents[a.fileId]] : [] } };
      }),
      list: vi.fn(async ({ q }: { q: string }) => {
        const parent = /'([^']+)' in parents/.exec(q)?.[1] ?? '';
        if (q.includes("name='decisions.yaml'")) {
          const id = `dec:${parent}`;
          return { data: { files: decisionsById[id] !== undefined ? [{ id, mimeType: 'application/vnd.google-apps.document' }] : [] } };
        }
        if (q.includes("name='inputs'")) return { data: { files: o.overrides ? [{ id: 'inputs' }] : [] } };
        if (q.includes("name='decision-overrides.yaml'")) return { data: { files: [{ id: 'ov', mimeType: 'application/x-yaml' }] } };
        if (parent === 'runs' && q.includes("mimeType='application/vnd.google-apps.folder'")) {
          return { data: { files: Object.keys(siblings).map((name) => ({ id: folderId(name), name })) } };
        }
        throw new Error(`unexpected list ${q}`);
      }),
      export: vi.fn(async ({ fileId }: { fileId: string }) => ({ data: decisionsById[fileId] })),
      create: vi.fn(async () => {
        throw new Error('decisions_open_asks must never create a file');
      }),
      update: vi.fn(async () => {
        throw new Error('decisions_open_asks must never update a file');
      }),
    },
  };
  return fake;
}

const args = { runFolderId: 'run', opportunity: 'spark-facilitator', run_id: THIS_RUN };
const withRct = () => serializeDecisionsLog({ ...SPARK, decisions: [...SPARK.decisions, RCT] });

describe('decisions_open_asks — a filter over decisions.yaml', () => {
  it('reports the open asks computed from the run\'s decisions and writes nothing', async () => {
    const fake = fakeDrive({ decisions: withRct() });
    const r = await handleOpenAsks({ ...args, checkCarried: true }, fake as never);
    expect(r.asks.map((a) => a.id)).toContain('rct-sample-overlap');
    for (const a of r.asks) expect(a.review_ask !== undefined || a.status === 'deferred').toBe(true);
    expect(r.requiredBefore.map((a) => a.id)).toEqual(['rct-sample-overlap']);
    expect(fake.files.create).not.toHaveBeenCalled();
    expect(fake.files.update).not.toHaveBeenCalled();
    expect('written' in r).toBe(false);
  });

  it('never looks for open-asks.yaml or open-questions.md', async () => {
    const fake = fakeDrive({ decisions: withRct(), siblings: { '20260926-1413': serializeDecisionsLog({ ...SPARK, decisions: [RCT] }) } });
    await handleOpenAsks({ ...args, throughPhase: 1 }, fake as never);
    const queries = fake.files.list.mock.calls.map((c) => (c[0] as { q: string }).q).join('\n');
    expect(queries).not.toContain('open-asks.yaml');
    expect(queries).not.toContain('open-questions');
  });

  it('a saved ruling clears the award blocker', async () => {
    const overrides = yaml.stringify({
      schema_version: 1,
      kind: 'decision-overrides',
      opp: 'spark-facilitator',
      overrides: [{ id: 'rct-sample-overlap', override: 'Allow study communities', decided_by: 'jjackson@dimagi.com', decided_at: '2026-10-04' }],
    });
    const fake = fakeDrive({ decisions: withRct(), overrides });
    const r = await handleOpenAsks({ ...args, neededBy: 'award' }, fake as never);
    expect(r.requiredBefore).toEqual([]);
  });

  it('compares with the PREVIOUS run\'s decisions log and reports what was dropped', async () => {
    const fake = fakeDrive({
      decisions: serializeDecisionsLog(SPARK),
      siblings: {
        '20260926-1413': serializeDecisionsLog({ ...SPARK, run_id: '20260926-1413', decisions: [RCT] }),
        '20260915-0800': null,
        '20261003-1200': serializeDecisionsLog({ ...SPARK, run_id: '20261003-1200', decisions: [] }), // a LATER run is never "previous"
        'superseded-20261001-0900': serializeDecisionsLog({ ...SPARK, decisions: [] }),
      },
    });
    const r = await handleOpenAsks({ ...args, checkCarried: true }, fake as never);
    expect(r.carried?.priorRunId).toBe('20260926-1413');
    expect(r.carried?.missing).toEqual(['rct-sample-overlap']);
    expect(r.carried?.residuals[0].what).toContain('impact study');
  });

  it('skips a previous folder with no decisions.yaml and takes the next older one', async () => {
    const fake = fakeDrive({
      decisions: serializeDecisionsLog(SPARK),
      siblings: {
        '20260930-1000': null,
        '20260926-1413': serializeDecisionsLog({ ...SPARK, run_id: '20260926-1413', decisions: [RCT] }),
      },
    });
    const r = await handleOpenAsks({ ...args, throughPhase: 1 }, fake as never);
    expect(r.carried?.priorRunId).toBe('20260926-1413');
  });

  it('no carried check unless asked; null when there is no previous run', async () => {
    const prior = { '20260926-1413': serializeDecisionsLog({ ...SPARK, decisions: [RCT] }) };
    expect((await handleOpenAsks(args, fakeDrive({ decisions: withRct(), siblings: prior }) as never)).carried).toBeNull();
    expect((await handleOpenAsks({ ...args, checkCarried: true }, fakeDrive({ decisions: withRct() }) as never)).carried).toBeNull();
  });
});
