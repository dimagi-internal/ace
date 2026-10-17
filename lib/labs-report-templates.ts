/**
 * ACE's Labs TEMPLATE WORKFLOWS: Phase 7 reports FOLLOW them while a run is
 * live and are FORKED off them (frozen) when Phase 7 ends.
 *
 * ## Why
 *
 * Until 2026-10-16 every Phase 7 report followed the DEPLOYED labs code
 * template (`indicator_programme_report`, `indicator_worker_review`,
 * `indicator_opp_report`), so a page defect could only be fixed by a
 * connect-labs PR + deploy. The DDD loop had no write path to it, and
 * `config/ddd-loop.yaml` pinned every report-page finding out of scope
 * (ace#2337, ace#3115/#3118): `kaduna-graduation/20261015-1411` ended
 * `blocked_out_of_scope` at 2.0/5 with every blocking finding on those pages
 * (connect-labs#2578).
 *
 * Labs template workflows (connect-labs `user_docs/shared-report-templates.md`)
 * keep the render, config defaults and snapshot spec as DATA with draft →
 * preview → publish and numbered versions. ACE owns one per report template
 * (`config/labs-report-templates.yaml`), so a fix is one publish that every
 * live follower shows on its next load.
 *
 * ## Why freeze at run end
 *
 * A follower renders the template's CURRENT published version. Left
 * following, a finished run's page — the one a released or cloned partner
 * demo copies — would change every time a later run's loop publishes a fix,
 * and could regress under a narration that was judged against the old page.
 * `workflow_follow_template(follow=false)` forks: the published render becomes
 * the workflow's stored copy and the page does not change. We record which
 * version was frozen so the page can be traced to the template history, and so
 * `refollowArgs` gives the one call that puts a past run back on the template.
 *
 * Deterministic, so it is code (ace CLAUDE.md "Deterministic mechanics go in
 * code"); `scripts/labs-report-templates.ts` is the CLI.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { LabsCall } from './labs-rpc.js';

export const REPORT_TEMPLATES_CONFIG = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'config',
  'labs-report-templates.yaml',
);

export const PHASE7 = 'synthetic-data-and-workflows';

/** The report roles Phase 7's cascade records, and the labs template type each one is. */
export const ROLE_TEMPLATE_TYPE = {
  programme_report: 'indicator_programme_report',
  worker_review: 'indicator_worker_review',
  opp_report: 'indicator_opp_report',
} as const;
export type ReportRole = keyof typeof ROLE_TEMPLATE_TYPE;

export interface ReportTemplatesConfig {
  home: { program_id: number; label?: string };
  /** template type (labs `template_type`) → its ACE template workflow. */
  templates: Record<string, { template_workflow_id: number }>;
}

type Obj = Record<string, any>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const int = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
};

/** Parse + validate the config. Throws naming the bad key — a silent default would follow nothing. */
export function parseReportTemplatesConfig(text: string): ReportTemplatesConfig {
  const raw = obj(parseYaml(text));
  const home = obj(raw.home);
  const programId = int(home.program_id);
  if (!programId) throw new Error('labs-report-templates: home.program_id must be a positive integer');
  const templates: ReportTemplatesConfig['templates'] = {};
  for (const [type, v] of Object.entries(obj(raw.templates))) {
    const id = int(obj(v).template_workflow_id);
    if (!id) throw new Error(`labs-report-templates: templates.${type}.template_workflow_id must be a positive integer`);
    templates[type] = { template_workflow_id: id };
  }
  for (const type of Object.values(ROLE_TEMPLATE_TYPE)) {
    if (!templates[type]) throw new Error(`labs-report-templates: no template for ${type}`);
  }
  return { home: { program_id: programId, ...(typeof home.label === 'string' ? { label: home.label } : {}) }, templates };
}

export function loadReportTemplatesConfig(file = REPORT_TEMPLATES_CONFIG): ReportTemplatesConfig {
  return parseReportTemplatesConfig(fs.readFileSync(file, 'utf8'));
}

