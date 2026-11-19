// scripts/llo-directory-eoi.ts end to end, with labs, gog and the batch writer faked.
//
// 2026-11-19: "ingest the open EOI and add the orgs that are not in the directory" took ~30 tool calls,
// a drafting script rewritten twice and ~15 minutes of Sheets quota waits. This is that flow as one command.

import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formSources, importOnLabs, run, sheetIdOf, type Deps, type RunOptions } from '../../scripts/llo-directory-eoi.js';

const HEADER = [
  'Timestamp', 'Email Address', 'Organization name', 'What year was your organization founded?',
  'Primary contact name and title', 'Primary contact email', 'Primary contact phone number',
  'Website or social media page (optional)', 'Which describes your organization? Choose all that apply.',
  'Is your organization legally registered as an independent entity?', 'Annual budget last year in USD',
  'How did you hear', 'If you were referred by another organization, what', 'Which countries do you work in today?',
  'Where in each country do you work today?', 'How did you choose', 'What is the largest number of frontline workers (FLWs)',
  'Briefly describe', 'Could your organization manage 100 FLWs', 'Which community services', 'Have you worked with Connect or CommCare before?',
];
const rowFor = (stamp: string, name: string, email: string): string[] => {
  const r = HEADER.map(() => '');
  r[0] = stamp; r[1] = email; r[2] = name; r[3] = '2020'; r[4] = 'Ada Example, Director'; r[6] = '+000';
  r[13] = 'Uganda'; r[16] = '1-24'; r[20] = 'No';
  return r;
};

const ROUNDS_TAB = [
  ['Slug', 'Program / Initiative Name', 'Announcement Link', 'Response Sheet Link', 'Response Tab', 'Round (optional — rows sharing one are the forms of one round)'],
  ['demo-rfi-2026-en', 'Demo RFI — English', 'https://example.invalid/ann', 'https://docs.google.com/spreadsheets/d/SHEETEN123/edit', 'Form Responses 1', 'demo-rfi-2026'],
  ['demo-rfi-2026-fr', 'Demo RFI — French', 'https://example.invalid/ann', 'https://docs.google.com/spreadsheets/d/SHEETFR456/edit', '', 'demo-rfi-2026'],
];
const EN_SHEET = [HEADER, rowFor('11/17/2026 3:10:28', 'Alpha Trust', 'a@alpha.example.invalid'), rowFor('11/18/2026 9:00:00', 'Beta Network', 'b@beta.example.invalid')];

const awaitingOf = (n: number, name: string, form = 'demo-rfi-2026-en') => ({
  response_id: 1000 + n, form, source_row: n, org_name: name, submitted_at: '2026-11-17T03:10:28+00:00', country: 'Uganda', website: '',
});

let imports: Record<string, unknown>[];
let jobPlan: Array<Record<string, unknown>>; // successive results of the labs import
let applied: string[];
let execCalls: string[][];
let logged: string[];

function fakeDeps(over: Partial<Deps> = {}): Deps {
  let jobN = 0;
  return {
    call: async (tool, args) => {
      if (tool === 'marketplace_import') {
        imports.push(args);
        return { job_id: `job-${++jobN}-aaaaaaaa`, state: 'queued' };
      }
      if (tool === 'job_status') return { state: 'succeeded', result: jobPlan.shift() };
      if (tool === 'marketplace_rounds_list') return { rounds: [{ slug: args.slug, title: 'Demo RFI 2026' }] };
      throw new Error(`unexpected labs tool ${tool}`);
    },
    exec: (cmd, args) => {
      execCalls.push([cmd, ...args]);
      const id = args[2];
      if (id === 'DIRECTORY') return JSON.stringify(ROUNDS_TAB);
      if (id === 'SHEETEN123') return JSON.stringify(EN_SHEET);
      throw new Error(`unexpected sheet ${id}`);
    },
    identity: () => ({ account: 'ace@dimagi-ai.com', client: 'canopy' }),
    applyBatch: (file) => {
      applied.push(file);
      return { ok: true, output: { applied: true, ok: true, count: JSON.parse(readFileSync(file, 'utf8')).length } };
    },
    directoryId: () => 'DIRECTORY',
    today: () => '2026-11-19',
    log: (l) => logged.push(l),
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 1000); })(),
    ...over,
  };
}

