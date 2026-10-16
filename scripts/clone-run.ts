/**
 * scripts/clone-run.ts — clone one ACE run into another ace-web workspace,
 * deterministically, idempotently and resumably (dimagi-internal/ace#3021).
 *
 *   npx tsx scripts/clone-run.ts --from <ws> --to <ws> <opp>/<run-id>
 *       [--only <stage,…>] [--redo <stage,…>] [--retry-ambiguous <step,…>]
 *       [--keep-shared connect] [--plan] [--copy-timeout-min 40]
 *   npx tsx scripts/clone-run.ts --from <ws> --to <ws> <opp>/<run-id> --readiness-repair
 *       (validate-release-readiness step 6: asset_refs only, ledgered, no clone stamps)
 *
 * Replaces the agent-driven Steps 2–4 of `skills/clone-to-new-workspace`
 * (which re-dispatched the whole Phase 4 agent and took hours). Step 0 — the
 * operator toggles, verified by `clone-setup-checklist.ts` — stays with the
 * skill and must pass first; this script assumes a verified target tenancy.
 *
 * Stages (lib/clone-run.ts `STAGES`), each recorded under the TARGET
 * run_state's root `clone:` block so a rerun resumes where the last stopped:
 *   ace_web → summary_url → drive_ids → hq → release_summary → connect →
 *   labs → ocs → asset_refs → readme
 *
 * It calls the same backends the MCP atoms use (mcp/connect/backends/*,
 * googleapis with ACE's service account) directly, and applies the tenancy
 * guard's rules itself (`checkTenantWrite`, lib/drive-tenancy-guard.ts
 * `checkDriveWrite`) because hooks/tenancy_guard.py only sees MCP calls. It
 * binds this Claude session to `<to>/<opp>` (enforce) once the copy exists.
 *
 * Every create is look-then-create: a timeout is not a failure, so an
 * ambiguous create is recorded `ambiguous` and the next run LOOKS before it
 * does anything (`lookThenCreate`). Values are transcribed from the source
 * run_state (+ the PDD numbers it recorded, + read-only reads of the source's
 * own Connect objects) — nothing is re-derived (`connectBuildSpec`).
 *
 * Budget: config/clone-budget.json caps each stage that ran and the whole run
 * (ace_web 10 min, connect 3 min, total 20 min, …); a breach is recorded as
 * `clone.budget_breaches` and exits 4.
 *
 * Exit 0 = every stage final, within budget; 4 = every stage final but over
 * budget (`budget_breaches`); 3 = finished with stages not done (listed);
 * 2 = usage / configuration / precondition error.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { google } from '../lib/google-shim.js';
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';
import { checkDriveWrite, googleDriveLookup, readBinding } from '../lib/drive-tenancy-guard.js';
import { generateRunReadme, lloHandoverFromRunState, phaseStatusFromRunState } from '../lib/run-readme.js';
import { APP_RELEASE_SUMMARY } from '../lib/app-release-record.js';
import { hasHqKey, resolveHqKeyRef, saveHqKey } from '../lib/hq-api-key-store.js';
import { resolveEnvSubstitution, ENV_ALLOW } from '../lib/atom-payload-resolver.js';
import { assertAcceptingForSelf, resolveControlledApplicationOrg } from '../lib/connect-orgs.js';
import {
  adoptableTargetConnect,
  checkTenantWrite,
  cloneSourceFromRunState,
  connectBuildSpec,
  connectProductsPatch,
  hqProductsPatch,
  isStage,
  lookThenCreate,
  mapDeliverUnits,
  mapDuIds,
  planStages,
  productsPointAtTarget,
  rebuildLabs,
  rewritePairsFromAssetPlan,
  rewritePairsFromDriveIdPlan,
  rewriteReleaseSummary,
  summaryUrl,
  budgetBreaches,
  parseCloneBudget,
  type AppliedPair,
  type Binding,
  type LabsCopyDeps,
  type LabsCopyState,
  type CloneBlock,
  type ClonedApp,
  type CreateRecord,
  type Stage,
  type StageRecord,
} from '../lib/clone-run.js';
import { remapLabsText } from '../lib/clone-labs-rebuild.js';
import {
  CONTENT_LEDGER_NAME,
  emptyContentLedger,
  extendIdMap,
  parseContentLedger,
  recordMappedRewrite,
  type ContentLedger,
} from '../lib/release-readiness.js';

loadPluginEnv(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GOOGLE_DOC = 'application/vnd.google-apps.document';
const FOLDER = 'application/vnd.google-apps.folder';
const CONNECT_BASE = process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com';
const HQ_BASE = process.env.ACE_HQ_BASE_URL ?? 'https://www.commcarehq.org';

// ── CLI ──────────────────────────────────────────────────────────────

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function list(name: string): string[] {
  return (flag(name) ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}
function die(msg: string, code = 2): never {
  process.stderr.write(`clone-run: ${msg}\n`);
  process.exit(code);
}
const log = (msg: string) => process.stderr.write(`[clone-run ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);

const BOOLEAN_FLAGS = new Set(['--plan', '--readiness-repair']);
const positional: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) { if (!BOOLEAN_FLAGS.has(a)) i++; continue; }
  positional.push(a);
}
const target = positional[0];
const FROM = flag('from') ?? process.env.ACE_WEB_WORKSPACE;
const TO = flag('to');
if (!target || !/^[^/]+\/\d{8}-\d{4}$/.test(target) || !TO || !FROM) {
  die('usage: clone-run.ts --from <ws> --to <ws> <opp>/<run-id> [--only s,…] [--redo s,…] [--retry-ambiguous step,…] [--keep-shared connect] [--plan]');
}
const [OPP, RUN] = target.split('/');
/**
 * `--readiness-repair` — `validate-release-readiness` step 6's link repair
 * (ace#3092 item 2). It is the asset_refs stage again — the same
 * clone-asset-rewrite plan, applied through `rewriteRecorded`, so a repair
 * that is a pure id/URL rewrite lands in `release-readiness_content-ledger.yaml`
 * and never makes a gate stale (one that is NOT pure is not recorded and its
 * gates read stale, as before). Unlike `--redo asset_refs` it leaves the
 * clone's bookkeeping alone: no `clone.asset_refs.at`, no `completed_at`, no
 * `budget_breaches`. That matters — `cloneWriteCutoff` reads those stamps to
 * tell clone-native re-authored files from copies (ace#2730), and moving them
 * forward would let a later plan overwrite native work with source content.
 */
const READINESS_REPAIR = has('readiness-repair');
if (READINESS_REPAIR && (list('only').length || list('redo').length || has('plan'))) die('--readiness-repair runs asset_refs alone; drop --only/--redo/--plan');
const ONLY = READINESS_REPAIR ? ['asset_refs'] : list('only');
const REDO = READINESS_REPAIR ? ['asset_refs'] : list('redo');
for (const s of [...ONLY, ...REDO]) if (!isStage(s)) die(`unknown stage "${s}"`);
const RETRY_AMBIGUOUS = new Set(list('retry-ambiguous'));
const KEEP_SHARED_CONNECT = flag('keep-shared') === 'connect';
const PLAN_ONLY = has('plan');
const COPY_TIMEOUT_MS = Number(flag('copy-timeout-min') ?? 40) * 60_000;

// ── ace-web ──────────────────────────────────────────────────────────

const ACE_WEB = (process.env.ACE_WEB_BASE_URL ?? '').replace(/\/+$/, '');
const PAT = process.env.ACE_WEB_PAT_TOKEN ?? '';
if (!ACE_WEB || !PAT) die('ACE_WEB_BASE_URL and ACE_WEB_PAT_TOKEN are required (/ace:setup)');

async function aceWeb(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${ACE_WEB}${p}`, {
    method,
    headers: { Authorization: `Bearer ${PAT}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}

// ── Drive ────────────────────────────────────────────────────────────

function keyPath(): string {
  const env = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (env && fs.existsSync(env)) return env;
  const dataDir = resolvePluginDataDir(import.meta.url);
  const c = [dataDir ? path.join(dataDir, 'gws-sa-key.json') : '', path.join(os.homedir(), '.claude', 'plugins', 'data', 'ace-ace', 'gws-sa-key.json')];
  const hit = c.find((p) => p && fs.existsSync(p));
  if (!hit) die('GWS service-account key not found (run /ace:setup)');
  return hit;
}
const auth = new google.auth.GoogleAuth({
  keyFile: keyPath(),
  scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/documents'],
});
const drive: any = google.drive({ version: 'v3', auth });
const docsApi: any = (google as any).docs({ version: 'v1', auth });
const lookup = googleDriveLookup(drive);