/** Every ACE template workflow id — the ids `/ace:sweep` must never touch. */
export function protectedTemplateIds(cfg: ReportTemplatesConfig): number[] {
  return [cfg.home.program_id, ...Object.values(cfg.templates).map((t) => t.template_workflow_id)];
}

/** One report workflow of a run, with the scope labs reads it under. */
export interface RunReport {
  role: ReportRole;
  workflow_id: number;
  program_id?: number;
  opportunity_id?: number;
  partner?: string;
}

/**
 * The run's report workflows from `products.synthetic.cascade`: the programme
 * report and its worker review (program-owned), then one opp report per
 * partner (opportunity-owned). A role whose id is missing is skipped — a
 * half-built cascade follows what exists.
 */
export function runReports(cascade: unknown): RunReport[] {
  const c = obj(cascade);
  const programId = int(c.program_id) ?? int(obj(c.registry).program_id);
  const out: RunReport[] = [];
  const pr = int(obj(c.programme_report).workflow_id);
  if (pr && programId) out.push({ role: 'programme_report', workflow_id: pr, program_id: programId });
  const wr = int(obj(c.worker_review).workflow_id);
  if (wr && programId) out.push({ role: 'worker_review', workflow_id: wr, program_id: programId });
  for (const r of arr(c.opp_reports).map(obj)) {
    const w = int(r.workflow_id);
    const o = int(r.opportunity_id);
    if (w && o) out.push({ role: 'opp_report', workflow_id: w, opportunity_id: o, ...(typeof r.partner === 'string' ? { partner: r.partner } : {}) });
  }
  return out;
}

/** The cascade block of a parsed run_state.yaml, or null. */
export function cascadeOf(runState: unknown): Obj | null {
  const c = obj(obj(obj(obj(obj(runState).phases)[PHASE7]).products).synthetic).cascade;
  return c && typeof c === 'object' ? (c as Obj) : null;
}

export type ReportTemplateState = 'following' | 'frozen' | 'skipped';

/** One report's line in `products.synthetic.cascade.report_templates.reports`. */
export interface ReportTemplateRecord {
  role: ReportRole;
  workflow_id: number;
  program_id?: number;
  opportunity_id?: number;
  template_workflow_id: number | null;
  state: ReportTemplateState;
  /** Published template version when the report started following. */
  followed_version?: number;
  /** Published template version the fork copied (the page this run keeps). */
  frozen_version?: number;
  /** True when a publish landed between reading the version and forking: the copy is that version or the next. */
  frozen_version_uncertain?: boolean;
  frozen_at?: string;
  /** Why a report was skipped (no template for its type, not ACE-following at freeze, …). */
  reason?: string;
}

export interface ReportTemplatesBlock {
  home: { program_id: number };
  /** `following` while live; `frozen` once every report is forked; `partial` when some are not. */
  state: 'following' | 'frozen' | 'partial';
  reports: ReportTemplateRecord[];
  updated_at: string;
}

const scopeOf = (r: { program_id?: number; opportunity_id?: number }) =>
  r.program_id ? { program_id: r.program_id } : { opportunity_id: r.opportunity_id };

/**
 * Which template workflow a labs `render_source` follows, or null (deployed
 * code template, or a stored copy). Two shapes, both real (2026-10-16):
 * `workflow_get` returns `{source: 'template_workflow', template_workflow: <id>,
 * version, draft}`; `workflow_follow_template` returns `follows: {workflow: <id>,
 * program_id}`. The deployed-template shape is `{source: 'template', template: '<key>'}`.
 */
export function followedTemplateWorkflow(renderSource: unknown): number | null {
  const rs = obj(renderSource);
  return int(rs.template_workflow) ?? int(rs.workflow);
}

/** `want` only when EVERY report reached it — a skipped report is a report not on the template, so `partial`. */
function blockState(reports: ReportTemplateRecord[], want: ReportTemplateState): ReportTemplatesBlock['state'] {
  if (reports.length && reports.every((r) => r.state === want)) return want as ReportTemplatesBlock['state'];
  return 'partial';
}