const opts = (over: Partial<RunOptions> = {}): RunOptions => ({
  rounds: [], apply: false, exclude: new Set(), overrides: {}, out: mkdtempSync(join(tmpdir(), 'eoi-run-')), openOnly: true, ...over,
});

const result = (awaiting: unknown[], unmatched = awaiting.length) => ({
  rounds: { per_round: [{ slug: 'demo-rfi-2026', submissions: 5, matched: 5 - unmatched, unmatched, awaiting_verdict: awaiting }] },
});

beforeEach(() => {
  imports = []; applied = []; execCalls = []; logged = [];
  jobPlan = [];
});

describe('helpers', () => {
  it('reads a sheet id from a link', () => {
    expect(sheetIdOf('https://docs.google.com/spreadsheets/d/1AbC_d-9/edit#gid=0')).toBe('1AbC_d-9');
    expect(sheetIdOf('not a link')).toBeNull();
  });

  it('finds each form’s response sheet by header text, defaulting the tab', () => {
    const s = formSources(ROUNDS_TAB);
    expect(s.get('demo-rfi-2026-fr')).toMatchObject({ sheetId: 'SHEETFR456', tab: 'Form Responses 1', round: 'demo-rfi-2026' });
  });

  it('refuses a rounds tab whose headers changed', () => {
    expect(() => formSources([['Foo', 'Bar']])).toThrow(/headers changed/);
  });
});

describe('importOnLabs', () => {
  it('returns a result that came back inside the call', async () => {
    const out = await importOnLabs(async () => ({ organisations: 5 }), {}, { sleep: async () => {}, now: Date.now, log: () => {} });
    expect(out).toEqual({ organisations: 5 });
  });

  it('says a job that never starts is stuck instead of waiting forever', async () => {
    const call = async (tool: string) => (tool === 'marketplace_import' ? { job_id: 'abcdef123456' } : { state: 'queued', attempts: 0 });
    let t = 0;
    await expect(importOnLabs(call, {}, { sleep: async () => {}, now: () => (t += 120_000), log: () => {} }, 300_000)).rejects.toThrow(/still queued after \d+s \(attempts 0\)/);
  });

  it('reports a failed job with labs’ own error', async () => {
    const call = async (tool: string) => (tool === 'marketplace_import' ? { job_id: 'abcdef123456' } : { state: 'failed', error: 'sheet unreadable', error_code: 'DIRECTORY_UNREADABLE' });
    await expect(importOnLabs(call, {}, { sleep: async () => {}, now: Date.now, log: () => {} })).rejects.toThrow(/sheet unreadable \(DIRECTORY_UNREADABLE\)/);
  });
});

