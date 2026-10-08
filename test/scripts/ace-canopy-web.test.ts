// ace#2805: the chlorine demo narrative (meant for `connect`) was posted AS JONATHAN into
// `dimagi`, because canopy's DDD CLI falls back to ~/.claude/canopy/workbench-token for identity
// and to the org default for workspace, and the session reported "connect" without reading it
// back. Every ACE path that writes to canopy-web DDD must go through bin/ace-canopy-web, which
// pins ACE's own PAT + an explicit workspace, refuses a workspace ACE cannot edit, and reads
// the write back scoped.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(ROOT, 'bin', 'ace-canopy-web');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Every documented ACE path that writes to canopy-web DDD.
const WRITE_PATHS = [
  'agents/demo.md',
  'agents/synthetic-data-and-workflows.md',
  'skills/video-render-local/SKILL.md',
  'commands/video-render-local.md',
  'skills/narrative-iteration-review/SKILL.md',
  'skills/partnership-publish/SKILL.md',
];

describe('canopy-web DDD writes are pinned (docs)', () => {
  it.each(WRITE_PATHS)('%s routes canopy-web writes through bin/ace-canopy-web', (p) => {
    const body = read(p);
    expect(body).toContain('ace-canopy-web');
    expect(body).toContain('playbook/integrations/canopy-web.md');
  });

  it.each(WRITE_PATHS)('%s never names the workbench token as the PAT source', (p) => {
    for (const line of read(p).split('\n')) {
      if (line.includes('workbench-token')) expect(line).toMatch(/never/i);
    }
  });

  it('config/canopy-web.json declares the DDD workspace explicitly', () => {
    const cfg = JSON.parse(read('config/canopy-web.json'));
    expect(typeof cfg.ddd_workspace).toBe('string');
    expect(cfg.ddd_workspace.length).toBeGreaterThan(0);
  });
});

// A fake canopy-web: /api/me/ answers per-token identity; members lists roles; scoped reads.
let server: http.Server;
let base = '';
const seen: string[] = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    seen.push(`${req.url} ${auth}`);
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/api/me/') return json(200, { email: auth === 'Bearer ace-pat' ? 'ace@dimagi-ai.com' : 'jjackson@dimagi.com' });
    if (req.url === '/api/workspaces/connect/members/') return json(200, [{ email: 'ace@dimagi-ai.com', role: 'editor' }]);
    if (req.url === '/api/workspaces/other/members/') return json(200, [{ email: 'jjackson@dimagi.com', role: 'owner' }]);
    if (req.url === '/api/w/connect/ddd/narratives/n1/') return json(200, { slug: 'n1' });
    return json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => server.close());

type Result = { status: number | null; stdout: string; stderr: string };
// Async on purpose: the fake server lives in THIS process, so a sync spawn would block it.
function run(args: string[], envFileBody: string | null, extraEnv: Record<string, string> = {}): Promise<Result> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-cw-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, envFileBody ?? '');
  // Hostile surroundings: a workbench token and an inherited human PAT must both be ignored.
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'canopy'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'canopy', 'workbench-token'), 'human-pat');
  return new Promise((resolve) => {
    const child = spawn('python3', [BIN, ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: home, ACE_ENV_FILE: envFile, CANOPY_WEB_API_URL: base, CANOPY_WEB_PAT: 'human-pat', ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe('bin/ace-canopy-web (behaviour)', () => {
  it('execs the command with ACE\'s PAT, the workspace and CANOPY_AGENT=ace — not the inherited human PAT', async () => {
    const r = await run(['--workspace', 'connect', '--', 'sh', '-c', 'echo "$CANOPY_WEB_PAT|$CANOPY_WEB_WORKSPACE|$CANOPY_AGENT"'], 'CANOPY_WEB_PAT=ace-pat\n');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('ace-pat|connect|ace');
  });

  it('requires --workspace', async () => {
    const r = await run(['--', 'true'], 'CANOPY_WEB_PAT=ace-pat\n');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/);
  });

  it('refuses when ACE\'s .env has no PAT (never falls back to the workbench token)', async () => {
    const r = await run(['--workspace', 'connect', '--', 'true'], '');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no CANOPY_WEB_PAT in ACE's \.env/);
  });

  it('refuses a PAT that is not ACE', async () => {
    const r = await run(['--workspace', 'connect', 'check'], 'CANOPY_WEB_PAT=human-pat\n');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not ace@dimagi-ai\.com/);
  });

  it('refuses a workspace ACE cannot edit', async () => {
    const r = await run(['--workspace', 'other', '--', 'true'], 'CANOPY_WEB_PAT=ace-pat\n');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not an editor of workspace 'other'/);
  });

  it('verify reads back SCOPED: 200 in the right workspace, non-zero elsewhere', async () => {
    const ok = await run(['--workspace', 'connect', 'verify', 'narrative', 'n1'], 'CANOPY_WEB_PAT=ace-pat\n');
    expect(ok.status, ok.stderr).toBe(0);
    const miss = await run(['--workspace', 'dimagi', 'verify', 'narrative', 'n1'], 'CANOPY_WEB_PAT=ace-pat\n');
    expect(miss.status).toBe(1);
    expect(miss.stderr).toMatch(/NOT readable in workspace 'dimagi'/);
    expect(seen.some((s) => s.startsWith('/api/w/dimagi/ddd/narratives/n1/'))).toBe(true);
  });
});
