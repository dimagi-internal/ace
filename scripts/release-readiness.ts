#!/usr/bin/env npx tsx
/**
 * release-readiness — the evidence-gathering, verdict and release-plan half of
 * `skills/validate-release-readiness`, and
 * the gate + plan reader `skills/release-run` (`/ace:release`) uses.
 *
 * Reviewer/flag arguments shared by `memberships`, `assess` and `gate`:
 *   --reviewers "a@x.org[:viewer|editor],…"   (required for READY)
 *   [--forward-source] [--allow-cross-workspace-forward] [--allow-shared connect]
 *
 *   inventory --run-folder <drive id> --out <inventory.json>
 *       Walk the run folder with the Drive service account: every file's path +
 *       modifiedTime, and the TEXT of every QA result, eval verdict and chatbot
 *       transcript (the files the verdict reads).
 *
 *   links --workspace W --opp O --run R --out <links.json>
 *       Read the run's outputs from ace-web (`GET …/opps/<opp>?run_id=<run>`),
 *       then load each one headlessly with the session its host needs
 *       (`scripts/browser-sessions.ts`) — anonymously for anything the summary
 *       presents as public (the run summary page, the chatbot's public chat) —
 *       and judge the landing with `screenPage` (login page, 404, maintenance,
 *       blank). Drive documents are left to run-surface-audit, which probes the
 *       summary's own links anonymously.
 *
 *   memberships --run-state <yaml> --reviewers … [--allow-shared connect] [--current <json>] --out <json>
 *       The memberships each reviewer WILL hold once the release plan has run
 *       (lib/release-plan.ts projectedMemberships) — passed to
 *       audit-run-surface.ts --memberships for the per-reviewer audit.
 *
 *   drive-access --surface <audit json> --out <json>
 *       For every Drive document the review page links to, read its sharing
 *       with the service account (permissions.list): open to anyone with the
 *       link, or not. Feeds the plan's `drive_share` actions.
 *
 *   assess --workspace W --opp O --run R --inventory <json> --run-state <yaml>
 *          --reviewers … [flags] [--tenancy <json>] [--drive-access <json>]
 *          [--gaps <json>] [--postcondition <json>] [--links <json>]
 *          [--surface <audit json>] [--claims <json>] [--looks <json>]
 *          [--hq-plan <commcare_get_subscription json for the run's HQ space>]
 *          [--overlay <json {"<run path>": "<local file>"}>]
 *          [--read-only] --out-dir <dir>
 *       Turn the evidence into findings (lib/release-readiness.ts), build the
 *       release plan (lib/release-plan.ts), and write
 *       `release-readiness_verdict.yaml` + `release-readiness_report.md` in
 *       <dir>. Missing evidence is a BLOCKER of its own ("not checked"), never
 *       a pass. The tenancy is read from ace-web when --tenancy is absent.
 *
 *   plan-show --verdict <yaml>        the grant table + every email, for approval
 *   plan-actions --verdict <yaml>     the plan's actions as JSON, in order
 *   email-body --verdict <yaml> --to <email> --accept-link <url> --out <body.txt> --subject-out <subj.txt>
 *       The planned email with the ace-web accept link filled in — the only
 *       substitution a release makes.
 *
 *   postcondition --run-state <yaml> --opportunity <json> --payment-units <json> --invites <json> --out <json>
 *       Package connect_get_opportunity / connect_list_payment_units /
 *       connect_list_flw_invites (saved JSON) with what Phase 4 decided
 *       (`decidedFromRunState`) for `assess --postcondition`.
 *
 *   gate --workspace W --opp O --run R --verdict <yaml> --inventory <json> --run-state <yaml> --reviewers … [flags]
 *       `/ace:release`'s gate: exit 0 iff the latest verdict is a READY
 *       release-readiness verdict, for this run, not read-only, newer than
 *       every write in the run folder, over the same run_state, with an
 *       untampered plan for exactly these reviewers and flags.
 *
 *   hq-flip-steps (--domain D | --run-state <yaml>)
 *       Print the HQ superuser step (set the space to "Test or Demo Project")
 *       for the run's HQ space — the exact URL and clicks the operator does in
 *       /ace:release Step 0.4. Same text as the `hq-plan-free` blocker's fix.
 */
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { google } from '../lib/google-shim.js';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';
import { authForUrl, screenPage, withLabsProgramContext, type PreviewAuth } from '../lib/preview-capture.js';
import {
  assessApps,
  assessHqPlan,
  assessChatbot,
  assessGates,
  assessLinks,
  assessPostcondition,
  assessPreviews,
  assessSurfaceAudit,
  buildReleaseVerdict,
  decidedFromRunState,
  releaseGate,
  renderReleaseReport,
  RELEASE_REPORT_NAME,
  RELEASE_VERDICT_NAME,
  assessPlan,
  type LinkProbe,
  type ReleaseFinding,
  type ReleaseVerdict,
  type RunFile,
} from '../lib/release-readiness.js';
import {
  buildReleasePlan,
  emailBody,
  parseReviewers,
  projectedMemberships,
  renderPlan,
  runStateHash,
  type DriveDocAccess,
  type ReleaseOptions,
  type Tenancy,
} from '../lib/release-plan.js';
import { driveFileId } from '../lib/preview-capture.js';
import { DELIVERABLE_HOSTS } from '../lib/run-surface-audit.js';
import { hqDomainFromRunState, hqEnterpriseFlipSteps } from '../lib/hq-enterprise-flip.js';
import { Sessions } from './browser-sessions.js';

