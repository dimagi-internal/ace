/**
 * lib/labs-report-templates.ts + lib/labs-template-draft.ts — ACE's Labs
 * template workflows: follow at build, freeze at run end, and the DDD loop's
 * draft → preview → publish/discard cycle.
 *
 * The fake labs below mirrors the response shapes measured live on 2026-10-16
 * (templates 11281/11284/11287 in program 10157, followed by the
 * kaduna-graduation/20261015-1411 cascade): `workflow_get.render_source` is
 * `{source: 'template_workflow', template_workflow, version}` while following,
 * `{source: 'stored', version}` once forked, `{source: 'template', template}` on
 * the deployed code template; `workflow_follow_template` answers `follows: {workflow}`.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import {
  cascadeOf,
  checkTemplates,
  dddDispatchBlock,
  followRunReports,
  followedTemplateWorkflow,
  freezeRunReports,
  loadReportTemplatesConfig,
  parseReportTemplatesConfig,
  protectedTemplateIds,
  recordedBlock,
  refollowArgs,
  reportTemplatesPatch,
  runReports,
  type ReportTemplatesConfig,
} from '../../lib/labs-report-templates.js';
import {
  beginDraft,
  discardDraft,
  draftPreviewUrl,
  publishDecision,
  publishDraft,
  templateIdFor,
} from '../../lib/labs-template-draft.js';
import { unwrapToolResult } from '../../lib/labs-rpc.js';

const CFG: ReportTemplatesConfig = {
  home: { program_id: 10157 },
  templates: {
    indicator_programme_report: { template_workflow_id: 11281 },
    indicator_worker_review: { template_workflow_id: 11284 },
    indicator_opp_report: { template_workflow_id: 11287 },
  },
};

const KADUNA = {
  program_id: 10152,
  programme_report: { workflow_id: 10512, run_id: 11139 },
  worker_review: { workflow_id: 10514 },
  opp_reports: [
    { partner: 'Haske Mata Development Circle (example)', opportunity_id: 10152, workflow_id: 10517 },
    { partner: 'B (example)', opportunity_id: 10153, workflow_id: 10519 },
  ],
};
const TYPES: Record<number, string> = { 10512: 'indicator_programme_report', 10514: 'indicator_worker_review', 10517: 'indicator_opp_report', 10519: 'indicator_opp_report' };

function fakeLabs(opts: { published?: Record<number, number>; publishDuringFork?: boolean; draft?: Record<number, { revision: number; differs: boolean; updated_at: string }> } = {}) {
  const calls: Array<{ tool: string; args: any }> = [];
  const rs = new Map<number, Record<string, unknown>>();
  for (const w of Object.keys(TYPES)) rs.set(Number(w), { source: 'template', template: TYPES[Number(w)] });
  const published: Record<number, number> = { 11281: 1, 11284: 1, 11287: 2, ...(opts.published ?? {}) };
  const draft: Record<number, { revision: number; differs: boolean; updated_at: string; code: string }> = {};
  for (const t of [11281, 11284, 11287]) draft[t] = { revision: 1, differs: false, updated_at: '2026-10-16T00:00:00Z', code: `PUBLISHED ${t}`, ...(opts.draft?.[t] ?? {}) };
  const call = async (tool: string, args: any): Promise<any> => {
    calls.push({ tool, args });
    switch (tool) {
      case 'workflow_get':
        return { id: args.workflow_id, template_type: TYPES[args.workflow_id], render_source: rs.get(args.workflow_id) };
      case 'workflow_follow_template':
        if (args.follow === false) {
          if (opts.publishDuringFork && args.workflow_id === 10517) published[11287] += 1;
          rs.set(args.workflow_id, { source: 'stored', version: 2 });
          return { workflow_id: args.workflow_id };
        }
        rs.set(args.workflow_id, { source: 'template_workflow', template_workflow: args.template_workflow_id, version: published[args.template_workflow_id] });
        return { workflow_id: args.workflow_id, follows: { workflow: args.template_workflow_id, program_id: args.template_program_id }, published_version: published[args.template_workflow_id] };
      case 'workflow_template_get': {
        const t = args.template_workflow_id;
        return {
          template_workflow_id: t,
          template_type: { 11281: 'indicator_programme_report', 11284: 'indicator_worker_review', 11287: 'indicator_opp_report' }[t as 11281],
          sharing: { public: true },
          you_can_edit: true,
          published_version: published[t],
          followers: [],
          draft: { revision: draft[t].revision, differs_from_published: draft[t].differs, updated_at: draft[t].updated_at, updated_by: 'ace' },
        };
      }
      case 'workflow_template_export':
        return { code: `PUBLISHED ${args.template_workflow_id}` };
      case 'workflow_template_update_draft': {
        const d = draft[args.template_workflow_id];
        if (args.expected_revision !== d.revision) throw new Error('workflow_template_update_draft: REVISION_CONFLICT');
        d.revision += 1;
        if (typeof args.render_code === 'string') d.code = args.render_code;
        d.differs = d.code !== `PUBLISHED ${args.template_workflow_id}`;
        return {};
      }
      case 'workflow_template_publish': {
        const d = draft[args.template_workflow_id];
        if (args.expected_revision !== undefined && args.expected_revision !== d.revision) throw new Error('REVISION_CONFLICT');
        published[args.template_workflow_id] += 1;
        d.differs = false;
        return { published_version: published[args.template_workflow_id] };
      }
      default:
        throw new Error(`fake labs: unexpected ${tool}`);
    }
  };
  return { call, calls, rs, published, draft };
}

describe('config/labs-report-templates.yaml', () => {
  it('the checked-in config parses and names a template for every role', () => {
    const cfg = loadReportTemplatesConfig();
    expect(cfg.home.program_id).toBe(10157);
    expect(Object.keys(cfg.templates).sort()).toEqual(['indicator_opp_report', 'indicator_programme_report', 'indicator_worker_review']);
    expect(protectedTemplateIds(cfg)).toEqual([10157, 11281, 11284, 11287]);
  });

  it('refuses a config with a missing role or a bad id (a silent default would follow nothing)', () => {
    expect(() => parseReportTemplatesConfig('home: {program_id: 1}\ntemplates: {indicator_programme_report: {template_workflow_id: 2}}')).toThrow(/no template for indicator_worker_review/);
    expect(() => parseReportTemplatesConfig('home: {program_id: x}\ntemplates: {}')).toThrow(/home.program_id/);
  });
});

describe('runReports / render_source shapes', () => {
  it('lists the programme report, worker review and every opp report with the scope labs reads them under', () => {
    expect(runReports(KADUNA)).toEqual([
      { role: 'programme_report', workflow_id: 10512, program_id: 10152 },
      { role: 'worker_review', workflow_id: 10514, program_id: 10152 },
      { role: 'opp_report', workflow_id: 10517, opportunity_id: 10152, partner: 'Haske Mata Development Circle (example)' },
      { role: 'opp_report', workflow_id: 10519, opportunity_id: 10153, partner: 'B (example)' },
    ]);
  });

  it('reads both live render_source shapes, and neither the deployed nor the stored one', () => {
    expect(followedTemplateWorkflow({ source: 'template_workflow', template_workflow: 11281, version: 1, draft: false })).toBe(11281);
    expect(followedTemplateWorkflow({ workflow: 11281, program_id: 10157 })).toBe(11281);
    expect(followedTemplateWorkflow({ source: 'template', template: 'indicator_programme_report' })).toBeNull();
    expect(followedTemplateWorkflow({ source: 'stored', version: 2 })).toBeNull();
  });

  it('cascadeOf / the patch round-trip through the run_state path', () => {
    const rs = { phases: { 'synthetic-data-and-workflows': { products: { synthetic: { cascade: KADUNA } } } } };
    expect(cascadeOf(rs)).toBe(KADUNA);
    const block = { home: { program_id: 10157 }, state: 'frozen' as const, reports: [], updated_at: 'x' };
    const patched = reportTemplatesPatch(block);
    expect(recordedBlock(patched)).toEqual(block);
  });
});

describe('followRunReports — runs follow the ACE templates during build', () => {
  it('points every report at its template, recording the published version; per-report config is not sent', async () => {
    const labs = fakeLabs();
    const block = await followRunReports(labs.call, KADUNA, CFG, () => new Date('2026-10-16T12:00:00Z'));
    expect(block.state).toBe('following');
    expect(block.reports.map((r) => [r.workflow_id, r.template_workflow_id, r.followed_version])).toEqual([
      [10512, 11281, 1],
      [10514, 11284, 1],
      [10517, 11287, 2],
      [10519, 11287, 2],
    ]);
    const follows = labs.calls.filter((c) => c.tool === 'workflow_follow_template');
    expect(follows[0].args).toEqual({ workflow_id: 10512, program_id: 10152, template_workflow_id: 11281, template_program_id: 10157, follow: true });
    expect(follows[2].args).toMatchObject({ workflow_id: 10517, opportunity_id: 10152 });
    // A follow only points the page; the follower's own config keys stay its own (labs `overrides`).
    expect(follows.every((c) => !('config' in c.args))).toBe(true);
  });

  it('is idempotent: a report already following is recorded, not re-followed', async () => {
    const labs = fakeLabs();
    await followRunReports(labs.call, KADUNA, CFG);
    const n = labs.calls.filter((c) => c.tool === 'workflow_follow_template').length;
    const again = await followRunReports(labs.call, KADUNA, CFG);
    expect(labs.calls.filter((c) => c.tool === 'workflow_follow_template').length).toBe(n);
    expect(again.state).toBe('following');
  });

  it('skips (and says why) a workflow of the wrong type rather than mis-pointing it', async () => {
    const labs = fakeLabs();
    const block = await followRunReports(labs.call, { ...KADUNA, worker_review: { workflow_id: 10517 } }, CFG);
    expect(block.reports[1]).toMatchObject({ role: 'worker_review', state: 'skipped', reason: expect.stringMatching(/indicator_opp_report, not indicator_worker_review/) });
    expect(block.state).toBe('partial');
  });
});

describe('freezeRunReports — run end forks every report off its template', () => {
  it('forks each following report and records the version it kept', async () => {
    const labs = fakeLabs();
    const following = await followRunReports(labs.call, KADUNA, CFG);
    const frozen = await freezeRunReports(labs.call, KADUNA, CFG, following, () => new Date('2026-10-16T13:00:00Z'));
    expect(frozen.state).toBe('frozen');
    expect(frozen.reports.map((r) => [r.workflow_id, r.state, r.frozen_version, r.followed_version])).toEqual([
      [10512, 'frozen', 1, 1],
      [10514, 'frozen', 1, 1],
      [10517, 'frozen', 2, 2],
      [10519, 'frozen', 2, 2],
    ]);
    const forks = labs.calls.filter((c) => c.tool === 'workflow_follow_template' && c.args.follow === false);
    expect(forks.map((c) => c.args.workflow_id)).toEqual([10512, 10514, 10517, 10519]);
    for (const w of [10512, 10514, 10517, 10519]) expect(labs.rs.get(w)).toEqual({ source: 'stored', version: 2 });
  });

  it('is idempotent: a second freeze keeps the first record (a re-read could no longer tell the version)', async () => {
    const labs = fakeLabs();
    await followRunReports(labs.call, KADUNA, CFG);
    const first = await freezeRunReports(labs.call, KADUNA, CFG);
    const before = labs.calls.length;
    const second = await freezeRunReports(labs.call, KADUNA, CFG, first);
    expect(second.reports).toEqual(first.reports);
    expect(labs.calls.slice(before).some((c) => c.tool === 'workflow_follow_template')).toBe(false);
  });

  it('a publish racing the fork marks the version uncertain instead of guessing', async () => {
    const labs = fakeLabs({ publishDuringFork: true });
    await followRunReports(labs.call, { ...KADUNA, opp_reports: [KADUNA.opp_reports[0]] }, CFG);
    const frozen = await freezeRunReports(labs.call, { ...KADUNA, opp_reports: [KADUNA.opp_reports[0]] }, CFG);
    expect(frozen.reports.find((r) => r.workflow_id === 10517)).toMatchObject({ frozen_version: 2, frozen_version_uncertain: true });
  });

  it('never re-points a report that is not on an ACE template (a pre-2026-10-16 run)', async () => {
    const labs = fakeLabs();
    const frozen = await freezeRunReports(labs.call, KADUNA, CFG);
    expect(frozen.reports.every((r) => r.state === 'skipped')).toBe(true);
    expect(labs.calls.some((c) => c.tool === 'workflow_follow_template')).toBe(false);
  });

  it('refollowArgs is the one call that puts a frozen report back on its template', () => {
    expect(refollowArgs({ role: 'opp_report', workflow_id: 10517, opportunity_id: 10152, template_workflow_id: 11287, state: 'frozen' }, CFG)).toEqual({
      workflow_id: 10517,
      opportunity_id: 10152,
      template_workflow_id: 11287,
      template_program_id: 10157,
      follow: true,
    });
  });

  it('checkTemplates reports a healthy set', async () => {
    const h = await checkTemplates(fakeLabs().call, CFG);
    expect(h.every((x) => x.ok)).toBe(true);
  });
});

describe('the draft cycle (DDD write path)', () => {
  it('draftPreviewUrl adds template_draft=1 once, keeping run_id and the hash', () => {
    const u = 'https://labs.connect.dimagi.com/labs/workflow/10517/run/?run_id=11175&opportunity_id=10152';
    expect(draftPreviewUrl(u)).toBe(`${u}&template_draft=1`);
    expect(draftPreviewUrl(draftPreviewUrl(u))).toBe(`${u}&template_draft=1`);
    expect(draftPreviewUrl('https://x/labs/workflow/1/run/')).toBe('https://x/labs/workflow/1/run/?template_draft=1');
    expect(draftPreviewUrl('https://x/run/?a=1&template_draft=0#tab')).toBe('https://x/run/?a=1&template_draft=1#tab');
  });

  it('publishDecision: publish iff no affected cell regressed; nothing re-judged → discard', () => {
    expect(publishDecision({ '6::visual_polish': 2 }, { '6::visual_polish': 3 }).decision).toBe('publish');
    expect(publishDecision({ '6::visual_polish': 3 }, { '6::visual_polish': 3 })).toMatchObject({ decision: 'publish', unchanged: ['6::visual_polish'] });
    expect(publishDecision({ '6::visual_polish': 3, '5::clarity': 3 }, { '6::visual_polish': 4, '5::clarity': 2 })).toMatchObject({ decision: 'discard', regressed: ['5::clarity'] });
    expect(publishDecision({ '6::visual_polish': 2 }, {})).toMatchObject({ decision: 'discard', reason: expect.stringMatching(/no affected cell/) });
  });

  it('beginDraft: ready on a clean draft; busy while another run holds it; reclaims an abandoned one', async () => {
    const now = () => new Date('2026-10-16T12:00:00Z');
    expect(await beginDraft(fakeLabs().call, CFG, 'indicator_opp_report', now)).toMatchObject({ status: 'ready', revision: 1, published_version: 2 });
    const held = fakeLabs({ draft: { 11287: { revision: 4, differs: true, updated_at: '2026-10-16T11:30:00Z' } } });
    expect(await beginDraft(held.call, CFG, 'indicator_opp_report', now)).toMatchObject({ status: 'busy', revision: 4 });
    const abandoned = fakeLabs({ draft: { 11287: { revision: 4, differs: true, updated_at: '2026-10-16T08:00:00Z' } } });
    const r = await beginDraft(abandoned.call, CFG, 'indicator_opp_report', now);
    expect(r).toMatchObject({ status: 'ready', reclaimed: true, revision: 5 });
    expect(abandoned.draft[11287]).toMatchObject({ differs: false, code: 'PUBLISHED 11287' });
  });

  it('two runs that both saw a clean draft cannot both write it (expected_revision)', async () => {
    const labs = fakeLabs();
    const a = await beginDraft(labs.call, CFG, 'indicator_opp_report');
    const b = await beginDraft(labs.call, CFG, 'indicator_opp_report');
    await labs.call('workflow_template_update_draft', { template_workflow_id: 11287, program_id: 10157, expected_revision: a.revision, render_code: 'A' });
    await expect(labs.call('workflow_template_update_draft', { template_workflow_id: 11287, program_id: 10157, expected_revision: b.revision, render_code: 'B' })).rejects.toThrow(/REVISION_CONFLICT/);
  });

  it('discardDraft resets the render to the published version; publishDraft is revision-guarded and needs a note', async () => {
    const labs = fakeLabs();
    await labs.call('workflow_template_update_draft', { template_workflow_id: 11287, program_id: 10157, expected_revision: 1, render_code: 'EDIT' });
    expect(labs.draft[11287].differs).toBe(true);
    await discardDraft(labs.call, CFG, 'indicator_opp_report');
    expect(labs.draft[11287]).toMatchObject({ differs: false, code: 'PUBLISHED 11287' });
    await expect(publishDraft(labs.call, CFG, 11287, 99, 'x')).rejects.toThrow(/REVISION_CONFLICT/);
    await expect(publishDraft(labs.call, CFG, 11287, labs.draft[11287].revision, '  ')).rejects.toThrow(/note/);
    expect(await publishDraft(labs.call, CFG, 11287, labs.draft[11287].revision, 'drop sub-header')).toEqual({ published_version: 3 });
  });

  it('templateIdFor refuses a template workflow that is not ACE\'s', () => {
    expect(templateIdFor(CFG, 'indicator_worker_review')).toBe(11284);
    expect(templateIdFor(CFG, '11281')).toBe(11281);
    expect(() => templateIdFor(CFG, 5456)).toThrow(/not one of ACE's/);
  });
});

describe('labs-rpc', () => {
  it('unwraps the nested content list workflow_template_export returns', () => {
    expect(unwrapToolResult([{ type: 'text', text: '{"code":"x"}' }])).toEqual({ code: 'x' });
    expect(unwrapToolResult({ a: 1 })).toEqual({ a: 1 });
  });
});

describe('the prose wires the deterministic steps', () => {
  const read = (p: string) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  it('demo-data-setup follows at C4/C5; Phase 7 freezes on every ending; the DDD dispatch carries the write path', () => {
    expect(read('skills/demo-data-setup/SKILL.md')).toMatch(/labs-report-templates\.ts" follow/);
    const p7 = read('agents/synthetic-data-and-workflows.md');
    expect(p7).toMatch(/labs-report-templates\.ts" freeze/);
    expect(p7).toMatch(/labs-report-templates\.ts" dispatch-block/);
  });
});

describe('checkTemplates against the captured live responses (test/fixtures/labs-report-templates)', () => {
  const FIX = (n: string) => JSON.parse(fs.readFileSync(new URL(`../fixtures/labs-report-templates/${n}`, import.meta.url), 'utf8'));
  const byId: Record<number, unknown> = { 11281: FIX('template-get-11281.json'), 11284: FIX('template-get-11284.json'), 11287: FIX('template-get-11287.json') };
  const call = async (tool: string, args: any) => {
    if (tool !== 'workflow_template_get') throw new Error(tool);
    if (!byId[args.template_workflow_id]) throw new Error('workflow_template_get: NOT_FOUND');
    return byId[args.template_workflow_id];
  };

  it('the checked-in config passes against what labs actually returned', async () => {
    const h = await checkTemplates(call, loadReportTemplatesConfig());
    expect(h.map((x) => [x.type, x.ok])).toEqual([
      ['indicator_programme_report', true],
      ['indicator_worker_review', true],
      ['indicator_opp_report', true],
    ]);
  });

  it('FAILS when a configured id is a template of another type, or does not exist', async () => {
    const swapped: ReportTemplatesConfig = { ...CFG, templates: { ...CFG.templates, indicator_programme_report: { template_workflow_id: 11287 }, indicator_worker_review: { template_workflow_id: 99999 } } };
    const h = await checkTemplates(call, swapped);
    expect(h.find((x) => x.type === 'indicator_programme_report')).toMatchObject({ ok: false, problems: [expect.stringMatching(/template_type is indicator_opp_report/)] });
    expect(h.find((x) => x.type === 'indicator_worker_review')).toMatchObject({ ok: false, problems: [expect.stringMatching(/cannot read/)] });
  });

  it('a frozen report (captured after the kaduna freeze) reads as not following any template', () => {
    expect(followedTemplateWorkflow(FIX('workflow-get-10517-frozen.json').render_source)).toBeNull();
  });
});

describe('dddDispatchBlock — every write path, this run\'s ids', () => {
  it('names the render templates, the registry, the visits pipeline and the data path; no engine carve-out', () => {
    const text = dddDispatchBlock(CFG, null, { ...KADUNA, registry: { registry_id: 10510, program_id: 10152 }, visits_pipeline_id: 10511 });
    expect(text).toMatch(/programme_report workflow 10512 \(program 10152\) → template 11281/);
    expect(text).toMatch(/Registry 10510 in program 10152 belongs to THIS run only/);
    expect(text).toMatch(/semantic_registry_set_indicator_meta[\s\S]*semantic_registry_validate/);
    expect(text).toMatch(/Visits pipeline 10511[\s\S]*pipeline_update_schema/);
    expect(text).toMatch(/\[DATA\] \/ \[SEED\][\s\S]*run-labs-synthetic-generate/);
    expect(text).toMatch(/relink-rebuilt-history/);
    expect(text).not.toMatch(/a figure Labs does not compute/);
  });
});