/**
 * Point every report of the run at its ACE template workflow (follow=true).
 * Idempotent: a report already following its template is recorded, not re-called.
 * A report's own config keys win over the template's defaults (labs keeps them
 * as `overrides`), so per-run config — companion links, coach actions — survives.
 */
export async function followRunReports(
  call: LabsCall,
  cascade: unknown,
  cfg: ReportTemplatesConfig,
  now: () => Date = () => new Date(),
): Promise<ReportTemplatesBlock> {
  const reports: ReportTemplateRecord[] = [];
  for (const r of runReports(cascade)) {
    const type = ROLE_TEMPLATE_TYPE[r.role];
    const tpl = cfg.templates[type]?.template_workflow_id ?? null;
    const base = { role: r.role, workflow_id: r.workflow_id, ...scopeOf(r) };
    const def = obj(await call('workflow_get', { workflow_id: r.workflow_id, ...scopeOf(r), include_render_code: false }));
    if (def.template_type !== type) {
      reports.push({ ...base, template_workflow_id: tpl, state: 'skipped', reason: `workflow is ${def.template_type ?? 'untyped'}, not ${type}` });
      continue;
    }
    if (!tpl) {
      reports.push({ ...base, template_workflow_id: null, state: 'skipped', reason: `no ACE template for ${type}` });
      continue;
    }
    if (followedTemplateWorkflow(def.render_source) === tpl) {
      const t = obj(await call('workflow_template_get', { template_workflow_id: tpl, program_id: cfg.home.program_id }));
      reports.push({ ...base, template_workflow_id: tpl, state: 'following', ...(int(t.published_version) ? { followed_version: int(t.published_version)! } : {}) });
      continue;
    }
    const res = obj(await call('workflow_follow_template', {
      workflow_id: r.workflow_id,
      ...scopeOf(r),
      template_workflow_id: tpl,
      template_program_id: cfg.home.program_id,
      follow: true,
    }));
    if (followedTemplateWorkflow(res.follows) !== tpl) throw new Error(`workflow_follow_template(${r.workflow_id}) did not report following ${tpl}: ${JSON.stringify(res).slice(0, 200)}`);
    reports.push({ ...base, template_workflow_id: tpl, state: 'following', ...(int(res.published_version) ? { followed_version: int(res.published_version)! } : {}) });
  }
  return { home: { program_id: cfg.home.program_id }, state: blockState(reports, 'following'), reports, updated_at: now().toISOString() };
}

/**
 * Fork every report of the run off its ACE template (follow=false), recording
 * the published version each one kept. Run at the end of Phase 7 whatever its
 * terminal status — a stopped run is still released and cloned.
 *
 * Idempotent: a report already forked keeps its prior record (its
 * `frozen_version` is the version it froze at, which a re-read could no longer
 * tell). A report not following an ACE template (built before 2026-10-16, or
 * forked by hand) is recorded `skipped` with the reason — never re-pointed.
 */
