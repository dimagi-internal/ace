/**
 * Tenancy guard + opp binding (hooks/tenancy_guard.py, bin/ace-bind).
 *
 * A session bound to an opp (bin/ace-bind) may only WRITE into that opp's
 * tenancy: its HQ project space, Connect orgs, OCS team and Labs domains. The
 * guard is a PreToolUse hook because it is the one choke point every ACE tool
 * call crosses — including the remote connect-labs server, which no in-process
 * wrapper can see. It stops mistakes (a wrong default, another opp's id pasted
 * in), not a compromised session; see ace-web
 * docs/specs/2026-09-28-clone-and-release-design.md § D.
 *
 * Rollout: an UNBOUND session is allowed and the would-be violation is only
 * logged, so today's runs keep working until every entry point binds.
 *
 * These tests spawn the real hook and the real bin/ace-bind with a temp bind
 * dir, the way test/hooks/gating-guard.test.ts spawns gating_guard.py.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = path.join(REPO_ROOT, 'hooks', 'tenancy_guard.py');
const BIND = path.join(REPO_ROOT, 'bin', 'ace-bind');

const SESSION = 'sess-1111';
const SPARK = {
  hq_domain: 'connect-ace-spark',
  connect_pm_org: 'spark-pm',
  connect_holding_org: 'spark',
  ocs_team: 'spark',
  labs_allowed_domains: ['@sparkmicrogrants.org'],
};

let bindDir: string;

beforeEach(() => {
  bindDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-bind-test-'));
});
afterEach(() => {
  fs.rmSync(bindDir, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // CLAUDE_PLUGIN_DATA points nowhere so no real installed .env leaks in.
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ACE_OPP_BIND_DIR: bindDir,
    CLAUDE_PLUGIN_DATA: path.join(bindDir, 'no-plugin-data'),
    ...extra,
  };
}

function bind(tenancy: Record<string, unknown>, opp = 'spark/spark-facilitator', session = SESSION) {
  const r = spawnSync(BIND, [opp, '--tenancy-json', JSON.stringify(tenancy)], {
    env: env({ CLAUDE_CODE_SESSION_ID: session }),
    encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
  return r;
}

function guard(toolName: string, toolInput: Record<string, unknown>, extraEnv: Record<string, string> = {}, session = SESSION) {
  const r = spawnSync('python3', [GUARD], {
    input: JSON.stringify({ session_id: session, tool_name: toolName, tool_input: toolInput }),
    env: env(extraEnv),
    encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const HQ = 'mcp__plugin_ace_ace-connect__commcare_make_build';
const PROGRAM = 'mcp__plugin_ace_ace-connect__connect_create_program';
const OPPORTUNITY = 'mcp__plugin_ace_ace-connect__connect_create_opportunity';
const COPY = 'mcp__plugin_ace_ace-connect__commcare_linked_app_copy';
const OCS = 'mcp__plugin_ace_ace-ocs__ocs_create_chatbot';
const LABS = 'mcp__plugin_ace_connect-labs__synthetic_create_labs_only';

describe('unbound session', () => {
  it('allows a write and logs what a bound session would have refused', () => {
    const r = guard(HQ, { domain: 'connect-ace-prod', app_id: 'a' });
    expect(r.code).toBe(0);
    const log = fs.readFileSync(path.join(bindDir, 'unbound-writes.log'), 'utf8');
    expect(log).toContain('commcare_make_build');
    expect(log).toContain(SESSION);
  });

  it('ignores tools that are not tenant writes', () => {
    expect(guard('mcp__plugin_ace_ace-connect__commcare_list_apps', { domain: 'x' }).code).toBe(0);
    expect(guard('mcp__claude_ai_Claude_Docs__batch', { anything: 1 }).code).toBe(0);
    expect(fs.existsSync(path.join(bindDir, 'unbound-writes.log'))).toBe(false);
  });
});

describe('bound session', () => {
  beforeEach(() => bind(SPARK));

  it('allows a write into the bound HQ space', () => {
    expect(guard(HQ, { domain: 'connect-ace-spark', app_id: 'a' }).code).toBe(0);
  });

  it('refuses a write into another HQ space, naming the bound opp', () => {
    const r = guard(HQ, { domain: 'connect-ace-prod', app_id: 'a' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('spark/spark-facilitator');
    expect(r.stderr).toContain('connect-ace-prod');
    expect(r.stderr).toContain('connect-ace-spark');
  });

  it('checks Connect orgs: either of the opp orgs, nothing else', () => {
    expect(guard(PROGRAM, { organization_slug: 'spark-pm' }).code).toBe(0);
    expect(guard(PROGRAM, { organization_slug: 'SPARK' }).code).toBe(0);
    expect(guard(PROGRAM, { organization_slug: 'ace-nm-org' }).code).toBe(2);
  });

  it('checks every target of connect_create_opportunity, including nested app domains', () => {
    const ok = {
      organization_slug: 'spark-pm',
      target_organization_slug: 'spark',
      learn_app: { cc_domain: 'connect-ace-spark', cc_app_id: '1' },
      deliver_app: { cc_domain: 'connect-ace-spark', cc_app_id: '2' },
    };
    expect(guard(OPPORTUNITY, ok).code).toBe(0);
    const r = guard(OPPORTUNITY, { ...ok, deliver_app: { cc_domain: 'connect-ace-prod', cc_app_id: '2' } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('deliver_app.cc_domain');
  });

  it('lets a copy READ from the shared space but only WRITE into the bound one', () => {
    expect(guard(COPY, { upstream_domain: 'connect-ace-prod', downstream_domain: 'connect-ace-spark' }).code).toBe(0);
    expect(guard(COPY, { upstream_domain: 'connect-ace-spark', downstream_domain: 'connect-ace-prod' }).code).toBe(2);
  });

  it('checks every Labs allowed domain against the opp domains', () => {
    expect(guard(LABS, { allowed_domains: ['sparkmicrogrants.org'] }).code).toBe(0);
    expect(guard(LABS, { allowed_domains: ['@sparkmicrogrants.org', '@dimagi.com'] }).code).toBe(2);
  });

  it('checks synthetic_set_allowed_domains against the opp domains', () => {
    const SET = 'mcp__plugin_ace_connect-labs__synthetic_set_allowed_domains';
    expect(guard(SET, { opportunity_id: 10500, allowed_domains: ['@sparkmicrogrants.org'] }).code).toBe(0);
    expect(guard(SET, { opportunity_id: 10500, allowed_domains: ['@evil.org'] }).code).toBe(2);
  });

  it('checks the OCS team the server was started with', () => {
    expect(guard(OCS, { name: 'bot' }, { OCS_TEAM_SLUG: 'spark' }).code).toBe(0);
    const r = guard(OCS, { name: 'bot' }, { OCS_TEAM_SLUG: 'connect-ace' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('OCS_TEAM_SLUG');
  });

  it('refuses when the tenancy field is not set up yet, rather than guessing', () => {
    bind({ hq_domain: 'connect-ace-spark' });
    const r = guard(PROGRAM, { organization_slug: 'spark-pm' });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/connect_pm_org.*not set/);
  });

  it('does not apply to a different session', () => {
    expect(guard(HQ, { domain: 'connect-ace-prod' }, {}, 'other-session').code).toBe(0);
  });

  it('can be switched off with ACE_TENANCY_GUARD=off', () => {
    expect(guard(HQ, { domain: 'connect-ace-prod' }, { ACE_TENANCY_GUARD: 'off' }).code).toBe(0);
  });
});

describe('warn mode (rollout for /ace:run and /ace:turn)', () => {
  it('lets a would-be refusal through and records it', () => {
    const r = spawnSync(BIND, ['spark/spark-facilitator', '--warn', '--tenancy-json', JSON.stringify(SPARK)], {
      env: env({ CLAUDE_CODE_SESSION_ID: SESSION }),
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('(warn)');
    expect(guard(HQ, { domain: 'connect-ace-prod' }).code).toBe(0);
    const log = fs.readFileSync(path.join(bindDir, 'bound-violations.log'), 'utf8');
    expect(log).toContain('connect-ace-prod');
    expect(log).toContain('spark/spark-facilitator');
  });

  it('records nothing for an allowed write', () => {
    spawnSync(BIND, ['spark/spark-facilitator', '--warn', '--tenancy-json', JSON.stringify(SPARK)], {
      env: env({ CLAUDE_CODE_SESSION_ID: SESSION }),
      encoding: 'utf8',
    });
    expect(guard(HQ, { domain: 'connect-ace-spark' }).code).toBe(0);
    expect(fs.existsSync(path.join(bindDir, 'bound-violations.log'))).toBe(false);
  });
});

describe('bin/ace-bind', () => {
  it('writes the bind file for the current session and --show prints it', () => {
    bind(SPARK);
    const file = path.join(bindDir, `${SESSION}.json`);
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(body.workspace).toBe('spark');
    expect(body.opp).toBe('spark-facilitator');
    expect(body.tenancy.hq_domain).toBe('connect-ace-spark');
    expect(body.mode).toBe('enforce');
    const show = spawnSync(BIND, ['--show'], { env: env({ CLAUDE_CODE_SESSION_ID: SESSION }), encoding: 'utf8' });
    expect(show.stdout).toContain('spark/spark-facilitator');
  });

  it('--clear unbinds', () => {
    bind(SPARK);
    const r = spawnSync(BIND, ['--clear'], { env: env({ CLAUDE_CODE_SESSION_ID: SESSION }), encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(bindDir, `${SESSION}.json`))).toBe(false);
  });

  it('refuses to bind without a session id', () => {
    const r = spawnSync(BIND, ['spark/x', '--tenancy-json', '{}'], { env: env(), encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('CLAUDE_CODE_SESSION_ID');
  });

  it('uses ACE_WEB_WORKSPACE when only the opp slug is given', () => {
    const r = spawnSync(BIND, ['spark-facilitator', '--tenancy-json', '{}'], {
      env: env({ CLAUDE_CODE_SESSION_ID: SESSION, ACE_WEB_WORKSPACE: 'dimagi-team' }),
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    const body = JSON.parse(fs.readFileSync(path.join(bindDir, `${SESSION}.json`), 'utf8'));
    expect(body.workspace).toBe('dimagi-team');
  });
});

describe('hook matcher covers every spelling a rule targets', () => {
  // The rules suffix-match tool names, but the hook only RUNS for tool names
  // hooks/hooks.json's PreToolUse matcher lets through. connect-labs and Nova
  // are registered user-scope on some machines (mcp__connect_labs__X,
  // mcp__nova__X), and a matcher written for the plugin spelling alone silently
  // skipped every Labs write there — the guard's own tests called the hook
  // directly and never saw it.
  const hooks = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const entry = hooks.hooks.PreToolUse.find((h: { hooks: { command: string }[] }) =>
    h.hooks.some((c) => c.command.includes('tenancy_guard.py')),
  );
  const matcher = new RegExp(`^(?:${entry.matcher})$`);

  it.each([
    'mcp__plugin_ace_ace-connect__commcare_make_build',
    'mcp__ace-connect__connect_remove_org_member',
    'mcp__plugin_ace_ace-ocs__ocs_create_chatbot',
    'mcp__plugin_ace_connect-labs__synthetic_set_allowed_domains',
    'mcp__connect_labs__synthetic_set_allowed_domains',
    'mcp__nova__upload_app_to_hq',
    'mcp__plugin_nova_nova__provision_workers',
  ])('%s reaches the guard', (tool) => {
    expect(matcher.test(tool)).toBe(true);
  });
});

describe('writes added after v1', () => {
  beforeEach(() => bind(SPARK));

  it('checks the user-scope connect_labs spelling', () => {
    const SET = 'mcp__connect_labs__synthetic_set_allowed_domains';
    expect(guard(SET, { opportunity_id: 10500, allowed_domains: ['@sparkmicrogrants.org'] }).code).toBe(0);
    expect(guard(SET, { opportunity_id: 10500, allowed_domains: ['@evil.org'] }).code).toBe(2);
  });

  it('checks Nova uploads and worker provisioning against the HQ space', () => {
    expect(guard('mcp__nova__upload_app_to_hq', { app_id: 'a', domain: 'connect-ace-spark' }).code).toBe(0);
    expect(guard('mcp__nova__upload_app_to_hq', { app_id: 'a', domain: 'connect-ace-prod' }).code).toBe(2);
    expect(guard('mcp__plugin_nova_nova__provision_workers', { app_id: 'a', domain: 'connect-ace-prod' }).code).toBe(2);
  });

  it('checks connect_remove_org_member against the opp orgs', () => {
    const RM = 'mcp__plugin_ace_ace-connect__connect_remove_org_member';
    expect(guard(RM, { organization_slug: 'spark', email: 'a@x.org' }).code).toBe(0);
    expect(guard(RM, { organization_slug: 'ace-nm-org', email: 'a@x.org' }).code).toBe(2);
  });
});

describe('entry points bind to the configured workspace', () => {
  it('a bare opp reads ACE_WEB_WORKSPACE from the installed plugin .env, not the shell', () => {
    // .env values are loaded into MCP subprocesses, not the shell, so a shell
    // expansion like ${ACE_WEB_WORKSPACE:-dimagi-team} always took the
    // fallback. ace-bind reads the plugin .env itself when given a bare opp.
    const data = path.join(bindDir, 'plugin-data');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, '.env'), 'ACE_WEB_WORKSPACE=spark\n');
    const r = spawnSync(BIND, ['spark-facilitator', '--tenancy-json', '{}'], {
      env: { ...env({ CLAUDE_CODE_SESSION_ID: SESSION }), CLAUDE_PLUGIN_DATA: data },
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    const body = JSON.parse(fs.readFileSync(path.join(bindDir, `${SESSION}.json`), 'utf8'));
    expect(body.workspace).toBe('spark');
  });

  it('no entry point hardcodes a shell fallback workspace', () => {
    for (const rel of ['agents/ace-orchestrator.md', 'commands/step.md', 'skills/inbox-triage/SKILL.md']) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      expect(text, rel).not.toMatch(/ace-bind"?\s+"?\$\{ACE_WEB_WORKSPACE/);
    }
  });
});