async function child(parentId: string, name: string, folder?: boolean): Promise<{ id: string; mimeType: string } | null> {
  const esc = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const r = await drive.files.list({
    q: `'${parentId}' in parents and name='${esc}' and trashed=false${folder === undefined ? '' : folder ? ` and mimeType='${FOLDER}'` : ` and mimeType!='${FOLDER}'`}`,
    fields: 'files(id,mimeType)', supportsAllDrives: true, includeItemsFromAllDrives: true, pageSize: 5,
  });
  const f = r.data.files?.[0];
  return f ? { id: f.id, mimeType: f.mimeType } : null;
}

async function readText(fileId: string, mimeType?: string): Promise<string> {
  const mt = mimeType ?? (await drive.files.get({ fileId, fields: 'mimeType', supportsAllDrives: true })).data.mimeType;
  if (mt === GOOGLE_DOC) {
    const r = await drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'text' });
    // Same normalisation update_yaml_file applies to a Doc's export.
    return String(r.data).replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  }
  const r = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'text' });
  return String(r.data);
}

let binding: Binding | null = null;

/** Every Drive write goes through the Drive half of the tenancy guard. */
async function guardDrive(tool: string, args: Record<string, unknown>): Promise<void> {
  const d = await checkDriveWrite(tool, args, binding as any, lookup);
  if (d.allow) return;
  if (binding?.mode === 'warn') { log(`tenancy guard (warn): ${d.problems.join('; ')}`); return; }
  throw new Error(`tenancy guard refused ${tool}: ${d.problems.join('; ')}`);
}

async function writeText(fileId: string, text: string, mimeType: string): Promise<void> {
  await guardDrive('drive_update_file', { fileId });
  await drive.files.update({
    fileId,
    media: { mimeType: mimeType === GOOGLE_DOC ? 'text/plain' : mimeType, body: text },
    fields: 'id', supportsAllDrives: true,
  });
}

// ── Readiness content ledger ─────────────────────────────────────────
//
// drive_ids and asset_refs rewrite copied files ONLY by substituting ids and
// URLs, but each write bumps the file's modifiedTime past the eval graded on
// it — and validate-release-readiness used to read every such eval as stale
// (re-grades, waivers, extra passes). Each pure rewrite is recorded here
// (lib/release-readiness.ts `recordMappedRewrite`, which re-checks purity on
// the before/after text and records nothing otherwise), so readiness dates the
// file to the content it rewrote.

let ledger: ContentLedger | null = null;
let ledgerDirty = false;
/** Run paths rewritten but NOT recorded (not a pure rewrite, or unreadable): their gates read stale. */
const unrecorded: string[] = [];

async function loadLedger(ctx: Ctx): Promise<ContentLedger> {
  if (ledger) return ledger;
  const run = `${TO}/${OPP}/${RUN}`;
  const f = await child(ctx.tgt!.run, CONTENT_LEDGER_NAME, false);
  const parsed = f ? parseContentLedger(await readText(f.id, f.mimeType)) : null;
  // A ledger the ace-web copy carried in from the source belongs to the source.
  ledger = parsed && parsed.run === run ? parsed : emptyContentLedger(run);
  return ledger;
}

async function saveLedger(ctx: Ctx): Promise<void> {
  if (!ledger || !ledgerDirty) return;
  const body = YAML.stringify(ledger, { lineWidth: 0 });
  const f = await child(ctx.tgt!.run, CONTENT_LEDGER_NAME, false);
  if (f) {
    await guardDrive('drive_update_file', { fileId: f.id });
    await drive.files.update({ fileId: f.id, media: { mimeType: 'text/yaml', body }, fields: 'id', supportsAllDrives: true });
  } else {
    await guardDrive('drive_create_file', { parentFolderId: ctx.tgt!.run });
    await drive.files.create({ requestBody: { name: CONTENT_LEDGER_NAME, mimeType: 'text/yaml', parents: [ctx.tgt!.run] }, media: { mimeType: 'text/yaml', body }, fields: 'id', supportsAllDrives: true });
  }
  ledgerDirty = false;
}

async function fileMeta(fileId: string): Promise<{ modifiedTime: string; mimeType: string }> {
  const r = await drive.files.get({ fileId, fields: 'modifiedTime,mimeType', supportsAllDrives: true });
  return { modifiedTime: String(r.data.modifiedTime ?? ''), mimeType: String(r.data.mimeType ?? '') };
}

/**
 * Wrap one rewrite of a run file: read it before, write, read it after, and
 * record the pair of states in the ledger when the change is a pure mapped
 * rewrite. Recording is best-effort — a failed read only means readiness falls
 * back to the timestamp rule for that file, never that the write is lost.
 */
async function rewriteRecorded(ctx: Ctx, path: string | undefined, fileId: string, by: string, write: () => Promise<void>): Promise<void> {
  let before: { modifiedTime: string; text: string } | null = null;
  try {
    const m = await fileMeta(fileId);
    before = { modifiedTime: m.modifiedTime, text: await readText(fileId, m.mimeType) };
  } catch (e) {
    log(`ledger: could not read ${path ?? fileId} before its rewrite (${(e as Error).message}) — not recorded`);
  }
  await write();
  if (!before || !path) {
    if (path) unrecorded.push(path);
    return;
  }
  try {
    const m = await fileMeta(fileId);
    const l = await loadLedger(ctx);
    const next = recordMappedRewrite(l, path, before, { modifiedTime: m.modifiedTime, text: await readText(fileId, m.mimeType) }, by);
    if (next !== l) {
      ledger = next;
      ledgerDirty = true;
    } else {
      unrecorded.push(path);
      log(`ledger: ${path} changed by more than the id map — not recorded (readiness judges it by timestamp)`);
    }
  } catch (e) {
    unrecorded.push(path);
    log(`ledger: could not read ${path} after its rewrite (${(e as Error).message}) — not recorded`);
  }
}

async function extendLedgerMap(ctx: Ctx, pairs: AppliedPair[]): Promise<void> {
  const l = await loadLedger(ctx);
  const next = extendIdMap(l.id_map, pairs);
  if (next.length !== l.id_map.length) {
    ledger = { ...l, id_map: next };
    ledgerDirty = true;
  }
}

// ── Run folders + run_state ──────────────────────────────────────────

async function runFolder(ws: string): Promise<{ root: string; opp: string; run: string } | null> {
  const w = await aceWeb('GET', `/api/workspaces/${ws}`);
  if (w.status !== 200 || !w.json?.drive_root_folder_id) die(`ace-web: workspace ${ws} not readable (${w.status}) — the PAT owner must own it`);
  const root = w.json.drive_root_folder_id as string;
  const opp = await child(root, OPP, true);
  const runs = opp ? await child(opp.id, 'runs', true) : null;
  const run = runs ? await child(runs.id, RUN, true) : null;
  return run && opp ? { root, opp: opp.id, run: run.id } : null;
}

let targetRunStateId: string | null = null;

async function readTargetRunState(): Promise<Record<string, any>> {
  return (YAML.parse(await readText(targetRunStateId!, GOOGLE_DOC)) ?? {}) as Record<string, any>;
}

/** Read-modify-write the TARGET run_state (YAML 1.1-safe, like update_yaml_file). */
async function mutateTargetRunState(fn: (rs: Record<string, any>) => void): Promise<Record<string, any>> {
  const rs = await readTargetRunState();
  fn(rs);
  await guardDrive('update_yaml_file', { fileId: targetRunStateId });
  await drive.files.update({
    fileId: targetRunStateId,
    media: { mimeType: 'text/plain', body: YAML.stringify(rs, { version: '1.1' }) },
    fields: 'id', supportsAllDrives: true,
  });
  return rs;
}

async function saveStage(stage: Stage, rec: StageRecord, extra?: (rs: Record<string, any>) => void): Promise<void> {
  await mutateTargetRunState((rs) => {
    rs.clone = rs.clone ?? {};
    rs.clone[stage] = { ...(rs.clone[stage] ?? {}), ...rec, at: new Date().toISOString() };
    if (rec.status && rec.status !== 'not-done' && rs.clone[stage].reason && !rec.reason) delete rs.clone[stage].reason;
    extra?.(rs);
  });
}

// ── Connect + HQ backends (the ones the MCP atoms use) ───────────────