export async function freezeRunReports(
  call: LabsCall,
  cascade: unknown,
  cfg: ReportTemplatesConfig,
  prior: ReportTemplatesBlock | null = null,
  now: () => Date = () => new Date(),
): Promise<ReportTemplatesBlock> {
  const priorBy = new Map((prior?.reports ?? []).map((r) => [r.workflow_id, r]));
  const reports: ReportTemplateRecord[] = [];
  for (const r of runReports(cascade)) {
    const type = ROLE_TEMPLATE_TYPE[r.role];
    const tpl = cfg.templates[type]?.template_workflow_id ?? null;
    const base = { role: r.role, workflow_id: r.workflow_id, ...scopeOf(r) };
    const def = obj(await call('workflow_get', { workflow_id: r.workflow_id, ...scopeOf(r), include_render_code: false }));
    const following = followedTemplateWorkflow(def.render_source);
    const was = priorBy.get(r.workflow_id);
    if (!following || following !== tpl) {
      if (was?.state === 'frozen') {
        reports.push(was);
      } else {
        reports.push({
          ...base,
          template_workflow_id: tpl,
          state: 'skipped',
          reason: following ? `follows template workflow ${following}, not ACE's ${tpl}` : 'not following an ACE template workflow (deployed code template or a stored copy) — nothing to freeze',
        });
      }
      continue;
    }
    const read = async () => int(obj(await call('workflow_template_get', { template_workflow_id: tpl, program_id: cfg.home.program_id })).published_version);
    const before = await read();
    await call('workflow_follow_template', { workflow_id: r.workflow_id, ...scopeOf(r), follow: false });
    const after = await read();
    const check = obj(await call('workflow_get', { workflow_id: r.workflow_id, ...scopeOf(r), include_render_code: false }));
    if (followedTemplateWorkflow(check.render_source)) throw new Error(`workflow ${r.workflow_id} still follows a template after follow=false`);
    reports.push({
      ...base,
      template_workflow_id: tpl,
      state: 'frozen',
      ...(before ? { frozen_version: before } : {}),
      ...(before !== after ? { frozen_version_uncertain: true } : {}),
      ...(was?.followed_version ? { followed_version: was.followed_version } : {}),
      frozen_at: now().toISOString(),
    });
  }
  return { home: { program_id: cfg.home.program_id }, state: blockState(reports, 'frozen'), reports, updated_at: now().toISOString() };
}

/**
 * The one `workflow_follow_template` call that puts a frozen report back on its
 * ACE template, so a past run picks up later fixes. Its page then changes on
 * every publish — only do it for a run nobody is relying on as a fixed record.
 */
export function refollowArgs(rec: ReportTemplateRecord, cfg: ReportTemplatesConfig): Record<string, unknown> | null {
  if (!rec.template_workflow_id) return null;
  return {
    workflow_id: rec.workflow_id,
    ...scopeOf(rec),
    template_workflow_id: rec.template_workflow_id,
    template_program_id: cfg.home.program_id,
    follow: true,
  };
}

/** The `update_yaml_file` patch (`merge: 'deep'`) that records the block on the run. */
export function reportTemplatesPatch(block: ReportTemplatesBlock): Obj {
  return { phases: { [PHASE7]: { products: { synthetic: { cascade: { report_templates: block } } } } } };
}

/** The recorded block, if the run has one. */
export function recordedBlock(runState: unknown): ReportTemplatesBlock | null {
  const b = obj(cascadeOf(runState)).report_templates;
  return b && typeof b === 'object' && Array.isArray((b as Obj).reports) ? (b as ReportTemplatesBlock) : null;
}

export interface TemplateHealth {
  type: string;
  template_workflow_id: number;
  ok: boolean;
  problems: string[];
  published_version?: number;
  followers?: number;
  draft_differs?: boolean;
}

/** `ensure`: each configured template exists, is the right type, public, and editable by this identity. */
export async function checkTemplates(call: LabsCall, cfg: ReportTemplatesConfig): Promise<TemplateHealth[]> {
  const out: TemplateHealth[] = [];
  for (const [type, { template_workflow_id: id }] of Object.entries(cfg.templates)) {
    const problems: string[] = [];
    let t: Obj = {};
    try {
      t = obj(await call('workflow_template_get', { template_workflow_id: id, program_id: cfg.home.program_id }));
    } catch (e) {
      problems.push(`cannot read: ${(e as Error).message.slice(0, 160)}`);
    }
    if (Object.keys(t).length) {
      if (t.template_type !== type) problems.push(`template_type is ${t.template_type}, expected ${type}`);
      if (!obj(t.sharing).public) problems.push('not public: runs in other programs cannot follow it');
      if (t.you_can_edit !== true) problems.push('this identity cannot edit it');
    }
    out.push({
      type,
      template_workflow_id: id,
      ok: problems.length === 0,
      problems,
      ...(int(t.published_version) ? { published_version: int(t.published_version)! } : {}),
      ...(Array.isArray(t.followers) ? { followers: t.followers.length } : {}),
      ...(t.draft ? { draft_differs: Boolean(obj(t.draft).differs_from_published) } : {}),
    });
  }
  return out;
}

