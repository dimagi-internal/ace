#!/usr/bin/env -S npx tsx
/**
 * llo-directory-eoi — one command for "ingest the open EOI and add the orgs that are not in the
 * directory yet" (skills/llo-directory-add § Standing approval: new EOI applicants).
 *
 *   npx tsx scripts/llo-directory-eoi.ts run                       # open rounds: import, list, draft; writes nothing
 *   npx tsx scripts/llo-directory-eoi.ts run --apply               # ... then add them and import again
 *   npx tsx scripts/llo-directory-eoi.ts run --round chp-rfi-2026 --exclude chp-rfi-2026-fr:111
 *
 * What it does, in the order a person did it by hand on 2026-11-19 (about 30 tool calls and a
 * scratch script rewritten twice):
 *   1. `marketplace_import` on labs (the `open_only` / `rounds` arguments, so it is a fraction of the
 *      full import), polled as the job it is. The result lists, per round, the submissions no
 *      organisation could be certain for (`awaiting_verdict`: form, sheet row, name).
 *   2. For each, its row on the round's response sheet (read once per form), drafted into the three
 *      directory rows by `lib/eoi-directory-rows.ts` — the conventions, the join date (the applicant's
 *      own submission), nothing inferred.
 *   3. The batch written by `llo-directory.ts batch-apply` (one pass; `--skip-problem-items`, so a
 *      duplicate or a bad row is reported and the rest still go in).
 *   4. `marketplace_import` again, so the orgs exist on labs, and the unmatched count after.
 *
 * Without `--apply` nothing is written to the directory: the batch file and a report are left in
 * `--out` for a person to read. Whether to run it at all unasked is the standing approval's call;
 * the person the form-row cannot decide (a name that is an individual, an `--exclude`) is the owner's.
 *
 * `--exclude <form>:<row>` leaves an applicant out for good THIS run. To make a verdict stick, record
 * `not an LLO` on the EOI Response Mapping tab (an owner decision), so labs stops listing it.
 * `--overrides <file.json>` maps `"<form>:<row>"` to `{name, title}` to correct the name/title split.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import { resolveGogIdentity } from '../lib/gog-identity.js';
import { makeLabsCall, type LabsCall } from '../lib/labs-rpc.js';
import { draftRows, type DraftedRows } from '../lib/eoi-directory-rows.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The LLO Directory, whose EOI/RFP tab names each form's response sheet. Read live from connect-labs by llo-directory.ts. */
const ROUNDS_TAB = 'EOI/RFP';

export interface Awaiting {
  response_id: number;
  form: string;
  source_row: number;
  org_name: string;
  submitted_at: string | null;
  country: string;
  website: string;
}