let backends: Promise<{ connect: any; hq: any; session: any }> | null = null;
function getBackends(): Promise<{ connect: any; hq: any; session: any }> {
  backends ??= (async () => {
    const { PlaywrightSession } = await import('../mcp/connect/auth/playwright-session.js');
    const { RestBackend } = await import('../mcp/connect/backends/rest.js');
    const { PlaywrightBackend } = await import('../mcp/connect/backends/playwright.js');
    const { CompositeBackend } = await import('../mcp/connect/backends/composite.js');
    const { CommCareBackend } = await import('../mcp/connect/backends/commcare.js');
    const session = new PlaywrightSession({
      baseUrl: CONNECT_BASE, cchqBaseUrl: HQ_BASE,
      hqUsername: process.env.ACE_HQ_USERNAME, hqPassword: process.env.ACE_HQ_PASSWORD,
    });
    const ctx = await session.getContext();
    const csrfToken = session.getCsrfToken();
    const rest = new RestBackend({ baseUrl: CONNECT_BASE, csrfToken, request: ctx.request, session } as any);
    const playwright = new PlaywrightBackend({ baseUrl: CONNECT_BASE, csrfToken, request: ctx.request, session } as any);
    const connect = new CompositeBackend({ rest, playwright } as any);
    const hq = new CommCareBackend({ baseUrl: HQ_BASE, session, hqUsername: process.env.ACE_HQ_USERNAME, hqApiKey: process.env.ACE_HQ_API_KEY } as any);
    return { connect, hq, session };
  })();
  return backends;
}

function tenant(call: string, args: Array<{ arg: string; value: string | undefined; fields: string[] }>): void {
  const d = checkTenantWrite(binding, call, args);
  if (d.problems.length && d.allow) log(`tenancy guard (warn): ${d.problems.join('; ')}`);
  if (!d.allow) throw new Error(`tenancy guard refused: ${d.problems.join('; ')}`);
}

// ── Stages ───────────────────────────────────────────────────────────

interface Ctx {
  src: { root: string; opp: string; run: string };
  tgt: { root: string; opp: string; run: string } | null;
  sourceRunState: Record<string, any>;
  source: ReturnType<typeof cloneSourceFromRunState>;
  tenancy: Record<string, string | null | undefined>;
  clone: CloneBlock;
}

async function stageAceWeb(ctx: Ctx): Promise<StageRecord> {
  const listPath = `/api/w/${FROM}/opps/${OPP}/runs/${RUN}/clones`;
  const doneRec = async () => {
    const l = await aceWeb('GET', listPath);
    const mine = (Array.isArray(l.json) ? l.json : []).filter((r: any) => r.target_workspace === TO);
    return { done: mine.find((r: any) => r.status === 'done'), latest: mine[0] };
  };
  let { done, latest } = await doneRec();
  if (!done) {
    if (!latest || latest.status !== 'copying') {
      const r = await aceWeb('POST', `/api/w/${FROM}/opps/${OPP}/runs/${RUN}/clone`, { to_workspace: TO });
      log(`ace-web clone POST → ${r.status}`);
      if (![200, 201, 202, 409, 504].includes(r.status)) return { status: 'not-done', reason: `ace-web clone POST returned ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}` };
    }
    const deadline = Date.now() + COPY_TIMEOUT_MS;
    // ace-web#864: a re-POST over a failed copy RESUMES it (keeps the partial
    // target, skips what was copied), so one transient Drive error costs one
    // re-POST, not the whole copy again. Twice per invocation at most.
    let resumes = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15_000));
      ({ done, latest } = await doneRec());
      if (done) break;
      if (latest?.status === 'error' && resumes < 2) {
        resumes++;
        const r = await aceWeb('POST', `/api/w/${FROM}/opps/${OPP}/runs/${RUN}/clone`, { to_workspace: TO });
        log(`ace-web copy error (${String(latest.error).slice(0, 160)}) — resuming (re-POST ${resumes}) → ${r.status}`);
        continue;
      }
      if (latest?.status === 'error') return { status: 'not-done', reason: `ace-web copy error: ${latest.error}` };
      log(`ace-web copy ${latest?.status ?? '?'}: ${latest?.files_copied ?? 0} files`);
    }
    if (!done) return { status: 'not-done', reason: 'ace-web copy still running at the timeout — rerun to resume' };
  }
  // `files_resumed` (ace-web#864): files a re-POST adopted from the failed attempt instead of re-copying.
  return { status: 'done', clone_id: done.id, files_copied: done.files_copied, files_resumed: done.files_resumed ?? 0 };
}

async function stageSummaryUrl(): Promise<StageRecord> {
  const url = summaryUrl(ACE_WEB, TO!, OPP, RUN);
  await mutateTargetRunState((rs) => { rs.ace_web_summary_url = url; });
  return { status: 'done', url };
}