/** `render_source` of a forked (or hand-edited) workflow: its page is its own stored copy. */
export function isStoredRender(renderSource: unknown): boolean {
  return obj(renderSource).source === 'stored';
}

export interface RenderCopyResult {
  role: ReportRole;
  source_workflow_id: number;
  target_workflow_id: number;
  /** `copied`: the target now renders the source's stored page; `followed`: both follow the ACE template; `kept`: nothing to do. */
  action: 'copied' | 'followed' | 'kept';
  reason?: string;
}

/**
 * Give a CLONE's report the page its source shows (lib/clone-run.ts § Labs).
 *
 * The clone re-creates each report from the labs code template
 * (`workflow_create_from_template` / `benchmarks_create_opp_reports`), so it
 * follows the DEPLOYED code and would show whatever connect-labs ships next —
 * not the frozen page the released run was judged on. So, per source report:
 *   - stored copy (frozen, `render_source.source: 'stored'`): fork the target
 *     onto a stored copy (follow the ACE template, then follow=false — the only
 *     fork path with a known version guard) and write the SOURCE's render code
 *     over it with `workflow_update_render_code`; then read it back and compare;
 *   - following an ACE template (a live run cloned before its freeze): follow
 *     the same template, so the copy keeps tracking it until it is frozen too;
 *   - following the deployed code template (a run built before 2026-10-16):
 *     nothing — the copy already follows the same code.
 */
export async function copyReportRenders(
  call: LabsCall,
  pairs: Array<{ source: RunReport; target: RunReport }>,
  cfg: ReportTemplatesConfig,
): Promise<RenderCopyResult[]> {
  const out: RenderCopyResult[] = [];
  for (const { source, target } of pairs) {
    const base = { role: source.role, source_workflow_id: source.workflow_id, target_workflow_id: target.workflow_id };
    const src = obj(await call('workflow_get', { workflow_id: source.workflow_id, ...scopeOf(source), include_render_code: true }));
    const tpl = cfg.templates[ROLE_TEMPLATE_TYPE[source.role]]?.template_workflow_id ?? null;
    const following = followedTemplateWorkflow(src.render_source);
    if (following) {
      await call('workflow_follow_template', { workflow_id: target.workflow_id, ...scopeOf(target), template_workflow_id: following, template_program_id: cfg.home.program_id, follow: true });
      out.push({ ...base, action: 'followed', reason: `source follows template workflow ${following}` });
      continue;
    }
    if (!isStoredRender(src.render_source)) {
      out.push({ ...base, action: 'kept', reason: 'source follows the deployed code template; so does the copy' });
      continue;
    }
    const code = src.render_code;
    if (typeof code !== 'string' || !code) throw new Error(`source workflow ${source.workflow_id} has a stored render but workflow_get returned no render_code`);
    let tgt = obj(await call('workflow_get', { workflow_id: target.workflow_id, ...scopeOf(target), include_render_code: true }));
    if (tgt.render_code === code && isStoredRender(tgt.render_source)) {
      out.push({ ...base, action: 'kept', reason: 'target already carries the source page' });
      continue;
    }
    if (!isStoredRender(tgt.render_source)) {
      if (!tpl) throw new Error(`no ACE template for ${ROLE_TEMPLATE_TYPE[source.role]} to fork ${target.workflow_id} through`);
      if (!followedTemplateWorkflow(tgt.render_source)) {
        await call('workflow_follow_template', { workflow_id: target.workflow_id, ...scopeOf(target), template_workflow_id: tpl, template_program_id: cfg.home.program_id, follow: true });
      }
      await call('workflow_follow_template', { workflow_id: target.workflow_id, ...scopeOf(target), follow: false });
      tgt = obj(await call('workflow_get', { workflow_id: target.workflow_id, ...scopeOf(target), include_render_code: false }));
    }
    const version = int(tgt.render_code_version);
    if (!version) throw new Error(`target workflow ${target.workflow_id} reports no render_code_version`);
    await call('workflow_update_render_code', { workflow_id: target.workflow_id, ...scopeOf(target), component_code: code, expected_version: version });
    const check = obj(await call('workflow_get', { workflow_id: target.workflow_id, ...scopeOf(target), include_render_code: true }));
    if (check.render_code !== code) throw new Error(`target workflow ${target.workflow_id}: render code differs from the source after the copy`);
    out.push({ ...base, action: 'copied' });
  }
  return out;
}