// Before any credential read (ACE_WEB_*, ACE_HQ_*, GOOGLE_APPLICATION_CREDENTIALS) — ace#1957.
loadPluginEnv(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [, , cmd, ...args] = process.argv;
const arg = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (n: string) => args.includes(`--${n}`);
function need(n: string): string {
  const v = arg(n);
  if (!v) {
    process.stderr.write(`release-readiness: missing --${n}\n`);
    process.exit(2);
  }
  return v as string;
}
const readJson = <T>(p?: string): T | null => (p && fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as T) : null);

function keyFile(): string {
  const env = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (env && fs.existsSync(env)) return env;
  const data = resolvePluginDataDir(import.meta.url);
  const p = data ? path.join(data, 'gws-sa-key.json') : '';
  if (p && fs.existsSync(p)) return p;
  throw new Error('no Drive service-account key (gws-sa-key.json) — run /ace:setup');
}

const TEXT_WANTED = /-qa_result(?:-[a-z0-9]+)?\.ya?ml$|-eval_verdict(?:-[a-z]+)?\.ya?ml$|ocs-chatbot-qa_transcript[^/]*\.md$|release-readiness_verdict\.yaml$/;

function options(): ReleaseOptions {
  const shared = arg('allow-shared');
  if (shared !== undefined && shared !== 'connect') throw new Error('--allow-shared takes only "connect"');
  return {
    forward_source: flag('forward-source'),
    allow_cross_workspace_forward: flag('allow-cross-workspace-forward'),
    allow_shared_connect: shared === 'connect',
  };
}

async function tenancyFor(ws: string, opp: string): Promise<Tenancy | null> {
  const local = readJson<Tenancy & { tenancy?: Tenancy }>(arg('tenancy'));
  if (local) return local.tenancy ?? local;
  const base = process.env.ACE_WEB_BASE_URL;
  const token = process.env.ACE_WEB_PAT_TOKEN;
  if (!base || !token) return null;
  const r = await fetch(`${base.replace(/\/+$/, '')}/api/w/${ws}/opps/${opp}/tenancy`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!r.ok) return null;
  const body = (await r.json()) as { tenancy?: Tenancy };
  return body.tenancy ?? null;
}