function runScript(script: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const tsx = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const r = spawnSync(process.execPath, [tsx, path.join(ROOT, 'scripts', script), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 2, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function lastJson(stdout: string): any {
  const i = stdout.indexOf('{');
  try { return i >= 0 ? JSON.parse(stdout.slice(i)) : null; } catch { return null; }
}

async function stageDriveIds(ctx: Ctx): Promise<StageRecord> {
  const base = ['--source', ctx.src.run, '--target', ctx.tgt!.run];
  let r = runScript('clone-drive-readback.ts', base);
  if (r.code === 1) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-readback-'));
    r = runScript('clone-drive-readback.ts', [...base, '--plan', dir]);
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
    await extendLedgerMap(ctx, rewritePairsFromDriveIdPlan(plan));
    for (const f of plan.files ?? []) {
      if (f.action === 'update') {
        await rewriteRecorded(ctx, f.path, f.fileId, 'clone-run:drive_ids', () => writeText(f.fileId, fs.readFileSync(f.localFilePath, 'utf8'), f.mimeType));
      } else if (f.action === 'docs') {
        await rewriteRecorded(ctx, f.path, f.fileId, 'clone-run:drive_ids', async () => {
          await guardDrive('docs_batch_update', { documentId: f.fileId });
          await docsApi.documents.batchUpdate({ documentId: f.fileId, requestBody: { requests: JSON.parse(fs.readFileSync(f.requestsPath, 'utf8')) } });
        });
      }
    }
    await saveLedger(ctx);
    log(`drive_ids: applied ${plan.files?.length ?? 0} rewrite(s)`);
    r = runScript('clone-drive-readback.ts', base);
  }
  if (r.code === 2) return { status: 'not-done', reason: `clone-drive-readback failed: ${r.stderr.slice(-300)}` };
  const rep = lastJson(r.stdout);
  const remaining = rep?.hits?.length ?? 0;
  // A copied comms-log is not repaired here: trashing a file is the operator's
  // call. Not done until it is gone (ace#3027; the copier bug is ace-web#909).
  const commsLogs: Array<{ path: string; fileId: string }> = rep?.comms_logs_copied ?? [];
  if (commsLogs.length) {
    return {
      status: 'not-done',
      source_ids_remaining: remaining,
      comms_logs_copied: commsLogs,
      reason: `${commsLogs.length} comms-log(s) were copied into the clone (each carries the source's thread_id) — trash them, then re-run: ${commsLogs.map((c) => `${c.path} (${c.fileId})`).join(', ')}`,
    };
  }
  return remaining
    ? { status: 'not-done', source_ids_remaining: remaining, reason: `${remaining} copied file(s) still name a source Drive id` }
    : { status: 'done', source_ids_remaining: 0 };
}

async function stageHq(ctx: Ctx): Promise<StageRecord> {
  const hqDomain = ctx.tenancy.hq_domain!;
  const { hq } = await getBackends();
  const sub = await hq.getSubscription({ domain: hqDomain });
  if (!sub.is_paid_edition) {
    return { status: 'not-done', reason: `${hqDomain} reads ${sub.edition} — demo mode is not on (checklist item 1a: scripts/release-readiness.ts hq-flip-steps --domain ${hqDomain})` };
  }
  const prev = (ctx.clone.hq ?? {}) as Record<string, any>;
  const rec: Record<string, any> = { ...prev, domain: hqDomain, plan: { edition: sub.edition, is_paid_edition: true }, api: 'enabled' };
  const save = async () => { await saveStage('hq', { ...rec, status: 'in-progress' }); };
  rec.source = rec.source ?? {};
  const apps: { learn?: ClonedApp; deliver?: ClonedApp } = {};
  for (const kind of ['learn', 'deliver'] as const) {
    const sa = ctx.source.apps[kind];
    if (!sa) return { ...rec, status: 'not-done', reason: `source has no ${kind} app` };
    if (!sa.build_id) return { ...rec, status: 'not-done', reason: `source ${kind} app has no released build recorded — refusing to copy "latest saved" (ace#2702)` };
    rec.source = { ...rec.source, domain: sa.domain, [`${kind}_app_id`]: sa.hq_app_id, [`${kind}_build_id`]: sa.build_id, [`${kind}_version`]: sa.version };
    const copyRec: CreateRecord | undefined = rec[`${kind}_app_id`] ? { status: 'done', id: rec[`${kind}_app_id`] } : rec.copies?.[kind];
    tenant('commcare_linked_app_copy', [{ arg: 'downstream_domain', value: hqDomain, fields: ['hq_domain'] }]);
    const { id: appId, adopted } = await lookThenCreate({
      step: `hq.${kind}.copy`,
      record: copyRec,
      retryAmbiguous: RETRY_AMBIGUOUS.has(`hq.${kind}`),
      look: async () => {
        const { apps: list } = await hq.listApps({ domain: hqDomain });
        if (copyRec?.id) return list.find((a: any) => a.id === copyRec.id) ?? null;
        const named = list.filter((a: any) => a.name === sa.name);
        if (named.length > 1) throw new Error(`hq.${kind}.copy: ${named.length} apps named "${sa.name}" in ${hqDomain} — resolve by hand (record the right id in clone.hq.${kind}_app_id)`);
        return named[0] ?? null;
      },
      create: () => hq.createLinkedAppCopy({ upstream_domain: sa.domain, upstream_app_id: sa.hq_app_id, downstream_domain: hqDomain, name: sa.name, linked: false, build_id: sa.build_id }),
      save: async (r) => { rec.copies = { ...(rec.copies ?? {}), [kind]: r }; if (r.status === 'done') rec[`${kind}_app_id`] = r.id; await save(); },
    });
    log(`hq.${kind}: app ${appId}${adopted ? ' (found, adopted)' : ' (copied)'}`);
    tenant('commcare_make_build', [{ arg: 'domain', value: hqDomain, fields: ['hq_domain'] }]);
    if (!rec[`${kind}_build_id`]) {
      const b = await hq.makeBuild({ domain: hqDomain, app_id: appId, comment: `clone of ${sa.domain}/${sa.hq_app_id} build ${sa.build_id}` });
      rec[`${kind}_build_id`] = b.build_id;
      rec[`${kind}_version`] = b.version;
      await save();
    }
    if (!rec[`${kind}_released_at`]) {
      const r = await hq.releaseBuild({ domain: hqDomain, app_id: appId, build_id: rec[`${kind}_build_id`] });
      if (!r.is_released) return { ...rec, status: 'not-done', reason: `release of ${kind} build ${rec[`${kind}_build_id`]} did not read back released` };
      rec[`${kind}_released_at`] = new Date().toISOString();
      await save();
    }
    apps[kind] = { hq_app_id: appId, build_id: rec[`${kind}_build_id`], version: rec[`${kind}_version`] ?? null, released_at: rec[`${kind}_released_at`] };
  }
  // 3b — the opportunity's key, restricted to THIS space.
  if (KEEP_SHARED_CONNECT) {
    rec.key = { status: 'skipped', reason: '--keep-shared connect: no opportunity uses it' };
  } else {
    const keyName = `ace-clone-${hqDomain}`;
    if (!(rec.key?.ref && hasHqKey(keyName))) {
      const connectBuilt = !!(ctx.clone.connect as any)?.opportunity?.id || ctx.clone.connect?.status === 'done';
      if (rec.key?.ref && connectBuilt) {
        return { ...rec, status: 'not-done', reason: `the local key file for ${rec.key.ref} is missing and the clone's opportunity already uses it — rotating would break it; restore ~/.ace/hq-api-keys/${keyName}.key` };
      }
      tenant('commcare_create_api_key', [{ arg: 'domain', value: hqDomain, fields: ['hq_domain'] }]);
      const created = await hq.createApiKey({ domain: hqDomain, name: keyName, replace_existing: true });
      const ref = saveHqKey(keyName, created.key);
      rec.key = { ref, id: created.id, last4: String(created.key).slice(-4) };
    }
  }
  await mutateTargetRunState((rs) => {
    rs.phases = rs.phases ?? {};
    const cs = (rs.phases['commcare-setup'] = rs.phases['commcare-setup'] ?? {});
    cs.products = cs.products ?? {};
    cs.products.apps = hqProductsPatch(cs.products.apps, hqDomain, apps, HQ_BASE);
  });
  const { copies: _c, ...clean } = rec;
  return { ...clean, status: 'done' };
}

async function stageReleaseSummary(ctx: Ctx): Promise<StageRecord> {
  const rs = await readTargetRunState();
  const hqRec = (rs.clone?.hq ?? {}) as Record<string, any>;
  const prodApps = rs.phases?.['commcare-setup']?.products?.apps ?? {};
  const apps: { learn?: ClonedApp; deliver?: ClonedApp } = {};
  for (const kind of ['learn', 'deliver'] as const) {
    const id = hqRec[`${kind}_app_id`] ?? prodApps[kind]?.hq_app_id;
    const build = hqRec[`${kind}_build_id`] ?? prodApps[kind]?.released_build_id;
    if (!id || !build) return { status: 'not-done', reason: `no cloned ${kind} build recorded yet (stage hq)` };
    apps[kind] = {
      hq_app_id: id,
      build_id: build,
      version: hqRec[`${kind}_version`] ?? prodApps[kind]?.released_version ?? null,
      released_at: hqRec[`${kind}_released_at`] ?? hqRec.released_at ?? rs.clone?.hq?.at ?? new Date().toISOString(),
    };
  }
  const folder = await child(ctx.tgt!.run, '3-commcare', true);
  const file = folder ? await child(folder.id, 'app-release_summary.md', false) : null;
  if (!file) return { status: 'done', reason: 'target run has no 3-commcare/app-release_summary.md' };
  const text = await readText(file.id, file.mimeType);
  const next = rewriteReleaseSummary(text, apps);
  if (next.changed) await writeText(file.id, next.text, file.mimeType);
  return { status: 'done', file_id: file.id, rewritten: next.changed };
}

async function stageConnect(ctx: Ctx): Promise<StageRecord> {
  if (KEEP_SHARED_CONNECT) {
    const c = ctx.source.connect;
    return { status: 'kept-shared', pm_org: c?.pm_org, holding_org: c?.holding_org, opportunity_id: c?.opportunity_id };
  }
  const src = ctx.source.connect;
  if (!src) return { status: 'done', reason: 'source run has no Connect products' };
  const pm = ctx.tenancy.connect_pm_org!;
  const holding = ctx.tenancy.connect_holding_org!;
  const hqDomain = ctx.tenancy.hq_domain!;
  const targetRs = await readTargetRunState();
  const hqRec = (targetRs.clone?.hq ?? {}) as Record<string, any>;
  const learnId = hqRec.learn_app_id;
  const deliverId = hqRec.deliver_app_id;
  if (!learnId || !deliverId) return { status: 'not-done', reason: 'stage hq has not recorded both cloned apps' };
  const keyRef = hqRec.key?.ref;
  if (!keyRef) return { status: 'not-done', reason: 'no space-restricted HQ key recorded (clone.hq.key.ref)' };

  const rec: Record<string, any> = { ...((targetRs.clone?.connect ?? {}) as Record<string, any>), pm_org: pm, holding_org: holding };
  delete rec.reason;
  const save = async () => { await saveStage('connect', { ...rec, status: 'in-progress' }); };
  const adopt = adoptableTargetConnect(targetRs, ctx.tenancy, ctx.source);
  if (adopt) {
    rec.program ??= { status: 'done', id: adopt.program_id };
    rec.opportunity ??= { status: 'done', id: adopt.opportunity_id };
    rec.application ??= { status: 'done', id: adopt.application_id, accepted: true };
    rec.adopted_from_products = true;
  }
  const { connect } = await getBackends();
  const needCreate = rec.program?.status !== 'done' || rec.opportunity?.status !== 'done';

  // Read-only reads of the SOURCE (transcription, not derivation).
  const reads: Parameters<typeof connectBuildSpec>[1] = {};
  if (needCreate) {
    reads.program = await connect.getProgram({ organization_slug: src.pm_org, program_id: src.program_id });
    reads.opportunity = await connect.getOpportunity({ organization_slug: src.holding_org, opportunity_id: src.opportunity_id });
    try {
      const { session } = await getBackends();
      const ctxp = await session.getContext();
      const { extractFormFieldValues, scopeToFormContaining } = await import('../mcp/connect/backends/html-scrape.js');
      const res = await ctxp.request.get(`/a/${src.pm_org}/program/${src.program_id}/opportunity/${src.opportunity_id}/init/edit/`);
      if (res.status() === 200) reads.init_form = extractFormFieldValues(scopeToFormContaining(await res.text(), 'learn_app_passing_score'));
    } catch (e) { log(`source init-edit form unreadable (${(e as Error).message}) — falling back to recorded values`); }
  }
  const srcDus = (await connect.listDeliverUnits({ organization_slug: src.pm_org, opportunity_id: src.opportunity_id })).deliver_units;
  reads.deliver_units = srcDus;
  const spec = connectBuildSpec(ctx.source, reads, { e2ePhone: process.env.ACE_E2E_PHONE });
  const problems = spec.problems.filter((p) => needCreate || !/(program|opportunity)\./.test(p));
  if (problems.length) return { ...rec, status: 'not-done', reason: `cannot transcribe: ${problems.join('; ')}` };
  rec.provenance = spec.provenance;

  // 1. Program, in the PM org.
  tenant('connect_create_program', [{ arg: 'organization_slug', value: pm, fields: ['connect_pm_org', 'connect_holding_org'] }]);
  const program = await lookThenCreate({
    step: 'connect.program', record: rec.program, retryAmbiguous: RETRY_AMBIGUOUS.has('connect.program'),
    look: async () => {
      if (rec.program?.id) return { id: rec.program.id };
      const { programs } = await connect.listPrograms({ organization_slug: pm, name: spec.program.name });
      const hits = programs.filter((x: any) => x.name === spec.program.name);
      if (hits.length > 1) throw new Error(`connect.program: ${hits.length} programs named "${spec.program.name}" in ${pm} — record the right one in clone.connect.program.id`);
      return hits[0] ? { id: hits[0].id } : null;
    },
    create: async () => ({ id: (await connect.createProgram({ organization_slug: pm, ...spec.program })).id }),
    save: async (r) => { rec.program = r; await save(); },
  });
  // opp.yaml carries the program every later run of this opp reuses.
  const oppYaml = await child(ctx.tgt!.opp, 'opp.yaml', false);
  if (oppYaml) {
    const y = (YAML.parse(await readText(oppYaml.id, oppYaml.mimeType)) ?? {}) as Record<string, any>;
    if (y.connect?.program?.id !== program.id) {
      y.connect = { ...(y.connect ?? {}), program: { id: program.id, url: `${CONNECT_BASE}/a/${pm}/program/${program.id}/` } };
      await guardDrive('update_yaml_file', { fileId: oppYaml.id });
      await writeText(oppYaml.id, YAML.stringify(y, { version: '1.1' }), oppYaml.mimeType);
    }
  }

  // 2. Invite + accept the holding org (skipped when the opportunity already exists).
  if (rec.opportunity?.status !== 'done' && !(rec.application?.accepted)) {
    if (holding !== pm) {
      tenant('connect_send_llo_invite', [
        { arg: 'organization_slug', value: pm, fields: ['connect_pm_org', 'connect_holding_org'] },
        { arg: 'organization', value: holding, fields: ['connect_holding_org'] },
      ]);
      const app = await lookThenCreate({
        step: 'connect.application', record: rec.application, retryAmbiguous: RETRY_AMBIGUOUS.has('connect.application'),
        look: async () => {
          if (rec.application?.id) return { id: rec.application.id };
          const { invitations } = await connect.listReceivedInvitations({ organization_slug: holding });
          const hit = invitations.find((i: any) => i.program_id === program.id.toLowerCase());
          return hit ? { id: hit.application_id } : null;
        },
        create: async () => {
          const a = await connect.sendLloInvite({ organization_slug: pm, program_id: program.id, organization: holding });
          return { id: a.program_application_id };
        },
        save: async (r) => { rec.application = { ...(rec.application ?? {}), ...r }; await save(); },
      });
      // AUTHORITY GATE (ace#2954): only an org ACE controls accepts for itself.
      const owner = await resolveControlledApplicationOrg({ program_id: program.id, application_id: app.id }, process.env, async (org) =>
        (await connect.listReceivedInvitations({ organization_slug: org })).invitations,
      ).catch((e: Error) => { throw new Error(`${e.message} — add ${holding} to ACE_CONNECT_CONTROLLED_ORGS if ACE created it (Step 0.6b)`); });
      assertAcceptingForSelf(owner, process.env);
      tenant('connect_accept_program_application', [{ arg: 'organization_slug', value: pm, fields: ['connect_pm_org', 'connect_holding_org'] }]);
      await connect.acceptProgramApplication({ organization_slug: pm, program_id: program.id, application_id: app.id });
      rec.application = { ...rec.application, id: app.id, accepted: true };
      await save();
    }
  }

  // 3. Opportunity, HELD by the NM org (target_organization_slug is create-time only).
  const { assertRunIdNamePrefix } = await import('../mcp/connect/opportunity-name.js');
  const apiKey = resolveEnvSubstitution(resolveHqKeyRef(keyRef), process.env, ENV_ALLOW.hqApiKey);
  tenant('connect_create_opportunity', [
    { arg: 'organization_slug', value: pm, fields: ['connect_pm_org'] },
    { arg: 'target_organization_slug', value: holding, fields: ['connect_holding_org'] },
    { arg: 'learn_app.cc_domain', value: hqDomain, fields: ['hq_domain'] },
    { arg: 'deliver_app.cc_domain', value: hqDomain, fields: ['hq_domain'] },
  ]);
  const opp = await lookThenCreate({
    step: 'connect.opportunity', record: rec.opportunity, retryAmbiguous: RETRY_AMBIGUOUS.has('connect.opportunity'),
    settle: 6,
    look: async () => {
      if (rec.opportunity?.id) return { id: rec.opportunity.id };
      for (const org of [holding, pm]) {
        const { opportunities } = await connect.listOpportunities({ organization_slug: org, name: spec.opportunity.name });
        const hits = opportunities.filter((x: any) => x.name === spec.opportunity.name);
        if (hits.length > 1) throw new Error(`connect.opportunity: ${hits.length} opportunities named "${spec.opportunity.name}" at ${org}`);
        if (hits[0]) return { id: hits[0].id };
      }
      return null;
    },
    create: async () => {
      assertRunIdNamePrefix(spec.opportunity.name, true);
      const o = spec.opportunity;
      const made = await connect.createOpportunity({
        organization_slug: pm, program_id: program.id, name: o.name, short_description: o.short_description,
        description: o.description, target_organization_slug: holding, start_date: o.start_date, end_date: o.end_date,
        total_budget: o.total_budget, is_test: true, auto_activate: false,
        learn_app: { hq_server_url: HQ_BASE, api_key: apiKey, cc_domain: hqDomain, cc_app_id: learnId, description: o.learn_description, passing_score: o.passing_score },
        deliver_app: { hq_server_url: HQ_BASE, api_key: apiKey, cc_domain: hqDomain, cc_app_id: deliverId },
      });
      if (made.organization_slug && made.organization_slug !== holding) {
        throw new Error(`connect.opportunity: created under ${made.organization_slug}, not ${holding} — no repair path exists (create-time only); stop and report`);
      }
      rec.connect_int_id = made.int_id ?? null;
      return { id: made.id };
    },
    save: async (r) => { rec.opportunity = r; await save(); },
  });
  log(`connect: program ${program.id}, opportunity ${opp.id}${opp.adopted ? ' (found, adopted)' : ''}`);

  // 4. Payment units (look by name — the scraped listing's name is reliable).
  const tgtDus = (await connect.listDeliverUnits({ organization_slug: pm, opportunity_id: opp.id })).deliver_units;
  const duMap = mapDeliverUnits(srcDus, tgtDus);
  rec.deliver_unit_map = Object.fromEntries(duMap);
  tenant('connect_create_payment_units', [{ arg: 'organization_slug', value: pm, fields: ['connect_pm_org', 'connect_holding_org'] }]);
  const wanted = spec.payment_units.map((u) => ({
    name: u.name, amount: u.amount, ...(u.org_amount !== undefined ? { org_amount: u.org_amount } : {}),
    max_total: u.max_total, max_daily: u.max_daily,
    required_deliver_units: mapDuIds(u.source_required_deliver_units, duMap, `payment unit "${u.name}"`),
  }));
  const existingPus = async () => (await connect.listPaymentUnits({ organization_slug: pm, opportunity_id: opp.id })).payment_units as any[];
  const pus = await lookThenCreate({
    step: 'connect.payment_units', record: rec.payment_units_create, retryAmbiguous: RETRY_AMBIGUOUS.has('connect.payment_units'),
    look: async () => {
      const have = new Set((await existingPus()).map((p) => p.name));
      return wanted.every((w) => have.has(w.name)) ? { id: 'all-present' } : null;
    },
    create: async () => {
      const have = new Set((await existingPus()).map((p) => p.name));
      const missing = wanted.filter((w) => !have.has(w.name));
      const r = await connect.createPaymentUnits({ organization_slug: pm, opportunity_id: opp.id, total_budget: spec.opportunity.total_budget, payment_units: missing });
      rec.payment_units_created = (r.payment_units ?? r) as unknown;
      return { id: 'created' };
    },
    save: async (r) => { rec.payment_units_create = r; await save(); },
  });
  const listed = await existingPus();
  const puRecords = wanted.map((w) => {
    const l = listed.find((p) => p.name === w.name);
    return { payment_unit_id: l?.payment_unit_uuid ?? null, ...w };
  });

  // 5. Verification rules, at the PM org URL (additive + idempotent).
  const v = spec.verification;
  const flags: Record<string, unknown> = {
    form_field_rules: v.form_field_rules.map((r) => ({
      name: r.name, question_path: r.question_path, question_value: r.question_value,
      deliver_unit_id: mapDuIds([r.source_deliver_unit_id], duMap, `rule "${r.name}"`)[0],
    })),
    ...(v.form_submission_start ? { form_submission_start: v.form_submission_start } : {}),
    ...(v.form_submission_end ? { form_submission_end: v.form_submission_end } : {}),
  };
  if (v.durations.length) {
    flags.deliver_unit_checks = v.durations.flatMap((d) =>
      d.source_deliver_unit_id === null
        ? [...new Set(duMap.values())].map((id) => ({ deliver_unit_id: id, duration_minutes: d.duration_minutes }))
        : [{ deliver_unit_id: mapDuIds([d.source_deliver_unit_id], duMap, 'duration')[0], duration_minutes: d.duration_minutes }],
    );
  }
  tenant('connect_set_verification_flags', [{ arg: 'organization_slug', value: pm, fields: ['connect_pm_org', 'connect_holding_org'] }]);
  const vr = await connect.setVerificationFlags({ organization_slug: pm, opportunity_id: opp.id, flags });
  const verification = {
    form_field_rules: flags.form_field_rules,
    form_field_rules_saved: vr.form_field_rules_saved ?? null,
    ...(v.form_submission_start ? { form_submission_start: v.form_submission_start } : {}),
    ...(v.form_submission_end ? { form_submission_end: v.form_submission_end } : {}),
    ...(flags.deliver_unit_checks ? { deliver_unit_checks: vr.deliver_unit_checks ?? flags.deliver_unit_checks } : {}),
  };
  if ((v.form_field_rules.length && !(vr.form_field_rules_saved >= v.form_field_rules.length))) {
    return { ...rec, status: 'not-done', reason: `verification: ${vr.form_field_rules_saved ?? 0} of ${v.form_field_rules.length} rules read back` };
  }

  // 6. Learn passing score (lives on the CommCareApp row; the create may discard it — ace#1350).
  const ps = await connect.getLearnPassingScore({ organization_slug: pm, program_id: program.id, opportunity_id: opp.id });
  if (ps.passing_score !== spec.opportunity.passing_score) {
    tenant('connect_set_learn_passing_score', [{ arg: 'organization_slug', value: pm, fields: ['connect_pm_org', 'connect_holding_org'] }]);
    await connect.setLearnPassingScore({ organization_slug: pm, program_id: program.id, opportunity_id: opp.id, passing_score: spec.opportunity.passing_score });
  }

  // 7. Activate (idempotent), then the ACE test user.
  tenant('connect_activate_opportunity', [{ arg: 'organization_slug', value: pm, fields: ['connect_pm_org', 'connect_holding_org'] }]);
  const act = await connect.activateOpportunity({ organization_slug: pm, opportunity_id: opp.id });
  if (act?.int_id && !rec.connect_int_id) rec.connect_int_id = act.int_id;
  let testUser: Record<string, unknown> | null = null;
  if (spec.test_user_phone) {
    const phone = spec.test_user_phone;
    let m = (await connect.listFlwInvites({ organization_slug: pm, opportunity_id: opp.id, phone })).match;
    if (!m) {
      tenant('connect_send_flw_invite', [{ arg: 'organization_slug', value: pm, fields: ['connect_pm_org', 'connect_holding_org'] }]);
      await connect.sendFlwInvite({ organization_slug: pm, opportunity_id: opp.id, phone_numbers: [phone] });
      for (let i = 0; i < 6 && !m; i++) {
        await new Promise((r) => setTimeout(r, 5_000));
        m = (await connect.listFlwInvites({ organization_slug: pm, opportunity_id: opp.id, phone })).match;
      }
    }
    testUser = { phone, invite_row_present: !!m, connect_user_id: m?.connect_user_id ?? null, status: m?.status ?? 'missing', checked_at: new Date().toISOString() };
    if (!m) return { ...rec, status: 'not-done', reason: `test user ${phone}: no invite row read back` };
  }

  // 8. Read-back at the holding org: the opportunity reads the CLONED apps.
  const got = await connect.getOpportunity({ organization_slug: holding, opportunity_id: opp.id });
  const domains = [got.learn_app?.cc_domain, got.deliver_app?.cc_domain];
  if (domains.some((d) => d !== hqDomain)) {
    return { ...rec, status: 'not-done', reason: `read-back: opportunity apps are in ${domains.join(' / ')} (dashboard_read ${got.dashboard_read}), expected ${hqDomain}` };
  }
  if (!rec.connect_int_id && got.int_id) rec.connect_int_id = got.int_id;
  const products = connectProductsPatch({
    pm_org: pm, holding_org: holding, hq_domain: hqDomain, program_id: program.id,
    application_id: rec.application?.id ?? null, opportunity_id: opp.id, opportunity_name: spec.opportunity.name,
    connect_int_id: rec.connect_int_id ?? null, payment_units: puRecords, verification, test_user: testUser,
  }, CONNECT_BASE);
  await mutateTargetRunState((rs) => {
    const cs = (rs.phases['connect-setup'] = rs.phases['connect-setup'] ?? {});
    cs.products = { connect: products };
    cs.status = 'done';
    cs.clone_note = `Rebuilt by scripts/clone-run.ts from ${FROM}/${OPP}/${RUN} with the source's recorded values (ace#3021).`;
  });
  return {
    status: 'done', pm_org: pm, holding_org: holding, program_id: program.id, opportunity_id: opp.id,
    application_id: rec.application?.id ?? null, connect_int_id: rec.connect_int_id ?? null,
    payment_units: puRecords.length, payment_units_found: pus.adopted, provenance: rec.provenance,
    adopted_from_products: rec.adopted_from_products ?? false,
  };
}

// ── Labs (§ 4c, scripted) ────────────────────────────────────────────

const LABS_MCP_URL = process.env.LABS_MCP_URL ?? 'https://labs.connect.dimagi.com/mcp/';

/** One labs MCP `tools/call` over HTTP JSON-RPC — the same endpoint the MCP atoms use. */
async function labsCall(tool: string, args: Record<string, unknown>): Promise<any> {
  const token = process.env.LABS_MCP_TOKEN;
  if (!token) throw new Error('LABS_MCP_TOKEN is not set (/ace:labs-token-mint)');
  const res = await fetch(LABS_MCP_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${tool}: labs HTTP ${res.status}: ${body.slice(0, 200)}`);
  const rpc = parseLabsRpc(body);
  if (rpc.error) throw new Error(`${tool}: ${JSON.stringify(rpc.error).slice(0, 300)}`);
  const text = rpc.result?.content?.[0]?.text ?? '';
  if (rpc.result?.isError) throw new Error(`${tool}: ${String(text).slice(0, 400)}`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${tool}: non-JSON result: ${String(text).slice(0, 200)}`);
  }
}

function parseLabsRpc(body: string): any {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const data = trimmed.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  if (!data.length) throw new Error(`unrecognised labs response: ${trimmed.slice(0, 200)}`);
  return JSON.parse(data[data.length - 1]);
}

async function stageLabs(ctx: Ctx): Promise<StageRecord> {
  const deps: LabsCopyDeps | undefined = process.env.LABS_MCP_TOKEN
    ? {
        call: labsCall,
        log,
        retryAmbiguous: RETRY_AMBIGUOUS,
        save: (state) => saveStage('labs', { status: 'in-progress', copy: state }),
        workspace: async (programId, llos) => {
          const r = runScript('labs-workspace-setup.ts', ['--program-id', String(programId), ...llos.flatMap((l) => ['--llo', l])]);
          const out = lastJson(r.stdout);
          return { ok: r.code === 0, llos: Array.isArray(out?.llos) ? out.llos : [], detail: r.code === 0 ? 'listed' : (r.stderr || r.stdout).trim().slice(-300) };
        },
      }
    : undefined;
  const rec = await rebuildLabs({
    source: ctx.source, sourceRunState: ctx.sourceRunState, targetRunState: await readTargetRunState(),
    to: TO!, opp: OPP, run: RUN, tenancy: ctx.tenancy, keepSharedConnect: KEEP_SHARED_CONNECT, deps,
  });
  const { synthetic, ...record } = rec as StageRecord & { synthetic?: unknown };
  if (record.status !== 'done' || !synthetic) return record;
  // The target's products name the copy — and so does its copied prose (ace#3038).
  await mutateTargetRunState((rs) => {
    rs.phases ??= {};
    rs.phases['synthetic-data-and-workflows'] ??= {};
    rs.phases['synthetic-data-and-workflows'].products ??= {};
    rs.phases['synthetic-data-and-workflows'].products.synthetic = synthetic;
  });
  const idMap = Object.fromEntries(Object.entries((record.copy as LabsCopyState).id_map).map(([k, v]) => [Number(k), v]));
  await extendLedgerMap(ctx, Object.entries(idMap).map(([from, to]) => ({ from: String(from), to: String(to), kind: 'labs_id' })));
  const phase7 = await child(ctx.tgt!.run, '7-synthetic', true);
  const prose: Array<{ path: string; bare: number[] }> = [];
  if (phase7) {
    const r = await drive.files.list({ q: `'${phase7.id}' in parents and trashed=false`, fields: 'files(id,name,mimeType)', supportsAllDrives: true, includeItemsFromAllDrives: true, pageSize: 200 });
    for (const f of r.data.files ?? []) {
      if (!/\.(md|ya?ml|json|txt)$/i.test(f.name) && f.mimeType !== GOOGLE_DOC) continue;
      if (/-qa_result|-eval_verdict/.test(f.name)) continue; // grades judged the source; left as they are
      const text = await readText(f.id, f.mimeType);
      const rw = remapLabsText(text, idMap);
      if (!rw.changes) continue;
      const mime = f.mimeType === GOOGLE_DOC ? GOOGLE_DOC : f.mimeType;
      await rewriteRecorded(ctx, `7-synthetic/${f.name}`, f.id, 'clone-run:labs', () => writeText(f.id, rw.text, mime));
      prose.push({ path: `7-synthetic/${f.name}`, bare: rw.bare });
    }
  }
  await saveLedger(ctx);
  return { ...record, prose_rewritten: prose.map((p) => p.path), prose_bare_ids: prose.filter((p) => p.bare.length) };
}

/** Who the ledger says made the rewrite: the clone, or a readiness repair. */
const ASSET_REFS_BY = READINESS_REPAIR ? 'validate-release-readiness:repair' : 'clone-run:asset_refs';

async function stageAssetRefs(ctx: Ctx): Promise<StageRecord> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-assets-'));
  const args = ['--source', ctx.src.run, '--target', ctx.tgt!.run, '--out', dir, '--to', TO!];
  let r = runScript('clone-asset-rewrite.ts', args);
  if (r.code === 2) return { status: 'not-done', reason: `clone-asset-rewrite failed: ${r.stderr.slice(-300)}` };
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  // The map this stage applies, recorded BEFORE the writes so each one is
  // checked against it (asset_refs writes the id/URL map it applied).
  await extendLedgerMap(ctx, rewritePairsFromAssetPlan(plan));
  let applied = 0;
  for (const f of plan.files ?? []) {
    if (f.action === 'update') {
      await rewriteRecorded(ctx, f.path, f.fileId, ASSET_REFS_BY, () => writeText(f.fileId, fs.readFileSync(f.localFilePath, 'utf8'), f.mimeType));
    } else if (f.action === 'render') {
      // A styled Doc is re-imported from markdown, never written back as text (ace#2606).
      await rewriteRecorded(ctx, f.path, f.fileId, ASSET_REFS_BY, async () => {
        await guardDrive('drive_update_file', { fileId: f.fileId });
        await drive.files.update({ fileId: f.fileId, media: { mimeType: 'text/markdown', body: fs.readFileSync(f.localFilePath, 'utf8') }, fields: 'id', supportsAllDrives: true });
        if (f.reembed_screenshots) {
          const folders = (plan.frames?.preview_folders ?? []).flatMap((p: any) => ['--screenshots', p.id]);
          if (folders.length) {
            await guardDrive('docs_batch_update', { documentId: f.fileId });
            const e = runScript('embed-doc-screenshots.ts', [f.fileId, ...folders]);
            if (e.code !== 0) log(`embed-doc-screenshots ${f.path}: exit ${e.code} ${e.stderr.slice(-200)}`);
          }
        }
      });
    }
    applied++;
  }
  await saveLedger(ctx);
  if (plan.run_state) {
    const patch = JSON.parse(fs.readFileSync(plan.run_state.localFilePath, 'utf8'));
    await mutateTargetRunState((rs) => deepMergeInto(rs, patch));
    applied++;
  }
  r = runScript('clone-asset-rewrite.ts', ['--source', ctx.src.run, '--target', ctx.tgt!.run, '--out', fs.mkdtempSync(path.join(os.tmpdir(), 'clone-assets-rb-')), '--to', TO!]);
  const rb = lastJson(r.stdout);
  const left = (plan.left_on_source ?? []).map((x: any) => x.path);
  if (r.code !== 0 || (rb?.changes ?? 1) !== 0) {
    return { status: 'not-done', applied, reason: `read-back: ${rb?.changes ?? '?'} change(s) still pending, exit ${r.code} (frames_foreign: ${(rb?.frames_foreign ?? []).length})`, left_on_source: left };
  }
  return { status: 'done', files: applied, left_on_source: left, frames_repointed: Object.keys(plan.frames?.repointed ?? {}).length, unrecorded: [...unrecorded] };
}

