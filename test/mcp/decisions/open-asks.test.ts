/**
 * `decisions_open_asks` (mcp/decisions-server.ts): reads the run's
 * decisions.yaml, the opp's saved rulings and the previous run's
 * open-asks.yaml; `emit` writes ACE/<opp>/open-asks.yaml at the opp root AFTER
 * the carried check has read the previous one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import yaml from 'yaml';

import { handleOpenAsks } from '../../../mcp/decisions-server.js';
import { parseDecisionsYaml, serializeDecisionsLog, type DecisionRow } from '../../../lib/decisions-schema.js';
import { buildOpenAsksFile, parseOpenAsksYaml, serializeOpenAsks } from '../../../lib/open-asks.js';

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
  decisions: string;
  priorOpenAsks?: string;
  overrides?: string;
}

function fakeDrive(o: FakeOpts) {
  const created: Array<{ name: string; parents: string[]; body: string }> = [];
  const updated: Array<{ fileId: string; body: string }> = [];
  const parents: Record<string, string> = { run: 'runs', runs: 'opp' };
  return {
    created,
    updated,
    files: {
      get: vi.fn(async (a: { fileId: string; alt?: string }) => {
        if (a.alt === 'media') {
          if (a.fileId === 'oa') return { data: o.priorOpenAsks };
          if (a.fileId === 'ov') return { data: o.overrides };
          throw new Error(`unexpected media read ${a.fileId}`);
        }
        return { data: { id: a.fileId, parents: parents[a.fileId] ? [parents[a.fileId]] : [] } };
      }),
      list: vi.fn(async ({ q }: { q: string }) => {
        if (q.includes("name='decisions.yaml'")) return { data: { files: [{ id: 'dec', mimeType: 'application/vnd.google-apps.document' }] } };
        if (q.includes("name='inputs'")) return { data: { files: o.overrides ? [{ id: 'inputs' }] : [] } };
        if (q.includes("name='decision-overrides.yaml'")) return { data: { files: [{ id: 'ov', mimeType: 'application/x-yaml' }] } };
        if (q.includes("name='open-asks.yaml'")) return { data: { files: o.priorOpenAsks ? [{ id: 'oa', mimeType: 'application/x-yaml' }] : [] } };
        throw new Error(`unexpected list ${q}`);
      }),
      export: vi.fn(async () => ({ data: o.decisions })),
      create: vi.fn(async (a: { requestBody: { name: string; parents: string[] }; media: { body: string } }) => {
        created.push({ name: a.requestBody.name, parents: a.requestBody.parents, body: a.media.body });
        return { data: { id: 'new-oa' } };
      }),
      update: vi.fn(async (a: { fileId: string; media: { body: string } }) => {
        updated.push({ fileId: a.fileId, body: a.media.body });
        return { data: { id: a.fileId } };
      }),
    },
  };
}

const args = { runFolderId: 'run', opportunity: 'spark-facilitator', run_id: '20261001-2208', now: '2026-10-04T00:00:00Z' };

describe('decisions_open_asks', () => {
  it('emit writes open-asks.yaml at the OPP root with the open asks', async () => {
    const fake = fakeDrive({ decisions: serializeDecisionsLog({ ...SPARK, decisions: [...SPARK.decisions, RCT] }) });
    const r = await handleOpenAsks({ ...args, mode: 'emit' }, fake as never);
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]).toMatchObject({ name: 'open-asks.yaml', parents: ['opp'] });
    const file = parseOpenAsksYaml(fake.created[0].body);
    expect(file).toMatchObject({ schema_version: 1, opp: 'spark-facilitator', run_id: '20261001-2208' });
    expect(file.asks.map((a) => a.id)).toContain('rct-sample-overlap');
    expect(r.requiredBefore.map((a) => a.id)).toEqual(['rct-sample-overlap']);
    expect(r.carried).toBeNull();
    expect(r.written).toEqual({ fileId: 'new-oa', created: true });
  });

  it('check writes nothing and reports the award blocker', async () => {
    const fake = fakeDrive({ decisions: serializeDecisionsLog({ ...SPARK, decisions: [...SPARK.decisions, RCT] }) });
    const r = await handleOpenAsks({ ...args, mode: 'check', neededBy: 'award' }, fake as never);
    expect(fake.created).toEqual([]);
    expect(fake.updated).toEqual([]);
    expect(r.requiredBefore).toHaveLength(1);
    expect(r.written).toBeNull();
  });

  it('a saved ruling clears the award blocker', async () => {
    const overrides = yaml.stringify({
      schema_version: 1,
      kind: 'decision-overrides',
      opp: 'spark-facilitator',
      overrides: [{ id: 'rct-sample-overlap', override: 'Allow study communities', decided_by: 'jjackson@dimagi.com', decided_at: '2026-10-04' }],
    });
    const fake = fakeDrive({ decisions: serializeDecisionsLog({ ...SPARK, decisions: [...SPARK.decisions, RCT] }), overrides });
    const r = await handleOpenAsks({ ...args, mode: 'check', neededBy: 'award' }, fake as never);
    expect(r.requiredBefore).toEqual([]);
  });

  it('compares against the PREVIOUS run, reports what was dropped, then overwrites in place', async () => {
    const prior = serializeOpenAsks(
      buildOpenAsksFile({ opp: 'spark-facilitator', runId: '20260926-1413', log: { decisions: [RCT] }, generatedAt: '2026-09-27T00:00:00Z' }),
    );
    const fake = fakeDrive({ decisions: serializeDecisionsLog(SPARK), priorOpenAsks: prior });
    const r = await handleOpenAsks({ ...args, mode: 'emit' }, fake as never);
    expect(r.carried?.priorRunId).toBe('20260926-1413');
    expect(r.carried?.missing).toEqual(['rct-sample-overlap']);
    expect(r.carried?.residuals[0].what).toContain('impact study');
    expect(fake.updated).toHaveLength(1);
    expect(fake.updated[0].fileId).toBe('oa');
    expect(parseOpenAsksYaml(fake.updated[0].body).run_id).toBe('20261001-2208');
  });

  it('re-running emit in the same run does not compare the run with itself', async () => {
    const own = serializeOpenAsks(buildOpenAsksFile({ opp: 'spark-facilitator', runId: '20261001-2208', log: SPARK, generatedAt: 't' }));
    const fake = fakeDrive({ decisions: serializeDecisionsLog(SPARK), priorOpenAsks: own });
    const r = await handleOpenAsks({ ...args, mode: 'emit' }, fake as never);
    expect(r.carried).toBeNull();
  });
});