/**
 * A run's `report_templates` names the ACE template HOME program and template
 * ids, which a clone must not remap (they are not the run's objects) and which
 * `remapSyntheticProducts` would otherwise report as leftover source ids. The
 * clone records its own block instead (`copyReportRenders`).
 */
export function withoutReportTemplates(synthetic: Record<string, unknown>): Record<string, unknown> {
  const cascade = obj(synthetic.cascade);
  if (!('report_templates' in cascade)) return synthetic;
  const { report_templates: _drop, ...rest } = cascade;
  void _drop;
  return { ...synthetic, cascade: rest };
}

/**
 * The source run's reports paired with the clone's, through the clone's id map
 * (source labs id → clone id; one integer space). A report whose workflow or
 * scope has no counterpart is left out — the copy step that should have made
 * it reports its own failure.
 */
export function pairCloneReports(sourceCascade: unknown, idMap: Record<string, number>): Array<{ source: RunReport; target: RunReport }> {
  const out: Array<{ source: RunReport; target: RunReport }> = [];
  for (const s of runReports(sourceCascade)) {
    const w = idMap[String(s.workflow_id)];
    const scope = s.program_id ? { program_id: idMap[String(s.program_id)] } : { opportunity_id: idMap[String(s.opportunity_id)] };
    if (!w || !(scope.program_id || scope.opportunity_id)) continue;
    out.push({ source: s, target: { role: s.role, workflow_id: w, ...(scope.program_id ? { program_id: scope.program_id } : { opportunity_id: scope.opportunity_id! }) } });
  }
  return out;
}

/** The clone's own `report_templates` block, from what `copyReportRenders` did. */
export function cloneReportTemplatesBlock(
  sourceBlock: ReportTemplatesBlock | null,
  pairs: Array<{ source: RunReport; target: RunReport }>,
  results: RenderCopyResult[],
  cfg: ReportTemplatesConfig,
  now: () => Date = () => new Date(),
): ReportTemplatesBlock {
  const srcBy = new Map((sourceBlock?.reports ?? []).map((r) => [r.workflow_id, r]));
  const resBy = new Map(results.map((r) => [r.source_workflow_id, r]));
  const reports: ReportTemplateRecord[] = pairs.map(({ source, target }) => {
    const res = resBy.get(source.workflow_id);
    const was = srcBy.get(source.workflow_id);
    const tpl = cfg.templates[ROLE_TEMPLATE_TYPE[source.role]]?.template_workflow_id ?? null;
    const base = { role: target.role, workflow_id: target.workflow_id, ...scopeOf(target), template_workflow_id: tpl };
    if (res?.action === 'followed') return { ...base, state: 'following' as const };
    if (res?.action === 'copied' || (res?.action === 'kept' && was?.state === 'frozen')) {
      return {
        ...base,
        state: 'frozen' as const,
        ...(was?.frozen_version ? { frozen_version: was.frozen_version } : {}),
        frozen_at: now().toISOString(),
        reason: `page copied from source workflow ${source.workflow_id}`,
      };
    }
    return { ...base, state: 'skipped' as const, reason: res?.reason ?? 'no render copy recorded' };
  });
  return { home: { program_id: cfg.home.program_id }, state: blockState(reports, 'frozen'), reports, updated_at: now().toISOString() };
}

/**
 * The block Phase 7 pastes into the `canopy:ddd` dispatch prompt: which page
 * follows which ACE template, and the exact draft → preview → publish/discard
 * procedure. Generated (not hand-copied into the prompt) so the ids, home
 * program and commands are this run's and this config's, every time.
 */