describe('run', () => {
  it('imports only the open rounds by default', async () => {
    jobPlan = [result([])];
    await run(opts(), fakeDeps());
    expect(imports[0]).toMatchObject({ eoi: true, open_only: true, wait: false });
  });

  it('does nothing further, and reads no sheet, when nobody is awaiting an organisation', async () => {
    jobPlan = [result([])];
    const r = await run(opts(), fakeDeps());
    expect(r.awaitingBefore).toBe(0);
    expect(execCalls).toHaveLength(0);
    expect(applied).toHaveLength(0);
  });

  it('drafts a batch from the response sheet rows and writes NOTHING without --apply', async () => {
    jobPlan = [result([awaitingOf(2, 'Alpha Trust'), awaitingOf(3, 'Beta Network')])];
    const o = opts();
    const r = await run(o, fakeDeps());

    expect(r.drafted.map((d) => d.org)).toEqual(['Alpha Trust', 'Beta Network']);
    expect(r.applied).toBe(false);
    expect(applied).toHaveLength(0);
    expect(imports).toHaveLength(1);
    const batch = JSON.parse(readFileSync(r.batchFile!, 'utf8'));
    expect(batch[0].submitted).toBe('2026-11-17');
    expect(batch[1].dates['Joined Connect Network']).toBe('2026-11-18'); // each by its own submission
    expect(batch[0].org['EOIs Applied for (Add Link to EOI)']).toContain('https://example.invalid/ann');
    expect(existsSync(join(o.out, 'report.json'))).toBe(true);
  });

  it('reads each form’s response sheet once, however many applicants it has', async () => {
    jobPlan = [result([awaitingOf(2, 'Alpha Trust'), awaitingOf(3, 'Beta Network')])];
    await run(opts(), fakeDeps());
    expect(execCalls.filter((c) => c.includes('SHEETEN123'))).toHaveLength(1);
  });

  it('with --apply writes the batch, imports again, and reports who is still awaiting', async () => {
    jobPlan = [result([awaitingOf(2, 'Alpha Trust'), awaitingOf(3, 'Beta Network')]), result([], 0)];
    const r = await run(opts({ apply: true }), fakeDeps());

    expect(applied).toHaveLength(1);
    expect(r.applied).toBe(true);
    expect(imports).toHaveLength(2);
    expect(r.awaitingAfter).toBe(0);
    expect(r.unmatchedAfter).toEqual([{ slug: 'demo-rfi-2026', unmatched: 0 }]);
  });

  it('does not import again when the batch did not verify', async () => {
    jobPlan = [result([awaitingOf(2, 'Alpha Trust')])];
    const r = await run(opts({ apply: true }), fakeDeps({ applyBatch: () => ({ ok: false, output: { applied: true, ok: false } }) }));
    expect(imports).toHaveLength(1);
    expect(r.awaitingAfter).toBeUndefined();
  });

  it('leaves out an excluded applicant', async () => {
    jobPlan = [result([awaitingOf(2, 'Alpha Trust'), awaitingOf(3, 'Beta Network')])];
    const r = await run(opts({ exclude: new Set(['demo-rfi-2026-en:3']) }), fakeDeps());
    expect(r.excluded).toEqual(['demo-rfi-2026-en:3']);
    expect(r.drafted.map((d) => d.org)).toEqual(['Alpha Trust']);
  });

  it('puts a row it cannot draft in front of a person, with why, and drafts the rest', async () => {
    jobPlan = [result([awaitingOf(2, 'Alpha Trust'), awaitingOf(9, 'Ghost Org')])];
    const r = await run(opts(), fakeDeps());
    expect(r.drafted.map((d) => d.org)).toEqual(['Alpha Trust']);
    expect(r.needsDecision).toEqual([{ key: 'demo-rfi-2026-en:9', org_name: 'Ghost Org', why: 'row 9 is not on the response sheet' }]);
  });

  it('puts an applicant whose form has no response sheet in front of a person', async () => {
    jobPlan = [result([awaitingOf(2, 'Alpha Trust', 'demo-rfi-2026-xx')])];
    const r = await run(opts(), fakeDeps());
    expect(r.needsDecision[0].why).toMatch(/no response sheet for form demo-rfi-2026-xx/);
    expect(r.batchFile).toBeNull();
  });

  it('applies a person’s correction to the contact name/title split', async () => {
    jobPlan = [result([awaitingOf(2, 'Alpha Trust')])];
    const r = await run(opts({ overrides: { 'demo-rfi-2026-en:2': { name: 'Ada Example', title: 'Chair of the board' } } }), fakeDeps());
    const batch = JSON.parse(readFileSync(r.batchFile!, 'utf8'));
    expect(batch[0].contact['Role / Title']).toBe('Chair of the board');
  });

  it('imports the named rounds when asked, instead of the open ones', async () => {
    jobPlan = [result([])];
    await run(opts({ rounds: ['demo-rfi-2026'] }), fakeDeps());
    expect(imports[0]).toMatchObject({ rounds: ['demo-rfi-2026'] });
    expect(imports[0]).not.toHaveProperty('open_only');
  });
});