/** update_yaml_file `deep`: objects merge recursively, arrays and scalars replace. */
function deepMergeInto(base: Record<string, any>, patch: Record<string, any>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) deepMergeInto(base[k], v);
    else base[k] = v;
  }
}

async function stageReadme(ctx: Ctx): Promise<StageRecord> {
  const rs = await readTargetRunState();
  const md = generateRunReadme(RUN, phaseStatusFromRunState(rs), { lloHandover: lloHandoverFromRunState(rs) });
  await guardDrive('render_run_readme', { runFolderFileId: ctx.tgt!.run });
  const existing = await child(ctx.tgt!.run, 'README.md', false);
  if (existing) {
    await drive.files.update({ fileId: existing.id, media: { mimeType: 'text/plain', body: md }, fields: 'id', supportsAllDrives: true });
  } else {
    await drive.files.create({ requestBody: { name: 'README.md', mimeType: GOOGLE_DOC, parents: [ctx.tgt!.run] }, media: { mimeType: 'text/plain', body: md }, fields: 'id', supportsAllDrives: true });
  }
  return { status: 'done' };
}

// ── Main ─────────────────────────────────────────────────────────────

function loadBudget() {
  const p = path.join(ROOT, 'config', 'clone-budget.json');
  return parseCloneBudget(fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {});
}