export function dddDispatchBlock(cfg: ReportTemplatesConfig, block: ReportTemplatesBlock | null, cascade: unknown): string {
  const reports = block?.reports.length ? block.reports : runReports(cascade).map((r) => ({ ...r, template_workflow_id: cfg.templates[ROLE_TEMPLATE_TYPE[r.role]]?.template_workflow_id ?? null, state: 'following' as const }));
  const live = reports.filter((r) => r.state === 'following');
  const H = cfg.home.program_id;
  const CLI = 'node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/labs-report-templates.ts"';
  const lines = [
    '## Report pages are IN scope — fix them in ACE\'s template workflows',
    '',
    'The labs report pages this demo films FOLLOW ACE\'s Labs template workflows (config/labs-report-templates.yaml).',
    'A page finding — layout, labels, what is shown or hidden, chart scaling, legends, hints — is fixed in the',
    'TEMPLATE, here, in this loop: there is no repo, PR, CI or deploy. A publish IS the deploy (live on the next',
    'page load). If canopy asks for a fix sha, record `template <id> v<published version>`.',
    '',
    'Still OUT of scope (config/ddd-loop.yaml fixed surfaces): Labs chrome (the "Ask an agent" launcher, the run',
    'page shell, the opportunity picker) → Connect Labs; a figure Labs does not compute (needs the snapshot',
    'builder / an engine change) → connect-labs; the semantic registry\'s own labels and indicator names → ACE.',
    '',
    `Pages → templates (template home: program ${H}):`,
    ...live.map((r) => `- ${r.role} workflow ${r.workflow_id} (${r.program_id ? `program ${r.program_id}` : `opportunity ${r.opportunity_id}`}) → template ${r.template_workflow_id} (${ROLE_TEMPLATE_TYPE[r.role]})`),
    ...(live.length ? [] : ['- (none following — this run\'s pages are frozen or on the deployed code template: page findings are NOT fixable here; route them as before)']),
    '',
    'Per batch of page findings, one template at a time:',
    `1. Take the draft: \`${CLI} draft-begin --template <type>\` → \`ready\` with a \`revision\`, or \`busy\` (exit 3: another`,
    '   run holds the draft — leave the finding for the next pass; never wait or poll).',
    `2. Read the draft (\`workflow_template_get({template_workflow_id, program_id: ${H}, include_code: true})\`), then edit it with`,
    `   \`workflow_template_update_draft({template_workflow_id, program_id: ${H}, expected_revision: <revision>, edits: [{old, new}]})\`.`,
    '   RENDER ONLY — never `config`, `config_replace` or `snapshot_inputs` (they reach every follower and cannot be',
    '   discarded). Each update returns the next revision: chain it. Only Tailwind classes the deployed CSS already',
    '   has (`scripts/check-render-code-utilities.ts`). A rule keyed on one programme\'s label or record is not a fix.',
    '3. Before EVERY edit, re-read the locked narration claims for that page (ledger below); never make one false.',
    '4. Prove it on THIS run\'s page before anyone else sees it — for each scene the edit can reach:',
    `   \`${CLI} draft-capture --no-draft --url <scene url> --out before.png [--click "<tab>"]\` and the same without`,
    '   `--no-draft` → after.png (the draft preview, as the ACE identity). Judge both with `canopy:visual-judge` on the',
    '   finding\'s dimension and rubric; write `{"<scene>::<dimension>": <score>}` to before.json / after.json.',
    `5. \`${CLI} draft-decide --before before.json --after after.json\`:`,
    `   - publish (exit 0) → \`${CLI} draft-publish --template <type> --expected-revision <last revision> --note "<what> (<opp>/<run>, finding <id>)"\`;`,
    `   - discard (exit 3) → \`${CLI} draft-discard --template <type>\`, and leave the finding open.`,
    '   Never end a batch with the draft dirty: publish or discard.',
    '6. The next ddd-run pass re-films as after any product batch. If it regresses a cell the publish touched, roll',
    `   back: \`workflow_template_rollback({template_workflow_id, program_id: ${H}, to_version: <the version before>, reset_draft: true})\`.`,
  ];
  return lines.join('\n') + '\n';
}