async function inventory(): Promise<void> {
  const auth = new google.auth.GoogleAuth({ keyFile: keyFile(), scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  const drive = google.drive({ version: 'v3', auth });
  const files: RunFile[] = [];
  async function walk(folder: string, prefix: string): Promise<void> {
    let pageToken: string | undefined;
    do {
      const r = await drive.files.list({
        q: `'${folder}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id,name,mimeType,modifiedTime)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageSize: 200,
        pageToken,
      });
      for (const f of r.data.files ?? []) {
        const p = prefix ? `${prefix}/${f.name}` : (f.name as string);
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          await walk(f.id as string, p);
          continue;
        }
        const rf: RunFile = { path: p, modifiedTime: f.modifiedTime ?? '', mimeType: f.mimeType ?? undefined };
        if (TEXT_WANTED.test(p)) {
          try {
            const res =
              f.mimeType === 'application/vnd.google-apps.document'
                ? await drive.files.export({ fileId: f.id as string, mimeType: 'text/plain' }, { responseType: 'text' })
                : await drive.files.get({ fileId: f.id as string, alt: 'media', supportsAllDrives: true }, { responseType: 'text' });
            rf.text = String(res.data).replace(/^﻿/, '');
          } catch (e) {
            process.stderr.write(`inventory: could not read ${p}: ${(e as Error).message}\n`);
          }
        }
        files.push(rf);
      }
      pageToken = r.data.nextPageToken ?? undefined;
    } while (pageToken);
  }
  await walk(need('run-folder'), '');
  fs.writeFileSync(need('out'), JSON.stringify(files, null, 1));
  process.stdout.write(JSON.stringify({ files: files.length, with_text: files.filter((f) => f.text).length }) + '\n');
}

interface Product {
  key?: string;
  phase?: string;
  kind?: string;
  title?: string;
  url?: string | null;
  file_id?: string | null;
  producer?: string | null;
}

async function links(): Promise<void> {
  const base = process.env.ACE_WEB_BASE_URL;
  const token = process.env.ACE_WEB_PAT_TOKEN;
  if (!base || !token) throw new Error('ACE_WEB_BASE_URL and ACE_WEB_PAT_TOKEN are required');
  const ws = need('workspace');
  const opp = need('opp');
  const run = need('run');
  const snapRes = await fetch(`${base.replace(/\/+$/, '')}/api/w/${ws}/opps/${opp}?run_id=${encodeURIComponent(run)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!snapRes.ok) throw new Error(`ace-web snapshot HTTP ${snapRes.status}`);
  const snap = (await snapRes.json()) as { current_run?: { run_id?: string; products?: Product[] } };
  if (snap.current_run?.run_id !== run) throw new Error(`ace-web served run ${snap.current_run?.run_id}, not ${run} (it falls back to the latest run for an unknown id)`);

  const runStatePath = arg('run-state');
  const runState = runStatePath ? (parseYaml(fs.readFileSync(runStatePath, 'utf8')) as Record<string, unknown>) : {};
  const probes: Array<Omit<LinkProbe, 'ok' | 'status' | 'final_url' | 'detail' | 'session'> & { auth: PreviewAuth }> = [];
  // The public summary — run_state's pointer, else the URL the orchestrator gives reviewers.
  const summary =
    (runState as { ace_web_summary_url?: string }).ace_web_summary_url ||
    `${base.replace(/\/+$/, '')}/opps/${ws}/${opp}/runs/${run}/summary`;
  if (summary) probes.push({ label: 'public run summary', url: summary, audience: 'public', auth: 'public', owner: 'ace-orchestrator' });
  for (const p of snap.current_run?.products ?? []) {
    if (!p.url || p.kind === 'document' || p.kind === 'deck' || p.kind === 'sheet') continue; // Drive docs → run-surface-audit
    const auth = authForUrl(p.url);
    if (auth === 'google') continue;
    const label = `${p.phase}:${p.key}`;
    const owner = p.producer ?? p.phase ?? 'unknown';
    if (p.kind === 'chatbot') {
      const node = ((runState.phases as Record<string, { products?: { ocs_chatbot?: { public_url?: string } } }> | undefined)?.['ocs-setup']?.products?.ocs_chatbot) ?? {};
      if (node.public_url) probes.push({ label: `${label} (public chat)`, url: node.public_url, audience: 'public', auth: 'public', owner: 'ocs-agent-setup' });
      continue; // the admin console is not for a partner
    }
    const url = p.kind === 'solicitation'
      ? withLabsProgramContext(p.url, ((runState.phases as Record<string, { products?: { solicitation?: Record<string, unknown> } }> | undefined)?.['solicitation-management']?.products?.solicitation) ?? null)
      : p.url;
    probes.push({ label, url, audience: 'member', auth, owner });
  }

  const browser = await chromium.launch({ headless: true });
  const sessions = new Sessions(browser, path.dirname(need('out')));
  const out: LinkProbe[] = [];
  try {
    for (const p of probes) {
      let probe: LinkProbe;
      try {
        const ctx = await sessions.context(p.auth);
        const page = await ctx.newPage();
        const res = await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        await page.waitForTimeout(1_500);
        const text = ((await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')) as string).replace(/\s+/g, ' ');
        let screen = screenPage({ status: res?.status() ?? 0, finalUrl: page.url(), title: await page.title().catch(() => ''), text });
        // A fresh public chat is short by nature (a greeting); what proves it works is a chat box.
        if (/public chat/.test(p.label)) {
          const hasInput = (await page.locator('input[name=message], textarea[name=message]').count()) > 0;
          screen = hasInput ? { ok: true } : { ok: false, reason: 'blank', detail: 'no chat input on the public chat page' };
        }
        probe = { ...p, session: p.auth, ok: screen.ok, status: res?.status() ?? 0, final_url: page.url(), detail: screen.ok ? 'loads' : `${screen.reason}: ${screen.detail}` };
        await page.close();
      } catch (e) {
        probe = { ...p, session: p.auth, ok: false, status: 0, final_url: '', detail: `could not load: ${(e as Error).message.split('\n')[0]}` };
      }
      const { auth: _a, ...rest } = probe as LinkProbe & { auth?: unknown };
      void _a;
      out.push(rest);
      process.stderr.write(`[release-readiness] ${probe.ok ? 'ok  ' : 'FAIL'} ${probe.label} ${probe.detail}\n`);
    }
  } finally {
    await sessions.close();
    await browser.close();
  }
  fs.writeFileSync(need('out'), JSON.stringify(out, null, 1));
  process.stdout.write(JSON.stringify({ probed: out.length, failed: out.filter((p) => !p.ok).length }) + '\n');
}

function catalog(): { qaSkills: Set<string>; evalSkills: Set<string> } {
  const dirs = fs.readdirSync(path.join(ROOT, 'skills'));
  return {
    qaSkills: new Set(dirs.filter((d) => d.endsWith('-qa')).map((d) => d.slice(0, -3))),
    evalSkills: new Set(dirs.filter((d) => d.endsWith('-eval')).map((d) => d.slice(0, -5))),
  };
}

async function assess(): Promise<void> {
  const inv = readJson<RunFile[]>(need('inventory')) ?? [];
  const runState = parseYaml(fs.readFileSync(need('run-state'), 'utf8'));
  const now = new Date().toISOString();
  // --overlay {"<run path>": "<local file>"}: gate results re-run in a READ-ONLY
  // pass (written locally, not to Drive) count as if written now.
  const overlay = readJson<Record<string, string>>(arg('overlay')) ?? {};
  const files: RunFile[] = [
    ...inv.filter((f) => !(f.path in overlay)),
    ...Object.entries(overlay).map(([p, local]) => ({ path: p, modifiedTime: now, text: fs.readFileSync(local, 'utf8') })),
  ];
  const findings: ReleaseFinding[] = [];
  findings.push(...assessGates(files, runState, catalog()));
  const pc = readJson<{ read: never; decided: never }>(arg('postcondition'));
  findings.push(...assessPostcondition(pc?.read ?? null, pc?.decided ?? null));
  const gaps = readJson<{ outputs?: unknown[] }>(arg('gaps'));
  findings.push(...assessPreviews(gaps ? ((gaps.outputs ?? []) as never[]) : null, readJson(arg('looks')) ?? []));
  findings.push(...assessLinks(readJson<LinkProbe[]>(arg('links'))));
  // The release plan: who gets what, every Drive share, every email.
  const reviewers = parseReviewers(arg('reviewers'));
  const tenancy = await tenancyFor(need('workspace'), need('opp'));
  const { plan, problems } = buildReleasePlan({
    workspace: need('workspace'),
    opp: need('opp'),
    runId: need('run'),
    reviewers,
    runState,
    tenancy,
    driveDocs: readJson<DriveDocAccess[]>(arg('drive-access')),
    options: options(),
    aceWebBase: process.env.ACE_WEB_BASE_URL ?? 'https://labs.connect.dimagi.com/ace',
  });
  findings.push(...assessPlan(problems));
  const plannedDriveIds = new Set(plan.actions.filter((a) => a.kind === 'drive_share').map((a) => a.target));
  findings.push(...assessSurfaceAudit(readJson(arg('surface')), readJson(arg('claims')), { plannedDriveIds }));
  const transcripts = files.filter((f) => /ocs-chatbot-qa_transcript[^/]*\.md$/.test(f.path)).sort((a, b) => Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime));
  findings.push(...assessChatbot(transcripts[0] ?? null, now));
  findings.push(...assessApps(files, runState));
  findings.push(...assessHqPlan(hqDomainFromRunState(runState), readJson(arg('hq-plan'))));
  const verdict = buildReleaseVerdict({
    workspace: need('workspace'), opp: need('opp'), runId: need('run'), checkedAt: now, files, findings, readOnly: flag('read-only'),
    reviewers, runStateHash: runStateHash(fs.readFileSync(need('run-state'), 'utf8')), plan,
  });
  const dir = need('out-dir');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, RELEASE_VERDICT_NAME), stringifyYaml(verdict, { lineWidth: 0 }));
  fs.writeFileSync(path.join(dir, RELEASE_REPORT_NAME), renderReleaseReport(verdict, verdict.release_plan ? renderPlan(verdict.release_plan) : undefined));
  process.stdout.write(JSON.stringify({ verdict: verdict.verdict, counts: verdict.counts, dir }) + '\n');
}

/** Turn the three Connect read-backs (saved JSON) + run_state into the post-condition input. */
function postcondition(): void {
  const runState = parseYaml(fs.readFileSync(need('run-state'), 'utf8'));
  const opp = readJson<Record<string, unknown>>(arg('opportunity'));
  const pus = readJson<{ payment_units?: unknown[] } | unknown[]>(arg('payment-units'));
  const inv = readJson<{ match?: unknown }>(arg('invites'));
  const read = {
    opportunity: opp,
    paymentUnits: pus ? (Array.isArray(pus) ? pus : (pus.payment_units ?? null)) : null,
    testUserInvite: inv ? { match: inv.match ?? null } : null,
  };
  fs.writeFileSync(need('out'), JSON.stringify({ read, decided: decidedFromRunState(runState) }, null, 1));
  process.stdout.write(JSON.stringify({ ok: true }) + '\n');
}

function loadVerdict(): Partial<ReleaseVerdict> | null {
  const verdictPath = arg('verdict');
  return verdictPath && fs.existsSync(verdictPath) ? (parseYaml(fs.readFileSync(verdictPath, 'utf8')) as Partial<ReleaseVerdict>) : null;
}

function readyPlan() {
  const v = loadVerdict();
  if (!v?.release_plan || v.verdict !== 'READY') throw new Error('the verdict carries no release plan (not READY) — run /ace:validate-release-readiness');
  return v.release_plan;
}

function memberships(): void {
  const runState = parseYaml(fs.readFileSync(need('run-state'), 'utf8'));
  const out = projectedMemberships(parseReviewers(arg('reviewers')), runState, options().allow_shared_connect, readJson(arg('current')) ?? {});
  fs.writeFileSync(need('out'), JSON.stringify(out, null, 1));
  process.stdout.write(JSON.stringify({ reviewers: Object.keys(out.hq ?? {}).length }) + '\n');
}

async function driveAccess(): Promise<void> {
  const surface = readJson<{ links?: Array<{ url: string; label?: string }> }>(need('surface'));
  const docs = (surface?.links ?? []).filter((l) => {
    try {
      return (DELIVERABLE_HOSTS as readonly string[]).some((h) => new URL(l.url).hostname.endsWith(h));
    } catch {
      return false;
    }
  });
  const auth = new google.auth.GoogleAuth({ keyFile: keyFile(), scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  const drive = google.drive({ version: 'v3', auth });
  const out: DriveDocAccess[] = [];
  const seen = new Set<string>();
  for (const d of docs) {
    const id = driveFileId(d.url);
    if (!id) {
      out.push({ file_id: d.url, url: d.url, label: d.label, anyone_role: null, error: 'no Drive file id in the URL' });
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const meta = await drive.files.get({ fileId: id, fields: 'name', supportsAllDrives: true });
      const perms = await drive.permissions.list({ fileId: id, fields: 'permissions(type,role)', supportsAllDrives: true });
      const anyone = (perms.data.permissions ?? []).find((p: { type?: string | null }) => p.type === 'anyone');
      out.push({ file_id: id, url: d.url, label: d.label, title: meta.data.name ?? undefined, anyone_role: (anyone?.role as DriveDocAccess['anyone_role']) ?? null });
    } catch (e) {
      out.push({ file_id: id, url: d.url, label: d.label, anyone_role: null, error: (e as Error).message.split('\n')[0] });
    }
  }
  fs.writeFileSync(need('out'), JSON.stringify(out, null, 1));
  process.stdout.write(JSON.stringify({ docs: out.length, open: out.filter((d) => d.anyone_role).length, to_share: out.filter((d) => !d.anyone_role && !d.error).length, unread: out.filter((d) => d.error).length }) + '\n');
}

function gate(): void {
  const verdict = loadVerdict();
  const files = readJson<RunFile[]>(need('inventory')) ?? [];
  const r = releaseGate(verdict, {
    workspace: need('workspace'), opp: need('opp'), runId: need('run'), files,
    runStateHash: runStateHash(fs.readFileSync(need('run-state'), 'utf8')),
    reviewers: parseReviewers(arg('reviewers')),
    options: options(),
  });
  process.stdout.write(JSON.stringify(r) + '\n');
  if (!r.ok) process.exit(1);
}

async function main(): Promise<void> {
  if (cmd === 'inventory') return inventory();
  if (cmd === 'links') return links();
  if (cmd === 'assess') return assess();
  if (cmd === 'postcondition') return postcondition();
  if (cmd === 'gate') return gate();
  if (cmd === 'memberships') return memberships();
  if (cmd === 'drive-access') return driveAccess();
  if (cmd === 'plan-show') {
    process.stdout.write(renderPlan(readyPlan()));
    return;
  }
  if (cmd === 'plan-actions') {
    process.stdout.write(JSON.stringify(readyPlan().actions, null, 1) + '\n');
    return;
  }
  if (cmd === 'email-body') {
    const { subject, body } = emailBody(readyPlan(), need('to'), need('accept-link'));
    fs.writeFileSync(need('out'), body);
    fs.writeFileSync(need('subject-out'), subject + '\n');
    process.stdout.write(JSON.stringify({ to: need('to'), subject }) + '\n');
    return;
  }
  if (cmd === 'hq-flip-steps') {
    const domain = arg('domain') ?? hqDomainFromRunState(parseYaml(fs.readFileSync(need('run-state'), 'utf8')));
    if (!domain) throw new Error('hq-flip-steps: no --domain, and run_state records no HQ space for the apps');
    process.stdout.write(hqEnterpriseFlipSteps(domain) + '\n');
    return;
  }
  process.stderr.write('usage: release-readiness.ts inventory|links|memberships|drive-access|assess|postcondition|gate|plan-show|plan-actions|email-body|hq-flip-steps … (see the header)\n');
  process.exit(2);
}

main().catch((e) => {
  process.stderr.write(`release-readiness: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