export interface Deps {
  call: LabsCall;
  /** Runs a command with an argument array (never a shell). */
  exec: (cmd: string, args: string[]) => string;
  identity: () => { account: string; client: string };
  /** `llo-directory.ts batch-apply --batch <file> --skip-problem-items`; returns its parsed output. */
  applyBatch: (batchFile: string) => { ok: boolean; output: any };
  /** The directory's spreadsheet id (connect-labs `DIRECTORY_ID`), read live. */
  directoryId: () => string;
  today: () => string;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** A sheet id from a `…/spreadsheets/d/<id>/…` link. */
export function sheetIdOf(link: string): string | null {
  const m = String(link ?? '').match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

export interface FormSource {
  key: string;
  sheetId: string;
  tab: string;
  round: string;
  announcement: string;
}

/** Each form's response sheet, from the directory's EOI/RFP tab, located by header text. */
export function formSources(rows: string[][]): Map<string, FormSource> {
  const header = (rows[0] ?? []).map((h) => String(h ?? '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim());
  const at = (name: string) => header.findIndex((h) => h === name);
  const slug = at('slug');
  const link = at('response sheet link');
  const tab = at('response tab');
  const ann = at('announcement link');
  const round = header.findIndex((h) => h.startsWith('round'));
  if (slug < 0 || link < 0) throw new Error(`The ${ROUNDS_TAB} tab has no "Slug" / "Response Sheet Link" column; its headers changed.`);
  const out = new Map<string, FormSource>();
  for (const row of rows.slice(1)) {
    const key = String(row[slug] ?? '').trim();
    const sheetId = sheetIdOf(row[link]);
    if (!key || !sheetId) continue;
    out.set(key, {
      key,
      sheetId,
      tab: String(row[tab] ?? '').trim() || 'Form Responses 1',
      round: String((round >= 0 ? row[round] : '') ?? '').trim() || key,
      announcement: String(row[ann] ?? '').trim(),
    });
  }
  return out;
}

/** The labs import as a job: submit, poll, return its result. A job that never starts is reported, not waited on. */
export async function importOnLabs(call: LabsCall, args: Record<string, unknown>, deps: Pick<Deps, 'sleep' | 'now' | 'log'>, timeoutMs = 8 * 60_000): Promise<any> {
  const started = await call('marketplace_import', { eoi: true, wait: false, ...args });
  if (!started.job_id) return started; // finished inside the call
  const t0 = deps.now();
  let last = '';
  for (;;) {
    const job = await call('job_status', { job_id: started.job_id });
    if (job.state === 'succeeded') return job.result;
    if (job.state === 'failed' || job.state === 'cancelled') {
      throw new Error(`marketplace_import ${job.state}${job.error ? `: ${job.error}` : ''}${job.error_code ? ` (${job.error_code})` : ''}`);
    }
    const waited = deps.now() - t0;
    if (job.state !== last) deps.log(`  import job ${started.job_id.slice(0, 8)}: ${job.state}`);
    last = job.state;
    if (waited > timeoutMs) {
      throw new Error(
        `marketplace_import is still ${job.state} after ${Math.round(waited / 1000)}s (attempts ${job.attempts ?? 0}). ` +
          'A job queued with no attempt is re-sent by labs within a few minutes; if it stays that way, cancel it with job_cancel and run again.',
      );
    }
    await deps.sleep(4_000);
  }
}

export interface RunOptions {
  rounds: string[];
  apply: boolean;
  exclude: Set<string>;
  overrides: Record<string, { name: string; title?: string }>;
  out: string;
  openOnly: boolean;
}

export interface RunReport {
  rounds: string[];
  awaitingBefore: number;
  drafted: { key: string; org: string; submitted: string; warnings: string[] }[];
  excluded: string[];
  needsDecision: { key: string; org_name: string; why: string }[];
  batchFile: string | null;
  applied: boolean;
  applyOutput?: any;
  awaitingAfter?: number;
  unmatchedAfter?: { slug: string; unmatched: number }[];
}

export async function run(opts: RunOptions, deps: Deps): Promise<RunReport> {
  const importArgs = opts.rounds.length ? { rounds: opts.rounds } : { open_only: opts.openOnly };
  deps.log('Importing on labs…');
  const first = await importOnLabs(deps.call, importArgs, deps);
  const perRound: any[] = first.rounds?.per_round ?? [];
  const awaiting: (Awaiting & { round: string })[] = perRound.flatMap((r) => (r.awaiting_verdict ?? []).map((a: Awaiting) => ({ ...a, round: r.slug })));
  const report: RunReport = { rounds: perRound.map((r) => r.slug), awaitingBefore: awaiting.length, drafted: [], excluded: [], needsDecision: [], batchFile: null, applied: false };
  deps.log(`${awaiting.length} submission(s) awaiting an organisation across ${report.rounds.length} round(s).`);
  if (!awaiting.length) return report;

  const { account, client } = deps.identity();
  const sheetGet = (id: string, range: string): string[][] => {
    const out = deps.exec('gog', ['sheets', 'get', id, range, '-a', account, '--client', client, '-j', '--results-only']).trim();
    const parsed = out ? JSON.parse(out) : [];
    return Array.isArray(parsed) ? parsed : (parsed.values ?? []);
  };
  const sources = formSources(sheetGet(deps.directoryId(), `'${ROUNDS_TAB}'!A:Z`));

  // Round titles come from labs, one call per round that has someone awaiting.
  const titles = new Map<string, string>();
  for (const slug of new Set(awaiting.map((a) => a.round))) {
    const r = await deps.call('marketplace_rounds_list', { slug });
    titles.set(slug, r.rounds?.[0]?.title ?? slug);
  }

  const sheets = new Map<string, string[][]>();
  const items: any[] = [];
  const today = deps.today();
  for (const a of awaiting) {
    const key = `${a.form}:${a.source_row}`;
    if (opts.exclude.has(key)) {
      report.excluded.push(key);
      continue;
    }
    const src = sources.get(a.form);
    if (!src) {
      report.needsDecision.push({ key, org_name: a.org_name, why: `no response sheet for form ${a.form} on the ${ROUNDS_TAB} tab` });
      continue;
    }
    if (!sheets.has(a.form)) sheets.set(a.form, sheetGet(src.sheetId, `'${src.tab}'!A:ZZ`));
    const sheet = sheets.get(a.form)!;
    const row = sheet[a.source_row - 1];
    if (!row) {
      report.needsDecision.push({ key, org_name: a.org_name, why: `row ${a.source_row} is not on the response sheet` });
      continue;
    }
    let drafted: DraftedRows;
    try {
      drafted = draftRows({
        formKey: a.form,
        sheetRow: a.source_row,
        header: sheet[0],
        row,
        round: { slug: a.round, title: titles.get(a.round) ?? a.round, announcementUrl: src.announcement },
        today,
        contactOverride: opts.overrides[key],
      });
    } catch (err) {
      report.needsDecision.push({ key, org_name: a.org_name, why: (err as Error).message });
      continue;
    }
    items.push({ org: drafted.org, contact: drafted.contact, dates: drafted.dates, submitted: drafted.submitted, label: `${drafted.orgName} (${key})` });
    report.drafted.push({ key, org: drafted.orgName, submitted: drafted.submitted, warnings: drafted.warnings });
  }

  if (items.length) {
    fs.mkdirSync(opts.out, { recursive: true });
    report.batchFile = path.join(opts.out, 'batch.json');
    fs.writeFileSync(report.batchFile, JSON.stringify(items, null, 1));
  }
  deps.log(`${items.length} drafted, ${report.excluded.length} excluded, ${report.needsDecision.length} need a decision.`);

  if (opts.apply && report.batchFile) {
    deps.log('Writing the batch to the directory…');
    const applied = deps.applyBatch(report.batchFile);
    report.applied = applied.output?.applied === true;
    report.applyOutput = applied.output;
    if (!applied.ok) deps.log('The batch did not fully verify; not importing. Read applyOutput.');
    else {
      deps.log('Importing again on labs…');
      const second = await importOnLabs(deps.call, importArgs, deps);
      const per: any[] = second.rounds?.per_round ?? [];
      report.awaitingAfter = per.reduce((n, r) => n + (r.awaiting_verdict?.length ?? 0), 0);
      report.unmatchedAfter = per.map((r) => ({ slug: r.slug, unmatched: r.unmatched }));
    }
  }
  fs.mkdirSync(opts.out, { recursive: true });
  fs.writeFileSync(path.join(opts.out, 'report.json'), JSON.stringify(report, null, 1));
  return report;
}

function parseArgs(argv: string[]): RunOptions {
  const all = (name: string) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
  const one = (name: string) => all(name)[0];
  const overridesFile = one('--overrides');
  return {
    rounds: all('--round'),
    apply: argv.includes('--apply'),
    exclude: new Set(all('--exclude')),
    overrides: overridesFile ? JSON.parse(fs.readFileSync(overridesFile, 'utf8')) : {},
    out: one('--out') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'llo-directory-eoi-')),
    openOnly: !argv.includes('--all-rounds'),
  };
}

const defaultDeps = (): Deps => ({
  call: makeLabsCall(),
  exec: (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }),
  identity: () => resolveGogIdentity({ repoRoot: REPO_ROOT }),
  applyBatch: (batchFile) => {
    // The same script the skill documents, so there is one writer: never a second implementation of the write.
    // It exits 1 for "not ready" or "did not verify" and still prints its JSON, so read stdout either way.
    const args = [path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(REPO_ROOT, 'scripts/llo-directory.ts'), 'batch-apply', '--batch', batchFile, '--skip-problem-items'];
    let out: string;
    try {
      out = execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
    } catch (err) {
      out = String((err as { stdout?: string }).stdout ?? '');
      if (!out.includes('{')) throw err;
    }
    const parsed = JSON.parse(out.slice(out.indexOf('{')));
    return { ok: parsed.ok === true, output: parsed };
  },
  directoryId: () => {
    const out = execFileSync(process.execPath, [path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(REPO_ROOT, 'scripts/llo-directory.ts'), 'contract'], { encoding: 'utf8' });
    return JSON.parse(out.slice(out.indexOf('{'))).directoryId;
  },
  today: () => new Date().toLocaleDateString('en-CA'),
  log: (line) => console.log(line),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
});

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  loadPluginEnv(import.meta.url);
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== 'run') {
    console.error('usage: llo-directory-eoi.ts run [--round <slug>]... [--all-rounds] [--apply] [--exclude <form>:<row>]... [--overrides f.json] [--out dir]');
    process.exitCode = 2;
  } else {
    run(parseArgs(rest), defaultDeps())
      .then((r) => {
        console.log(JSON.stringify(r, null, 2));
        process.exitCode = r.applied && r.awaitingAfter === undefined ? 1 : 0;
      })
      .catch((err) => {
        console.error((err as Error).message);
        process.exitCode = 2;
      });
  }
}