async function bindSession(tenancy: Record<string, unknown>, driveRoot: string): Promise<void> {
  const sessionBind = readBinding();
  if (sessionBind && (sessionBind.workspace !== TO || sessionBind.opp !== OPP)) {
    die(`this session is bound to ${sessionBind.workspace}/${sessionBind.opp}; the clone writes into ${TO}/${OPP}. Never rebind to get a write through — bin/ace-bind --clear only if that binding is stale.`);
  }
  if (!sessionBind && process.env.CLAUDE_CODE_SESSION_ID) {
    const r = spawnSync(path.join(ROOT, 'bin', 'ace-bind'), [`${TO}/${OPP}`], { encoding: 'utf8' });
    if (r.status !== 0) die(`bin/ace-bind ${TO}/${OPP} failed: ${r.stderr}`);
    log(r.stdout.trim());
  }
  const b = readBinding();
  binding = b
    ? ({ ...(b as any), tenancy: (b as any).tenancy ?? tenancy } as Binding)
    : { workspace: TO!, opp: OPP, mode: 'enforce', tenancy: tenancy as any, drive_root_folder_id: driveRoot };
}

async function main(): Promise<number> {
  const t0 = Date.now();
  const src = await runFolder(FROM!);
  if (!src) die(`source run ${FROM}/${OPP}/${RUN} not found in Drive`);
  const srcRs = await child(src.run, 'run_state.yaml', false);
  if (!srcRs) die('source run has no run_state.yaml');
  const sourceRunState = (YAML.parse(await readText(srcRs.id, srcRs.mimeType)) ?? {}) as Record<string, any>;
  const srcCommcare = await child(src.run, '3-commcare', true);
  const srcSummary = srcCommcare ? await child(srcCommcare.id, 'app-release_summary.md', false) : null;
  const source = cloneSourceFromRunState(sourceRunState, srcSummary ? await readText(srcSummary.id, srcSummary.mimeType) : null);

  const ws = await aceWeb('GET', `/api/workspaces/${TO}`);
  if (ws.status !== 200) die(`ace-web: workspace ${TO} not readable (${ws.status})`);
  const tenancy = (ws.json.default_tenancy ?? {}) as Record<string, string | null>;
  const missing = ['hq_domain', ...(KEEP_SHARED_CONNECT ? [] : ['connect_pm_org', 'connect_holding_org'])].filter((f) => !tenancy[f]);
  if (missing.length) die(`target default_tenancy lacks ${missing.join(', ')} — finish Step 0 first`);
  const srcTen = await aceWeb('GET', `/api/w/${FROM}/opps/${OPP}/tenancy`);
  const shared = Object.entries(tenancy).filter(([k, v]) => v && srcTen.json?.tenancy?.[k] === v && !(KEEP_SHARED_CONNECT && k.startsWith('connect_')));
  if (shared.length) die(`target tenancy shares ${shared.map(([k]) => k).join(', ')} with the source — refusing (Step 1.3)`);

  let tgt = await runFolder(TO!);
  let clone: CloneBlock = {};
  if (tgt) {
    const rsFile = await child(tgt.run, 'run_state.yaml', false);
    if (rsFile) {
      targetRunStateId = rsFile.id;
      clone = ((await readTargetRunState()).clone ?? {}) as CloneBlock;
    }
  }
  const plan = planStages(clone, { only: ONLY as Stage[], redo: REDO as Stage[] });
  const report: Record<string, unknown> = {
    clone: `${FROM}/${OPP}/${RUN} → ${TO}/${OPP}/${RUN}`,
    tenancy,
    source_problems: source.problems,
    plan: plan.map((p) => `${p.stage}: ${p.action} (${p.why})`),
  };
  if (PLAN_ONLY) { console.log(JSON.stringify(report, null, 2)); return 0; }

  const ctx: Ctx = { src, tgt, sourceRunState, source, tenancy, clone };
  if (tgt && targetRunStateId) await bindSession(tenancy, tgt.root);
  const results: Record<string, StageRecord> = {};
  for (const p of plan) {
    if (p.action === 'skip') { results[p.stage] = { status: clone[p.stage]?.status ?? 'skipped', reason: p.why }; continue; }
    if (p.stage !== 'ace_web' && !targetRunStateId) {
      results[p.stage] = { status: 'not-done', reason: 'the ace-web copy has not produced the target run yet' };
      continue;
    }
    const t = Date.now();
    log(`stage ${p.stage} (${p.why})`);
    let rec: StageRecord;
    try {
      switch (p.stage) {
        case 'ace_web': rec = await stageAceWeb(ctx); break;
        case 'summary_url': rec = await stageSummaryUrl(); break;
        case 'drive_ids': rec = await stageDriveIds(ctx); break;
        case 'hq': rec = await stageHq(ctx); break;
        case 'release_summary': rec = await stageReleaseSummary(ctx); break;
        case 'connect': rec = await stageConnect(ctx); break;
        case 'labs': rec = await stageLabs(ctx); break;
        case 'ocs': rec = { status: 'kept', reason: 'public-link', public_url: source.ocs_public_url }; break;
        case 'asset_refs': rec = await stageAssetRefs(ctx); break;
        case 'readme': rec = await stageReadme(ctx); break;
      }
    } catch (e) {
      rec = { status: 'not-done', reason: `${(e as Error).name}: ${(e as Error).message}`.slice(0, 600) };
    }
    rec = { ...rec!, seconds: Math.round((Date.now() - t) / 1000) };
    results[p.stage] = rec;
    log(`stage ${p.stage}: ${rec.status}${rec.reason ? ` — ${rec.reason}` : ''}`);
    if (p.stage === 'ace_web' && rec.status === 'done') {
      tgt = await runFolder(TO!);
      if (!tgt) { results.ace_web = { status: 'not-done', reason: 'ace-web says done but the target run folder is not in Drive' }; break; }
      ctx.tgt = tgt;
      const rsFile = await child(tgt.run, 'run_state.yaml', false);
      targetRunStateId = rsFile?.id ?? null;
      await bindSession(tenancy, tgt.root);
      await saveStage('ace_web', rec, (rs) => { rs.clone.from = { workspace: FROM, opp: OPP, run: RUN }; });
      continue;
    }
    if (targetRunStateId && !READINESS_REPAIR) {
      await saveStage(p.stage, rec, (rs) => { rs.clone.from = rs.clone.from ?? { workspace: FROM, opp: OPP, run: RUN }; });
    }
    if (p.stage === 'ace_web' && rec.status !== 'done') break;
  }
  if (targetRunStateId) {
    const final = await readTargetRunState();
    report.products_check = productsPointAtTarget(final, tenancy, { keepSharedConnect: KEEP_SHARED_CONNECT });
    const notDone = planStages(final.clone).filter((p) => p.action === 'run').map((p) => p.stage);
    report.not_done = notDone;
    if (!notDone.length && !READINESS_REPAIR) await mutateTargetRunState((rs) => { rs.clone.completed_at = new Date().toISOString(); });
  }
  report.results = results;
  report.ocs_public_url = source.ocs_public_url;
  report.summary_url = summaryUrl(ACE_WEB, TO!, OPP, RUN);
  report.seconds = Math.round((Date.now() - t0) / 1000);
  // The guard (config/clone-budget.json): a stage or the run over budget is
  // recorded on the clone and fails the invocation — a slow release path is a
  // defect to look at, not a cost to absorb silently.
  const breaches = budgetBreaches(results, report.seconds as number, loadBudget());
  report.budget_breaches = breaches;
  if (READINESS_REPAIR) {
    // A repair is not a clone: its time is not the clone's budget, and it
    // writes none of the clone's stamps (see READINESS_REPAIR).
    report.readiness_repair = results.asset_refs;
    console.log(JSON.stringify(report, null, 2));
    return results.asset_refs?.status === 'done' ? 0 : 3;
  }
  if (targetRunStateId) {
    await mutateTargetRunState((rs) => {
      rs.clone = rs.clone ?? {};
      rs.clone.budget_breaches = breaches.length ? breaches.map((b) => ({ ...b, at: new Date().toISOString() })) : [];
    }).catch((e) => log(`could not record budget_breaches: ${(e as Error).message}`));
  }
  for (const b of breaches) log(`OVER BUDGET: ${b.stage} took ${b.seconds}s (budget ${b.budget_seconds}s)`);
  console.log(JSON.stringify(report, null, 2));
  const { session } = backends ? await backends : { session: null };
  await session?.close?.().catch(() => {});
  if ((report.not_done as string[] | undefined)?.length || (report.products_check as string[] | undefined)?.length) return 3;
  return breaches.length ? 4 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => { process.stderr.write(`clone-run: ${err?.stack ?? err}\n`); process.exit(2); },
);
