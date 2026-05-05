# ACE Solicitations Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert a new Phase 6 (Solicitation Management) into the ACE lifecycle, renumber the existing Phase 6 (LLO Management → Execution Management) and Phase 7 (Closeout) to 7 and 8, and wire ACE to consume the existing connect-labs remote MCP for solicitation/review/award atoms.

**Architecture:** New `solicitation-management` subagent owns Phase 6. Two skills (`solicitation-create`, `llo-invite` — moved from old Phase 6 and rewritten) run in default `/ace:run`; one recurring skill (`solicitation-monitor`); one manual skill (`solicitation-review`). ACE consumes connect-labs's remote MCP at `https://labs.connect.dimagi.com/mcp/` via a thin local stdio proxy (`mcp/connect-labs-server.ts`) that forwards JSON-RPC and injects the bearer PAT. No new atoms in `ace-connect`.

**Tech Stack:** TypeScript (`npx tsx` MCP subprocesses), vitest, Markdown SKILL.md prompt files, `.claude-plugin/plugin.json` for MCP wiring, 1Password for secrets.

**Spec:** [`docs/superpowers/specs/2026-05-04-ace-solicitations-phase-design.md`](../specs/2026-05-04-ace-solicitations-phase-design.md)

---

## File Structure

**New files:**
- `mcp/connect-labs-server.ts` — stdio MCP proxy forwarding to `labs.connect.dimagi.com/mcp/`
- `agents/solicitation-management.md` — Phase 6 subagent
- `skills/solicitation-create/SKILL.md`
- `skills/solicitation-create-eval/SKILL.md`
- `skills/solicitation-monitor/SKILL.md`
- `skills/solicitation-review/SKILL.md`
- `skills/solicitation-review-eval/SKILL.md`
- `test/mcp/connect-labs/proxy.test.ts` — unit test for the proxy
- `test/mcp/connect-labs/integration/e2e.integration.test.ts` — `LABS_INTEGRATION=1` end-to-end
- `test/skills/solicitation/*.test.ts` — fixture-driven validation
- `test/fixtures/CRISPR-Test-004-Solicitation/` — golden fixture

**Renamed files:**
- `agents/llo-manager.md` → `agents/execution-manager.md`

**Heavily modified:**
- `skills/llo-invite/SKILL.md` — rewritten; phase moves Phase 7 → Phase 6; behavior changes from Connect-roster prep to solicitation-invite email
- `skills/llo-onboarding/SKILL.md` — reads `selected_llo` from `opp.yaml`, fails fast if empty
- `agents/ace-orchestrator.md` — phases block, pause-points, prose
- `lib/artifact-manifest.ts` — drop `connect-setup/invites.md` artifacts, add solicitation/* artifacts
- `bin/ace-doctor` — new `[Connect Labs]` section
- `templates/pdd-template.md` — three new optional fields
- `CLAUDE.md` — phase order list, plugin overview, pause-points

**Search/replace pass (low-content edits):**
- `agents/connect-setup.md`, `agents/ocs-setup.md`, `agents/qa-and-training.md` — Phase 6/7 references
- `skills/training-onboarding-email/SKILL.md`, `skills/training-deck-build/SKILL.md`, `skills/llo-launch-eval/SKILL.md`, `skills/cycle-grade-eval/SKILL.md`, `skills/connect-opp-setup/SKILL.md`, `skills/ocs-widget-handoff-eval/SKILL.md`
- `commands/run.md`, `commands/step.md`

---

### Task 1: Renumber phase ordinals across the codebase

**Files:**
- Modify: `agents/ace-orchestrator.md`
- Modify: `agents/connect-setup.md`
- Modify: `agents/ocs-setup.md`
- Modify: `agents/qa-and-training.md`
- Modify: `agents/llo-manager.md` (will be renamed in Task 2)
- Modify: `skills/training-onboarding-email/SKILL.md`
- Modify: `skills/training-deck-build/SKILL.md`
- Modify: `skills/llo-launch-eval/SKILL.md`
- Modify: `skills/cycle-grade-eval/SKILL.md`
- Modify: `skills/connect-opp-setup/SKILL.md`
- Modify: `skills/ocs-widget-handoff-eval/SKILL.md`
- Modify: `bin/ace-doctor`

- [ ] **Step 1: Inspect every Phase 6/7 reference**

Run: `grep -rn "Phase 6\|Phase 7\|phase_ordinal: 6\|phase_ordinal: 7\|phase: 6\|phase: 7\|phase_6\|phase_7\|phases.llo_management\|llo-management" agents/ skills/ commands/ bin/ lib/ CLAUDE.md README.md`

Expected: ~50 matches across the files listed above. Read each match in context — some are descriptive prose ("Phase 6 (LLO Management)"), some are frontmatter (`phase_ordinal: 6`), some are state-key names (`phase_6_backlog`).

- [ ] **Step 2: Apply mechanical replacements**

The renumbering is a context-aware substitution. For each file, apply:
- `phase_ordinal: 7` (where it was 7 in `closeout`) → `phase_ordinal: 8`
- `phase_ordinal: 6` (where it was 6 in `llo-manager`) → `phase_ordinal: 7`
- `Phase 6` (where it referred to llo-management) → `Phase 7`
- `Phase 7` (where it referred to closeout) → `Phase 8`
- `phase_6_backlog` (orchestrator state key for old Phase 6) → `phase_7_backlog`
- `phase_7_backlog` (orchestrator state key for old Phase 7) → `phase_8_backlog`
- `phases.llo_management` → `phases.execution_management`

**Do not yet touch:**
- The `Phase 6` references in `solicitation-management` (it doesn't exist yet)
- The `phases:` block in `ace-orchestrator.md` (handled in Task 18 — must add new entry and renumber atomically)

For `bin/ace-doctor`: any `phase_6_*` / `phase_7_*` health check identifiers shift up by one. The ` [LLO Management]` section header becomes ` [Execution Management]`.

- [ ] **Step 3: Verify no leftover stale references**

Run: `grep -rn "phase_6_backlog\|phases.llo_management\|Phase 6 (LLO\|Phase 7 (Closeout)" agents/ skills/ commands/ bin/ lib/`

Expected: zero matches. (The orchestrator's `phases:` block will still have `phase_ordinal` integers; that's fine — they get rewritten in Task 18.)

- [ ] **Step 4: Run vitest to verify nothing structural broke**

Run: `npm test -- --run`

Expected: tests pass at the same rate as on `main` for this branch. Renumbering is documentation-level; nothing in code references phase numbers as integers except `lib/artifact-manifest.ts` (which doesn't number phases — it uses string names like `'design'`, `'connect'`).

- [ ] **Step 5: Commit**

```bash
git add agents/ skills/ bin/ace-doctor
git commit -m "refactor(phases): renumber Phase 6→7, Phase 7→8 (no behavior change)

Pure rename pass: prepares the topology for the new Phase 6
(Solicitation Management) added in subsequent commits. Touches phase
ordinals, run-state backlog keys, and prose references in agents,
skills, and doctor sections. The orchestrator's phases: block is
rewritten atomically in a later task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Rename `llo-manager` agent to `execution-manager`

**Files:**
- Rename: `agents/llo-manager.md` → `agents/execution-manager.md`

- [ ] **Step 1: Rename the file via git**

Run: `git mv agents/llo-manager.md agents/execution-manager.md`

- [ ] **Step 2: Rewrite the frontmatter and opening prose**

Edit `agents/execution-manager.md`. Replace the frontmatter block:

```yaml
---
name: execution-manager
description: >
  Phase 7 of the CRISPR-Connect lifecycle: execute the awarded LLO's run
  of the opportunity — onboarding, UAT, go-live, and recurring monitoring.
  Phase 7 entry is gated on `opp.yaml.selected_llo.org_slug` being populated
  by Phase 6's solicitation-review skill (which the run halts before).
model: inherit
phase: execution-management
phase_display: Execution Management
phase_ordinal: 7
skills:
  - { name: llo-onboarding,  has_judge: false }
  - { name: llo-uat,         has_judge: false }
  - { name: llo-launch,      has_judge: true,  eval_skill: llo-launch-eval }
recurring_skills:
  - { name: timeline-monitor,   has_judge: true }
  - { name: flw-data-review,    has_judge: true,  eval_skill: flw-data-review-eval }
  - { name: ocs-chatbot-qa,     has_judge: false }
  - { name: ocs-chatbot-eval,   has_judge: true }
---
```

Note: `llo-invite` is removed from the skills list (it moves to Phase 6 in Task 14). The remainder of the agent body keeps its existing prose for `llo-onboarding`, `llo-uat`, `llo-launch`, and the recurring skills — only the phase numbering and the "first LLO contact" framing get rewritten.

- [ ] **Step 3: Update the agent body's opening paragraph**

Replace the opening "You run the first LLO-facing phase..." paragraph with:

> You run the execution phase of a CRISPR-Connect opportunity. By the time this phase starts, Phase 6 (Solicitation Management) has published a solicitation, collected responses, and (via the manual `solicitation-review` skill) awarded an org. The awardee is recorded in `opp.yaml.selected_llo` — that's the LLO this phase onboards, supports through UAT, takes to go-live, and monitors during execution.

- [ ] **Step 4: Strip Step 1 (LLO Invitation List) from the body**

The existing agent body has a "### Step 1: LLO Invitation List" section that calls `llo-invite`. Delete that section. Renumber the remaining steps so what was Step 2 (LLO Onboarding) becomes Step 1, Step 3 → Step 2, Step 4 → Step 3, Step 5 → Step 4. Update internal cross-references ("Step 1" / "Step 2" / etc.) accordingly.

- [ ] **Step 5: Update the orchestrator-side dispatch reference**

Run: `grep -rn "llo-manager\|ace:llo-manager" agents/ commands/ CLAUDE.md`

For each match, replace `llo-manager` → `execution-manager` (preserve case and the `ace:` prefix where applicable). The orchestrator's `Agent(llo-manager)` calls will be rewritten when the phases block is updated in Task 18.

- [ ] **Step 6: Commit**

```bash
git add agents/execution-manager.md agents/llo-manager.md commands/ CLAUDE.md
git commit -m "refactor(agent): rename llo-manager → execution-manager

Phase 7 (was Phase 6) is no longer 'first LLO contact' — that role moves
to the new Phase 6 (Solicitation Management) which publishes solicitations
and invites candidate LLOs. Phase 7 takes over once an awardee exists.

Drops the llo-invite skill from the agent's skill list (it moves to
Phase 6 in a later commit). Renumbers internal step numbering.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Build the connect-labs MCP stdio proxy

**Files:**
- Create: `mcp/connect-labs-server.ts`
- Create: `test/mcp/connect-labs/proxy.test.ts`

**Why a proxy.** The labs MCP runs as remote HTTP at `https://labs.connect.dimagi.com/mcp/`. ACE's existing MCP wiring (`.claude-plugin/plugin.json`) only uses stdio MCPs (`command + args`). Rather than experiment with whether plugin.json supports `type: "http"` mcpServers, write a thin local stdio proxy that forwards JSON-RPC frames to labs over HTTP and injects the bearer PAT. Same shape as `mcp/google-drive-server.ts`, `mcp/ocs-server.ts`, etc.

- [ ] **Step 1: Write the failing test**

Create `test/mcp/connect-labs/proxy.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';

const PROXY_PATH = path.resolve(__dirname, '../../../mcp/connect-labs-server.ts');

describe('connect-labs-server (stdio → HTTP proxy)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards a JSON-RPC frame to labs with Bearer auth and returns the body', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    // The proxy is launched as a subprocess in real use; here we import its forward()
    // function directly for unit testing.
    const { forward } = await import('../../../mcp/connect-labs-server');
    const out = await forward(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { token: 'test-token', url: 'https://labs.example/mcp/' },
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [calledUrl, init] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe('https://labs.example/mcp/');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'Authorization': 'Bearer test-token',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    expect(out).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  });

  it('returns a JSON-RPC error envelope when the upstream returns 401', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'PERMISSION_DENIED', message: 'bad token' } }), {
        status: 401,
      }),
    );
    const { forward } = await import('../../../mcp/connect-labs-server');
    const out = await forward(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { token: 'bad', url: 'https://labs.example/mcp/' },
    );
    expect(out).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      error: {
        code: -32000,
        message: expect.stringContaining('401'),
      },
    });
  });

  it('throws if LABS_MCP_TOKEN is empty when invoked without an explicit token', async () => {
    const { forward } = await import('../../../mcp/connect-labs-server');
    await expect(
      forward({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { token: '', url: 'https://labs.example/mcp/' }),
    ).rejects.toThrow(/LABS_MCP_TOKEN/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run test/mcp/connect-labs/proxy.test.ts`

Expected: FAIL with "Cannot find module '../../../mcp/connect-labs-server'".

- [ ] **Step 3: Implement the proxy**

Create `mcp/connect-labs-server.ts`:

```typescript
#!/usr/bin/env tsx
/**
 * connect-labs-server: stdio MCP proxy to labs.connect.dimagi.com/mcp/.
 *
 * Reads LABS_MCP_TOKEN from ${CLAUDE_PLUGIN_DATA}/.env (legacy fallback:
 * plugin root .env), then forwards every JSON-RPC frame received on stdin
 * over HTTPS to the labs MCP, injecting `Authorization: Bearer <token>`.
 * The HTTP response body is written back to stdout as a single line.
 *
 * Stays a stdio MCP because ACE's plugin.json only wires stdio mcpServers
 * (verified via grep: every existing entry uses `command + args`). When
 * Claude Code's plugin.json gains first-class HTTP MCP support, this
 * proxy can be deleted in favor of a direct `type: "http"` entry.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export interface JsonRpcFrame {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ForwardOpts {
  token: string;
  url: string;
}

export async function forward(frame: JsonRpcFrame, opts: ForwardOpts): Promise<JsonRpcFrame> {
  if (!opts.token) {
    throw new Error('LABS_MCP_TOKEN is required to forward to labs MCP');
  }
  const res = await fetch(opts.url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${opts.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(frame),
  });
  if (!res.ok) {
    return {
      jsonrpc: '2.0',
      id: frame.id,
      error: {
        code: -32000,
        message: `labs MCP returned ${res.status}: ${await res.text()}`,
      },
    };
  }
  return (await res.json()) as JsonRpcFrame;
}

function loadEnvFile(path: string): Record<string, string> {
  try {
    const txt = readFileSync(path, 'utf8');
    const out: Record<string, string> = {};
    for (const line of txt.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

function loadToken(): string {
  if (process.env.LABS_MCP_TOKEN) return process.env.LABS_MCP_TOKEN;
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  if (dataDir) {
    const fromData = loadEnvFile(join(dataDir, '.env')).LABS_MCP_TOKEN;
    if (fromData) return fromData;
  }
  const rootEcho = process.env.CLAUDE_PLUGIN_ROOT_ECHO;
  if (rootEcho) {
    const fromRoot = loadEnvFile(join(rootEcho, '.env')).LABS_MCP_TOKEN;
    if (fromRoot) return fromRoot;
  }
  return '';
}

async function main() {
  const token = loadToken();
  const url = process.env.LABS_MCP_URL || 'https://labs.connect.dimagi.com/mcp/';

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let frame: JsonRpcFrame;
    try {
      frame = JSON.parse(trimmed) as JsonRpcFrame;
    } catch (e) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: `Parse error: ${(e as Error).message}` },
      }) + '\n');
      continue;
    }
    try {
      const reply = await forward(frame, { token, url });
      process.stdout.write(JSON.stringify(reply) + '\n');
    } catch (e) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: frame.id,
        error: { code: -32000, message: (e as Error).message },
      }) + '\n');
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`connect-labs-server fatal: ${(e as Error).stack || e}\n`);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --run test/mcp/connect-labs/proxy.test.ts`

Expected: 3/3 pass.

- [ ] **Step 5: Commit**

```bash
git add mcp/connect-labs-server.ts test/mcp/connect-labs/proxy.test.ts
git commit -m "feat(mcp): add connect-labs stdio proxy to labs MCP

Forwards JSON-RPC frames from Claude Code (stdio) to
labs.connect.dimagi.com/mcp/ (HTTP) with Bearer PAT injected from
LABS_MCP_TOKEN. Same shape as the other ACE MCP servers.

Plugin.json wiring + .env.tpl + doctor checks land in subsequent commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire LABS_MCP_TOKEN into `.env.tpl` and `plugin.json`

**Files:**
- Modify: `.env.tpl`
- Modify: `.claude-plugin/plugin.json`

- [ ] **Step 1: Add the env var to `.env.tpl`**

Append to `.env.tpl` (after the existing Connect block):

```
# Connect Labs (solicitations / reviews / awards) — labs.connect.dimagi.com
# Bearer PAT for the labs MCP, scoped to the ace@dimagi-ai.com labs user.
# To rotate: a labs admin runs:
#   python manage.py mcp_create_token --user ace@dimagi-ai.com --name ACE-plugin --ttl-days 0
# then drops the printed token into the 1Password item below.
LABS_MCP_TOKEN=op://Dimagi/labs-mcp-pat-ace/credential
```

- [ ] **Step 2: Add the MCP entry to `plugin.json`**

In `.claude-plugin/plugin.json`, append a new entry under `mcpServers` (after the existing `ace-mobile` entry):

```jsonc
"connect-labs": {
  "command": "npx",
  "args": ["tsx", "${CLAUDE_PLUGIN_ROOT}/mcp/connect-labs-server.ts"],
  "env": {
    "CLAUDE_PLUGIN_DATA": "${CLAUDE_PLUGIN_DATA}",
    "CLAUDE_PLUGIN_ROOT_ECHO": "${CLAUDE_PLUGIN_ROOT}"
  }
}
```

Note: the proxy reads `LABS_MCP_TOKEN` from `${CLAUDE_PLUGIN_DATA}/.env` itself (see Task 3 step 3) — passing `CLAUDE_PLUGIN_DATA` is enough; we do not put the token directly in plugin.json's `env` block.

- [ ] **Step 3: Verify the manifest still parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json', 'utf8'))"`

Expected: no output, exit 0.

- [ ] **Step 4: Verify the marketplace mirror is in sync**

Run: `node -e "const m = JSON.parse(require('fs').readFileSync('.claude-plugin/marketplace.json', 'utf8'));"`

Expected: no output, exit 0. (The version-sync hook keeps marketplace.json in sync with plugin.json on commit.)

- [ ] **Step 5: Commit**

```bash
git add .env.tpl .claude-plugin/plugin.json
git commit -m "feat(mcp): wire connect-labs MCP into plugin manifest

Adds the connect-labs stdio proxy to mcpServers and LABS_MCP_TOKEN to
.env.tpl. After op inject, ACE skills can call mcp__connect-labs__*
atoms (create_solicitation, list_responses, award_response, etc.).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Add `[Connect Labs]` doctor section

**Files:**
- Modify: `bin/ace-doctor`
- Create: `test/doctor/connect-labs.test.ts`

- [ ] **Step 1: Find the existing pattern**

Read `bin/ace-doctor` and locate the `[Connect]` section (anchor: a line beginning with `## ` or printing a `[Connect]` header). Note the style: each check prints a tag (e.g. `connect_env`, `connect_session`) followed by `OK | WARN | FAIL` and a one-liner explanation.

- [ ] **Step 2: Write the failing test**

Create `test/doctor/connect-labs.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The doctor module exports check functions (assumes bin/ace-doctor has been
// refactored to expose ts-importable helpers; if not, this test invokes them
// via subprocess).

describe('doctor [Connect Labs] checks', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('connect_labs_env: FAIL when LABS_MCP_TOKEN missing', async () => {
    const { checkConnectLabsEnv } = await import('../../bin/checks/connect-labs');
    const result = await checkConnectLabsEnv({ envFile: 'test/fixtures/empty.env' });
    expect(result.tag).toBe('connect_labs_env');
    expect(result.status).toBe('FAIL');
    expect(result.message).toMatch(/LABS_MCP_TOKEN/);
  });

  it('connect_labs_env: OK when token present', async () => {
    const { checkConnectLabsEnv } = await import('../../bin/checks/connect-labs');
    const result = await checkConnectLabsEnv({ envFile: 'test/fixtures/with-labs-token.env' });
    expect(result.status).toBe('OK');
  });

  it('connect_labs_mcp_reachable: FAIL on 401 (PAT bad)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 401 }));
    const { checkConnectLabsReachable } = await import('../../bin/checks/connect-labs');
    const result = await checkConnectLabsReachable({ token: 'bad', url: 'https://labs.example/mcp/' });
    expect(result.status).toBe('FAIL');
    expect(result.message).toMatch(/PAT|401/);
  });

  it('connect_labs_mcp_reachable: OK on 200', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { status: 200 }),
    );
    const { checkConnectLabsReachable } = await import('../../bin/checks/connect-labs');
    const result = await checkConnectLabsReachable({ token: 'good', url: 'https://labs.example/mcp/' });
    expect(result.status).toBe('OK');
  });

  it('connect_labs_connect_oauth: WARN with actionable hint when tool returns PERMISSION_DENIED', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'PERMISSION_DENIED: connect oauth required' },
      }), { status: 200 }),
    );
    const { checkConnectLabsConnectOAuth } = await import('../../bin/checks/connect-labs');
    const result = await checkConnectLabsConnectOAuth({ token: 'good', url: 'https://labs.example/mcp/' });
    expect(result.status).toBe('WARN');
    expect(result.message).toMatch(/Connect OAuth/);
  });

  it('connect_labs_connect_oauth: OK on a successful tools/call list_solicitations', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: '[]' }] },
      }), { status: 200 }),
    );
    const { checkConnectLabsConnectOAuth } = await import('../../bin/checks/connect-labs');
    const result = await checkConnectLabsConnectOAuth({ token: 'good', url: 'https://labs.example/mcp/' });
    expect(result.status).toBe('OK');
  });
});
```

Also create test fixture files:
- `test/fixtures/empty.env` — empty file
- `test/fixtures/with-labs-token.env` — single line `LABS_MCP_TOKEN=test-token`

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- --run test/doctor/connect-labs.test.ts`

Expected: FAIL with "Cannot find module '../../bin/checks/connect-labs'".

- [ ] **Step 4: Implement the check helpers**

Create `bin/checks/connect-labs.ts`:

```typescript
import { readFileSync } from 'node:fs';

export interface CheckResult {
  tag: string;
  status: 'OK' | 'WARN' | 'FAIL';
  message: string;
}

function parseEnvFile(path: string): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

export async function checkConnectLabsEnv(opts: { envFile: string }): Promise<CheckResult> {
  const env = parseEnvFile(opts.envFile);
  const token = env.LABS_MCP_TOKEN;
  if (!token || token.startsWith('op://')) {
    return {
      tag: 'connect_labs_env',
      status: 'FAIL',
      message: 'LABS_MCP_TOKEN missing or unrendered. Run: op inject -i .env.tpl -o "$CLAUDE_PLUGIN_DATA/.env" --account dimagi.1password.com',
    };
  }
  return { tag: 'connect_labs_env', status: 'OK', message: 'LABS_MCP_TOKEN present' };
}

export async function checkConnectLabsReachable(opts: { token: string; url: string }): Promise<CheckResult> {
  try {
    const res = await fetch(opts.url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${opts.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    if (res.status === 401) {
      return { tag: 'connect_labs_mcp_reachable', status: 'FAIL', message: 'Labs MCP returned 401 — PAT invalid or revoked. Rotate via mcp_create_token.' };
    }
    if (!res.ok) {
      return { tag: 'connect_labs_mcp_reachable', status: 'FAIL', message: `Labs MCP returned ${res.status}` };
    }
    return { tag: 'connect_labs_mcp_reachable', status: 'OK', message: 'Labs MCP reachable + PAT accepted' };
  } catch (e) {
    return { tag: 'connect_labs_mcp_reachable', status: 'FAIL', message: `Cannot reach labs MCP: ${(e as Error).message}` };
  }
}

export async function checkConnectLabsConnectOAuth(opts: { token: string; url: string }): Promise<CheckResult> {
  try {
    const res = await fetch(opts.url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${opts.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_solicitations', arguments: {} },
      }),
    });
    const body = await res.json() as { error?: { message: string }; result?: unknown };
    if (body.error?.message?.includes('PERMISSION_DENIED') || body.error?.message?.includes('connect')) {
      return {
        tag: 'connect_labs_connect_oauth',
        status: 'WARN',
        message: 'Labs accepts the PAT but the ace user has not completed Connect OAuth linkage. Have ace@dimagi-ai.com sign into labs once and authorize Connect.',
      };
    }
    if (body.error) {
      return { tag: 'connect_labs_connect_oauth', status: 'FAIL', message: `list_solicitations error: ${body.error.message}` };
    }
    return { tag: 'connect_labs_connect_oauth', status: 'OK', message: 'list_solicitations responded — Connect OAuth bridge is live' };
  } catch (e) {
    return { tag: 'connect_labs_connect_oauth', status: 'FAIL', message: `Probe failed: ${(e as Error).message}` };
  }
}
```

- [ ] **Step 5: Wire the helpers into `bin/ace-doctor`**

Locate the section in `bin/ace-doctor` that prints `[Connect]` (right before or after the OCS section). After it, add a new `[Connect Labs]` section that calls the three helpers via a small TypeScript invocation. Mirror the existing pattern — if `bin/ace-doctor` is already a bash script that shells into a TS helper for the Connect section, do the same for Connect Labs. If it's pure bash that does HTTP via curl, port the three checks to bash equivalents that call the same `tag/status/message` shape.

If `bin/ace-doctor` is a thin bash wrapper around `tsx`, add a single block:

```bash
echo ""
echo "[Connect Labs]"
npx tsx -e "
import { checkConnectLabsEnv, checkConnectLabsReachable, checkConnectLabsConnectOAuth } from './bin/checks/connect-labs';
import { join } from 'node:path';
const dataDir = process.env.CLAUDE_PLUGIN_DATA || process.env.HOME + '/.ace';
const envFile = join(dataDir, '.env');
const tokenEntry = (await checkConnectLabsEnv({ envFile }));
console.log(\`  \${tokenEntry.tag.padEnd(36)} \${tokenEntry.status.padEnd(4)} \${tokenEntry.message}\`);
if (tokenEntry.status === 'OK') {
  const env = require('fs').readFileSync(envFile, 'utf8');
  const token = env.match(/LABS_MCP_TOKEN=(.+)/)?.[1]?.trim() || '';
  const url = process.env.LABS_MCP_URL || 'https://labs.connect.dimagi.com/mcp/';
  for (const check of [checkConnectLabsReachable, checkConnectLabsConnectOAuth]) {
    const r = await check({ token, url });
    console.log(\`  \${r.tag.padEnd(36)} \${r.status.padEnd(4)} \${r.message}\`);
  }
}
"
```

(Adjust to match the actual style and indentation of the existing `[Connect]` section. The principle is: read the env file, run the three checks in order, print one line per check.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- --run test/doctor/connect-labs.test.ts`

Expected: 6/6 pass.

- [ ] **Step 7: Smoke `/ace:doctor` locally**

Run: `bin/ace-doctor`

Expected output includes a `[Connect Labs]` section with three `OK/WARN/FAIL` lines. With no PAT yet provisioned, `connect_labs_env` should be FAIL with the actionable `op inject` hint.

- [ ] **Step 8: Commit**

```bash
git add bin/ace-doctor bin/checks/connect-labs.ts test/doctor/connect-labs.test.ts test/fixtures/empty.env test/fixtures/with-labs-token.env
git commit -m "feat(doctor): add [Connect Labs] section with token + OAuth probes

Three checks, mirroring the [Connect] section pattern:
- connect_labs_env: LABS_MCP_TOKEN present and rendered (not op://)
- connect_labs_mcp_reachable: PAT accepted by labs MCP (distinguishes
  401 / network / OK)
- connect_labs_connect_oauth: list_solicitations probe distinguishes
  PAT-level 401 from tool-level PERMISSION_DENIED (Connect OAuth missing
  on the ace user's labs account)

Class-level preventer for silent labs misconfig.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Add three optional fields to the PDD template

**Files:**
- Modify: `templates/pdd-template.md`
- Modify: `skills/idea-to-pdd/SKILL.md`

- [ ] **Step 1: Append the new fields to the PDD template**

Read `templates/pdd-template.md`. After the existing `total_budget:` field (or at the end of the PDD frontmatter / metadata block, wherever budget lives), add:

```yaml
# ── Solicitation (optional, drives Phase 6) ────────────────────────────
# These fields are read by `solicitation-create` to build the solicitation
# published to labs.connect.dimagi.com. Safe to omit — defaults below.
solicitation_type: EOI                # 'EOI' (Expression of Interest) | 'RFP' (Request for Proposals)
solicitation_deadline_days: 14        # response window from publish date
llo_questions:                        # optional response template
  - "Describe your prior experience deploying CHW programs in this archetype."
  - "How will you recruit and train FLWs for this scope?"
  - "What is your timeline for fielding once awarded?"
  - "What is your supervision model?"
  - "Do you have local-language capacity matching the target geography?"
  - "Provide a budget breakdown for the proposed scope."

# ── Preferred LLOs (optional, used by Phase 6 llo-invite) ──────────────
preferred_llos: []                    # list of { name, contact_email, organization_slug }
```

(If `preferred_llos` already exists in the PDD template under another section, do not duplicate — only add the three new solicitation fields. Run `grep -n "preferred_llos" templates/pdd-template.md` first to verify.)

- [ ] **Step 2: Update `idea-to-pdd` SKILL.md**

In `skills/idea-to-pdd/SKILL.md`, locate the section that walks the agent through PDD field collection. Add a paragraph noting the three new optional fields and that they default sensibly:

> **Solicitation fields (optional, Phase 6).** If the user names preferred LLOs or a non-default solicitation type/deadline, capture them. Defaults: `solicitation_type: EOI`, `solicitation_deadline_days: 14`, a generic 6-question response template. Skipping these is fine — Phase 6 will use the defaults. Always ask once whether a custom deadline or response template is needed; if not, leave the defaults.

- [ ] **Step 3: Verify existing PDD fixtures still validate**

Run: `npm test -- --run test/fixtures/`

Expected: pass. The new fields are optional, so existing fixtures (`CRISPR-Test-001`, `-002`, `-003`) without them remain valid.

- [ ] **Step 4: Commit**

```bash
git add templates/pdd-template.md skills/idea-to-pdd/SKILL.md
git commit -m "feat(pdd): add three optional solicitation fields to PDD template

solicitation_type (EOI|RFP, default EOI), solicitation_deadline_days
(default 14), llo_questions (default 6-question template). All optional;
existing PDDs without them continue to validate. Drives the new Phase 6
solicitation-create skill.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Implement `solicitation-create` skill

**Files:**
- Create: `skills/solicitation-create/SKILL.md`
- Modify: `lib/artifact-manifest.ts` (add solicitation/draft.md, solicitation/published.md, opp.yaml.solicitation block)

- [ ] **Step 1: Add the artifact manifest entries**

In `lib/artifact-manifest.ts`, locate the `ARTIFACT_MANIFEST` array. After the last existing entry, add:

```typescript
// ── Solicitation Management (Phase 6) ──────────────────────────

{
  path: 'solicitation/draft.md',
  producedBy: 'solicitation-create',
  consumedBy: ['solicitation-create-eval'],
  phase: 'design',  // produced once, audit-only
  required: false,
  description: 'Solicitation payload pre-publish: title, type, scope, criteria, response template, deadline. Audit trail for what solicitation-create proposed before posting to labs.',
},
{
  path: 'solicitation/published.md',
  producedBy: 'solicitation-create',
  consumedBy: ['solicitation-monitor', 'solicitation-review', 'solicitation-create-eval', 'llo-invite'],
  phase: 'design',
  required: false,
  description: 'Snapshot of the published solicitation: solicitation_id, public_url, manage_url, deadline, criteria. Read by every downstream Phase 6 skill and by Phase 6 llo-invite for the URL to email.',
},
{
  path: 'solicitation/invitations.md',
  producedBy: 'llo-invite',
  consumedBy: ['solicitation-monitor', 'solicitation-review-eval'],
  phase: 'design',
  required: false,
  description: 'Per-recipient log: who got emailed the solicitation URL, when, and send status. Empty when PDD has no preferred_llos.',
},
{
  path: 'solicitation/responses/',
  producedBy: 'solicitation-monitor',
  consumedBy: ['solicitation-review'],
  phase: 'design',
  required: false,
  description: 'One file per solicitation response, written incrementally as responses arrive. Each file contains the response content plus metadata returned by labs.',
},
{
  path: 'solicitation/review/scoring-rubric.md',
  producedBy: 'solicitation-review',
  consumedBy: ['solicitation-review-eval'],
  phase: 'design',
  required: false,
  description: 'Per-response, per-criterion scores produced by solicitation-review.',
},
{
  path: 'solicitation/review/recommendation.md',
  producedBy: 'solicitation-review',
  consumedBy: ['solicitation-review-eval'],
  phase: 'design',
  required: false,
  description: 'Ranked candidates + reasoning. Input to the HITL gate before award_response is called.',
},
{
  path: 'solicitation/award-record.md',
  producedBy: 'solicitation-review',
  consumedBy: ['solicitation-review-eval', 'opp-closeout'],
  phase: 'design',
  required: false,
  description: 'Written when award_response is called (success or failure). Includes response_id, awarded_at, awarded_org_slug, and any error envelope on failure.',
},
```

Also drop the existing entry for `connect-setup/invites.md` (the old `llo-invite` artifact). Locate it in the manifest (`grep -n "connect-setup/invites" lib/artifact-manifest.ts`) and delete that block.

- [ ] **Step 2: Run the manifest validation test**

Run: `npm test -- --run test/fixtures/artifact-manifest.test.ts`

Expected: PASS (or fail with a clear "skill `solicitation-create` referenced by artifact but no SKILL.md found" — that's the next step). If it passes, the validation isn't strict enough to catch missing skills; that's fine, we'll add the skill next.

- [ ] **Step 3: Write the SKILL.md**

Create `skills/solicitation-create/SKILL.md`:

```markdown
---
name: solicitation-create
description: >
  Phase 6 step 1 (auto, default run). Translate the approved PDD into a
  solicitation payload, derive evaluation criteria via labs's
  generate_criteria endpoint, and publish the solicitation via the
  connect-labs MCP. Captures solicitation_id and public_url for downstream
  skills.
---

# Solicitation Create

Phase 6 default-run skill. Builds and publishes the solicitation in one
shot — ACE always publishes, never drafts. The solicitation can be edited
post-publish via the labs UI without affecting responses.

## Inputs

- `ACE/<opp-name>/inputs/pdd.md` — approved PDD (scope, success criteria, total_budget, optional solicitation fields)
- `ACE/<opp-name>/opp.yaml` — program_id, archetype, opp display name

## Process

1. **Read the PDD.** Extract the fields per the table below. For optional
   PDD fields (`solicitation_type`, `solicitation_deadline_days`,
   `llo_questions`), use defaults when missing.

2. **Build the solicitation payload:**

   | Field | Source |
   |---|---|
   | `title` | `<solicitation_type>: <pdd.title> — <pdd.archetype>` |
   | `solicitation_type` | PDD `solicitation_type` (default `EOI`) |
   | `description` | PDD `intervention_summary` + `target_flw_profile` (concatenate with a newline) |
   | `scope_of_work` | PDD `visit_structure` + `success_criteria` |
   | `budget` | PDD `total_budget` |
   | `deadline` | `now() + (solicitation_deadline_days || 14)` days, ISO-8601 |
   | `evaluation_criteria` | derived by `generate_criteria` (see step 3) |
   | `response_template` | PDD `llo_questions` or the default 6-question set |
   | `status` | `published` |
   | `program_id` | `opp.yaml.program_id` |

3. **Derive evaluation criteria.** Call:

   ```
   mcp__connect-labs__generate_criteria(
     scope_text: <description + scope_of_work>,
     archetype: <pdd.archetype>
   )
   ```

   Capture the structured rubric (criteria + weights) into the payload's
   `evaluation_criteria` field.

4. **Write the draft for traceability.** Save the full payload + the AI-derived rubric to:

   ```
   ACE/<opp-name>/solicitation/draft.md
   ```

5. **Publish.** Call:

   ```
   mcp__connect-labs__create_solicitation(<payload>)
   ```

   Capture the returned `solicitation_id`, `public_url`, and `manage_url`.

6. **Write `published.md`.** Save:

   ```
   ACE/<opp-name>/solicitation/published.md
   ```

   Body includes the full payload, the returned IDs/URLs, and the deadline
   in absolute ISO-8601 form.

7. **Update `opp.yaml`.** Add a `solicitation:` block:

   ```yaml
   solicitation:
     solicitation_id: <returned>
     public_url: <returned>
     manage_url: <returned>
     type: <EOI|RFP>
     published_at: <now ISO-8601>
     deadline: <computed ISO-8601>
     status: open
     awarded:
       response_id: null
       awarded_at: null
       awarded_org_slug: null
       awarded_org_name: null
       awarded_contact_email: null
       award_amount: null
   ```

   Also stub a `selected_llo:` block:

   ```yaml
   selected_llo:
     org_slug: null
     contact_email: null
     source: null
     response_id: null
   ```

   These will be populated by `solicitation-review` on award.

## Error handling

- **Labs MCP unreachable** (proxy returns transport error): halt with a
  doctor-style message pointing at `/ace:doctor`'s `[Connect Labs]`
  section.
- **`create_solicitation` returns 4xx**: preserve `draft.md`, halt, surface
  the error verbatim. Do not retry — most 4xx is a payload schema mismatch
  or the program_id is wrong.
- **`generate_criteria` returns degenerate output** (empty list, single
  criterion): write what was returned, mark `evaluation_criteria` as
  `needs-review` in `published.md`, still publish. Criteria are editable
  post-publish via labs UI without losing responses.

## Output

- `ACE/<opp-name>/solicitation/draft.md` (audit)
- `ACE/<opp-name>/solicitation/published.md` (live state)
- `opp.yaml.solicitation.{solicitation_id, public_url, deadline, status: open}` populated
- `opp.yaml.selected_llo.*` stubbed
```

- [ ] **Step 4: Run the manifest validation test**

Run: `npm test -- --run test/fixtures/artifact-manifest.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/solicitation-create/ lib/artifact-manifest.ts
git commit -m "feat(skill): add solicitation-create (Phase 6, default run)

Translates the approved PDD into a solicitation payload, derives
evaluation criteria via labs's generate_criteria, and publishes via
mcp__connect-labs__create_solicitation. Writes draft.md (audit) and
published.md (live state), populates opp.yaml.solicitation.

Manifest entries: drops connect-setup/invites.md (moves to Phase 6 in
a later commit), adds solicitation/* artifacts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Add `solicitation-create-eval` rubric

**Files:**
- Create: `skills/solicitation-create-eval/SKILL.md`

- [ ] **Step 1: Read the existing eval rubric pattern**

Read `skills/connect-program-setup-eval/SKILL.md` to align style and structure with the existing `-eval` family.

- [ ] **Step 2: Write the SKILL.md**

Create `skills/solicitation-create-eval/SKILL.md`:

```markdown
---
name: solicitation-create-eval
description: >
  Provisional LLM-as-Judge rubric for solicitation-create. Grades whether
  the published solicitation faithfully reflects the PDD's intervention
  scope, has complete fields, and ships a sensible deadline. Calibrated
  per skills/eval-calibration once 3+ real solicitations have shipped.
---

# Solicitation Create — Eval

Cross-artifact LLM-as-Judge eval. Reads the source PDD plus
`solicitation/draft.md` and `solicitation/published.md`, scores the
result, and writes a verdict YAML in the shared QA/eval shape so
`opp-eval` can aggregate it.

**Status:** Provisional. Calibration TBD until 3+ real solicitations have
shipped — see `skills/eval-calibration/SKILL.md`.

## Inputs

- `ACE/<opp-name>/inputs/pdd.md`
- `ACE/<opp-name>/solicitation/draft.md`
- `ACE/<opp-name>/solicitation/published.md`

## Rubric

Score each dimension 0-10. Hard-deduct rules listed inline.

1. **PDD-fidelity (weight 0.4).** Does the solicitation's `description`
   and `scope_of_work` actually carry the PDD's intervention summary,
   target FLW profile, and visit structure forward? Hard-deduct -3 if
   either field paraphrases away a PDD constraint (e.g. PDD says "weekly
   visits" and solicitation says "regular visits"). Hard-deduct -5 if a
   key PDD element is missing entirely.

2. **Field completeness (weight 0.2).** All required fields present?
   `evaluation_criteria` non-empty (or marked `needs-review`)?
   `response_template` non-empty?

3. **Deadline sanity (weight 0.1).** Deadline is `now + 7..30 days`. Hard-
   deduct -5 if deadline is in the past or > 90 days out.

4. **Criteria alignment (weight 0.3).** Do the evaluation criteria reflect
   what the PDD actually cares about (e.g. archetype-specific capabilities,
   geographic fit, language capacity)? Penalize generic criteria like
   "demonstrate experience" when the PDD has specific archetype demands.

## Verdict shape

Write `verdicts/solicitation-create-<mode>.yaml` per the `lib/verdict-schema.ts`
shape (see `skills/README.md` § QA vs Eval).

```yaml
schema_version: 1
skill: solicitation-create
mode: deep
overall_score: <0-10 weighted>
overall_verdict: pass | fail | partial
dimensions:
  - { name: pdd-fidelity,        score: <0-10>, weight: 0.4, notes: "..." }
  - { name: field-completeness,  score: <0-10>, weight: 0.2, notes: "..." }
  - { name: deadline-sanity,     score: <0-10>, weight: 0.1, notes: "..." }
  - { name: criteria-alignment,  score: <0-10>, weight: 0.3, notes: "..." }
hard_deduct_triggered: [ ... ]
recommendations: [ ... ]
```
```

- [ ] **Step 3: Run vitest to verify the manifest doesn't break**

Run: `npm test -- --run test/fixtures/artifact-manifest.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add skills/solicitation-create-eval/
git commit -m "feat(skill): add solicitation-create-eval rubric (provisional)

PDD-fidelity, field completeness, deadline sanity, criteria alignment.
Provisional rubric — calibration TBD per skills/eval-calibration once 3+
real solicitations have shipped.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Implement `solicitation-monitor` skill

**Files:**
- Create: `skills/solicitation-monitor/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

Create `skills/solicitation-monitor/SKILL.md`:

```markdown
---
name: solicitation-monitor
description: >
  Phase 6 recurring skill. Polls labs for new responses while the
  solicitation is open, writes one file per response to
  ACE/<opp>/solicitation/responses/, and appends a tick line to the
  observation log. Three modes: --quick (count only), --monitor (full
  pull, default), --close (final pull when deadline passes).
---

# Solicitation Monitor

Recurring skill that runs while `opp.yaml.solicitation.status == open`.
Mirrors the `ocs-chatbot-qa` recurring pattern (`--quick`/`--monitor`).

## Modes

- **`--quick`**: just count responses; do not pull bodies. Cheap.
  Suitable for the orchestrator's recurring check.
- **`--monitor`** (default): for each new response, pull the body and
  write `solicitation/responses/<response_id>.md`.
- **`--close`**: same as `--monitor` but also flips `opp.yaml.solicitation.status`
  from `open` to `closed`. Run once when the deadline passes.

## Inputs

- `opp.yaml.solicitation.solicitation_id`
- `opp.yaml.solicitation.deadline`

## Process (--monitor)

1. **List responses.** Call:

   ```
   mcp__connect-labs__list_responses(solicitation_id: <id>)
   ```

2. **Diff against local state.** Read existing files in
   `ACE/<opp-name>/solicitation/responses/` (each is named
   `<response_id>.md`). For each new response:

   ```
   mcp__connect-labs__get_response(response_id: <id>)
   ```

   Write the body to `solicitation/responses/<response_id>.md`. Body
   includes: response_id, submitted_at, organization, contact, the answers
   to each question in the response template, and any attachments.

3. **Summarize inflow.** Compute:
   - Total responses received
   - Responses received since the last monitor tick
   - Time-to-deadline (delta between `now()` and `solicitation.deadline`)
   - If `solicitation/invitations.md` exists: list of invitees who have
     not yet responded.

4. **Append observation.** Append a single line to
   `ACE/<opp-name>/comms-log/observations.md`:

   ```
   <ISO-8601>  solicitation-monitor  <count> total responses (<+N> new since last tick), <H>h to deadline
   ```

5. **Update `opp.yaml`.** If mode is `--close` AND `now() > deadline`, set
   `opp.yaml.solicitation.status: closed`.

## Process (--quick)

Steps 1, 3 (counts only), 4. Skip body pulls and per-response file writes.

## Error handling

Read-only skill from labs's perspective; failures are non-fatal.
Log "monitor failed: <reason>" to `comms-log/observations.md` and exit
without halting the orchestrator. Next tick will retry.

## Output

- New files in `ACE/<opp-name>/solicitation/responses/`
- Tick line in `ACE/<opp-name>/comms-log/observations.md`
- (`--close` only) `opp.yaml.solicitation.status: closed`

## No eval companion

`solicitation-monitor` is read-only and recurring. Quality bar is captured
by `solicitation-review-eval` downstream.
```

- [ ] **Step 2: Run the manifest validation**

Run: `npm test -- --run test/fixtures/artifact-manifest.test.ts`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add skills/solicitation-monitor/
git commit -m "feat(skill): add solicitation-monitor (Phase 6 recurring)

Polls labs for responses, writes one file per response, appends a tick
line to comms-log/observations.md. Three modes: --quick, --monitor
(default), --close (flip status to closed when deadline passes).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Implement `solicitation-review` skill (manual, with HITL gate)

**Files:**
- Create: `skills/solicitation-review/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

Create `skills/solicitation-review/SKILL.md`:

```markdown
---
name: solicitation-review
description: >
  Phase 6 manual skill. Reads all solicitation responses, scores each
  against the published rubric, presents a recommendation to the human,
  and (after explicit HITL approval) calls award_response and populates
  opp.yaml.selected_llo. The only path that unblocks Phase 7.
---

# Solicitation Review

Manual skill — never runs in default `/ace:run`. Only via:

```
/ace:step solicitation-review --opp <opp-name>
```

This is the only skill that calls `award_response` (irreversible) and the
only skill that populates `opp.yaml.selected_llo` (which gates Phase 7).

## Inputs

- `opp.yaml.solicitation.solicitation_id`
- `opp.yaml.solicitation.public_url`
- `ACE/<opp-name>/solicitation/published.md` (rubric)
- `ACE/<opp-name>/solicitation/responses/*.md` (all responses)

## Process

1. **Pull all responses fresh.** Call:

   ```
   mcp__connect-labs__list_responses(solicitation_id: <id>)
   ```

   For each response, call `get_response` even if the local cache exists
   (responses may have been edited).

2. **Score each response.** Read the rubric from `published.md` (the
   `evaluation_criteria` block). For each response, score every criterion
   on its declared scale (typically 1-10) and compute a weighted total.

3. **Optionally write to labs.** For each response, call:

   ```
   mcp__connect-labs__create_review(
     response_id: <id>,
     scores: { <criterion_id>: <score>, ... },
     notes: "<reasoning>"
   )
   ```

   This puts ACE's scores in the labs audit trail. Idempotent — call
   `list_reviews` first and skip if a review by `ace@dimagi-ai.com` already
   exists for this response.

4. **Write `scoring-rubric.md`.** Save the per-response, per-criterion
   scores to:

   ```
   ACE/<opp-name>/solicitation/review/scoring-rubric.md
   ```

5. **Write `recommendation.md`.** Save:

   ```
   ACE/<opp-name>/solicitation/review/recommendation.md
   ```

   Body: ranked list of candidates with reasoning. Top candidate gets a
   `Recommended awardee` callout.

6. **HITL gate.** Present `recommendation.md` to the human and ask:

   > "Confirm awarding response_id=<top> ($<amount>) to <org_name>? Reply
   > 'award <response_id> $<amount>' to confirm, or 'cancel' to halt."

   Wait for an explicit reply. **Do not call `award_response` without one.**
   If the human picks a different response_id or amount, use those.

7. **Call `award_response`.** On confirm:

   ```
   mcp__connect-labs__award_response(
     response_id: <chosen>,
     amount: <chosen_amount>
   )
   ```

8. **Write `award-record.md`.**

   ```
   ACE/<opp-name>/solicitation/award-record.md
   ```

   Body: `response_id`, `awarded_at`, `awarded_org_slug`, `awarded_org_name`,
   `awarded_contact_email`, `award_amount`, and (if labs returned an error)
   `status: failed` + the error envelope.

9. **Populate `opp.yaml.selected_llo`.** Only on a successful award:

   ```yaml
   selected_llo:
     org_slug: <returned>
     contact_email: <returned>
     source: solicitation
     response_id: <chosen>
   ```

   Also flip `opp.yaml.solicitation.status: awarded` and populate the
   `solicitation.awarded.*` block.

## Error handling

- **HITL gate timeout / no reply**: do not call `award_response`. Do not
  mutate `opp.yaml`. Exit cleanly so the human can re-run the skill.
- **`award_response` returns 4xx after approval**: write `award-record.md`
  with `status: failed` and the error envelope. **Do not** populate
  `selected_llo` (Phase 7 stays gated). Surface the error to the human
  and suggest contacting a labs admin if the award call must succeed
  out-of-band.
- **`list_reviews` shows ACE already reviewed all responses**: skip the
  scoring step (we don't re-score), proceed to step 4 from the existing
  reviews.

## Output

- `ACE/<opp-name>/solicitation/review/scoring-rubric.md`
- `ACE/<opp-name>/solicitation/review/recommendation.md`
- `ACE/<opp-name>/solicitation/award-record.md`
- `opp.yaml.selected_llo.*` populated (only on success)
- `opp.yaml.solicitation.status: awarded` (only on success)
```

- [ ] **Step 2: Commit**

```bash
git add skills/solicitation-review/
git commit -m "feat(skill): add solicitation-review (Phase 6 manual, HITL-gated)

Scores all responses against the published rubric, presents a
recommendation, and (after explicit human approval) calls award_response
and populates opp.yaml.selected_llo. The only path that unblocks Phase 7.

The award call is gated on a literal 'award <response_id> \$<amount>'
reply from the human — no auto-award. Never runs in default /ace:run.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Add `solicitation-review-eval` rubric

**Files:**
- Create: `skills/solicitation-review-eval/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

Create `skills/solicitation-review-eval/SKILL.md`:

```markdown
---
name: solicitation-review-eval
description: >
  Provisional LLM-as-Judge rubric for solicitation-review. Compares ACE's
  top-ranked recommendation against the human's actual award decision.
  Detection-rate metric: did ACE's recommended awardee match the human's
  pick? Calibrated per skills/eval-calibration once 3+ awards have shipped.
---

# Solicitation Review — Eval

Cross-artifact LLM-as-Judge eval. Compares ACE's recommendation in
`solicitation/review/recommendation.md` against the actual outcome
in `solicitation/award-record.md`.

**Status:** Provisional. Calibration TBD until 3+ real awards have shipped.

## Inputs

- `ACE/<opp-name>/solicitation/review/scoring-rubric.md`
- `ACE/<opp-name>/solicitation/review/recommendation.md`
- `ACE/<opp-name>/solicitation/award-record.md`
- `ACE/<opp-name>/solicitation/published.md` (rubric reference)

## Rubric

1. **Recommendation alignment (weight 0.4).** Did ACE's top-ranked
   recommendation match the awarded response_id? Score 10 if yes, 5 if
   awardee was in ACE's top 3, 0 otherwise. Hard-deduct -3 if
   `award-record.md` has `status: failed` while `selected_llo` is populated
   (data-integrity violation — that path should be impossible per the
   skill's contract, and any verdict must flag it).

2. **Scoring rationale quality (weight 0.3).** Are the scores in
   `scoring-rubric.md` traceable to the criteria in `published.md`? Are
   the per-criterion notes specific or generic? Penalize one-line "good
   experience" justifications.

3. **Recommendation specificity (weight 0.2).** Does `recommendation.md`
   surface concrete differentiators between candidates, or is it a
   ranked list with no narrative? Higher score for surfacing the close
   calls.

4. **Edge case coverage (weight 0.1).** Did the recommendation flag any
   responses that were structurally unscoreable (incomplete answers,
   wrong-archetype)? Penalize silent skipping.

## Verdict shape

Write `verdicts/solicitation-review-<mode>.yaml` per `lib/verdict-schema.ts`.
```

- [ ] **Step 2: Commit**

```bash
git add skills/solicitation-review-eval/
git commit -m "feat(skill): add solicitation-review-eval rubric (provisional)

Detection-rate metric (recommendation alignment with actual award) plus
scoring rationale, specificity, and edge-case coverage. Calibration TBD
until 3+ real awards have shipped.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Transform `llo-invite` skill (move to Phase 6, rewrite behavior)

**Files:**
- Modify: `skills/llo-invite/SKILL.md` (substantial rewrite)

- [ ] **Step 1: Replace the SKILL.md content**

Replace the entire content of `skills/llo-invite/SKILL.md` with:

```markdown
---
name: llo-invite
description: >
  Phase 6 step 2 (auto, default run). For each PDD-named candidate LLO,
  send an invitation email with the public solicitation URL. No-op when
  the PDD has no preferred_llos (long-term solicitation flow). Makes no
  Connect API calls — those happen for the awardee only, in
  llo-onboarding (Phase 7).
---

# LLO Invite

Phase 6 default-run skill. Runs after `solicitation-create` has captured
`opp.yaml.solicitation.public_url`. Sends each PDD-named candidate LLO an
email containing the solicitation URL, deadline, and a scope summary.

This skill replaces the previous Phase-7 (was Phase-6) `llo-invite` that
prepared a Connect-side invite roster. The Connect program-level invite
(`connect_send_llo_invite`) is now `llo-onboarding`'s responsibility and
fires only for the awardee.

## Inputs

- `ACE/<opp-name>/inputs/pdd.md` (specifically `preferred_llos:`)
- `opp.yaml.solicitation.public_url`
- `opp.yaml.solicitation.deadline`

## Process

1. **Read `preferred_llos`** from the PDD.

2. **If empty:** write `ACE/<opp-name>/solicitation/invitations.md`:

   ```markdown
   # Solicitation Invitations

   Status: empty (long-term solicitation flow — no PDD-named candidates).
   The solicitation is publicly listed at <public_url>; orgs find it on the
   labs portal.
   ```

   Exit successfully.

3. **For each preferred LLO**, compose an email:

   ```
   Subject: Invitation to respond — <pdd.title>
   To: <preferred_llo.contact_email>

   Hi <name>,

   <Dimagi greeting + program summary, 2-3 sentences from PDD>

   We are inviting your organization to respond to a solicitation for
   <pdd.title>. The full description, scope of work, and response template
   are at:

       <opp.yaml.solicitation.public_url>

   Responses are due by <opp.yaml.solicitation.deadline> (UTC).

   To respond, sign into labs.connect.dimagi.com with your organization
   account, open the solicitation linked above, and click "Submit Response."

   Questions? Reply to this email.

   <ace signature block>
   ```

   Send via the `email-communicator` skill (uses ACE's Gmail account
   `ace@dimagi-ai.com`).

4. **Log every send** to `ACE/<opp-name>/solicitation/invitations.md`:

   ```markdown
   # Solicitation Invitations

   Solicitation: <public_url>
   Deadline: <deadline>

   ## Recipients

   | Recipient | Org | Sent at | Status |
   |---|---|---|---|
   | <name>    | <org> | <ISO>  | sent |
   | <name>    | <org> | <ISO>  | failed: <reason> |
   ```

## Review-mode gate

If invoked under `/ace:run --review` mode, present the prepared email list
to the human before sending and pause. Default mode sends without a gate
(the orchestrator's gate is the Phase 6→7 boundary, not here).

## Error handling

- Per-recipient email failure: log `status: failed: <reason>` for that
  row, continue with the rest.
- All recipients fail: halt with a surfaced error.
- PDD has no `preferred_llos`: no-op per Step 2 above.
- `opp.yaml.solicitation.public_url` empty: halt with "run
  solicitation-create first" message.

## Output

- `ACE/<opp-name>/solicitation/invitations.md` — recipient log
```

- [ ] **Step 2: Verify the manifest now matches**

Run: `npm test -- --run test/fixtures/artifact-manifest.test.ts`

Expected: PASS. The `solicitation/invitations.md` entry from Task 7 lists `producedBy: 'llo-invite'`, which now matches.

- [ ] **Step 3: Commit**

```bash
git add skills/llo-invite/
git commit -m "refactor(skill): llo-invite — move to Phase 6, rewrite for solicitations

Previously Phase 6 (was Phase 7 after renumbering): identified PDD-named
candidates and prepared a Connect-side invite roster. Now Phase 6: same
candidate identification, but emails each one a link to the public
solicitation URL. Makes no Connect API calls — the Connect program-level
invite fires only for the awardee inside llo-onboarding.

Empty PDD preferred_llos → no-op (long-term flow: solicitation is public,
orgs find it via the labs portal).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Update `llo-onboarding` to read `selected_llo`

**Files:**
- Modify: `skills/llo-onboarding/SKILL.md`

- [ ] **Step 1: Read the current SKILL.md**

Run: `cat skills/llo-onboarding/SKILL.md`

Note where it currently reads from `connect-setup/invites.md` (the old roster). The change replaces that with reading `opp.yaml.selected_llo`.

- [ ] **Step 2: Edit the inputs and process**

In `skills/llo-onboarding/SKILL.md`:

(a) In the Inputs section, replace any reference to `connect-setup/invites.md` with:

```
- `opp.yaml.selected_llo` — populated by Phase 6 solicitation-review on award.
  Halt with a clear error if `org_slug` is null (Phase 7 must not start
  without an awardee).
```

(b) In Process step 1 (or wherever the roster gets read), replace the roster-loading logic with:

```
1. Read `opp.yaml.selected_llo`. If `org_slug` is null:
   ```
   FATAL: Phase 7 cannot start — opp.yaml.selected_llo.org_slug is empty.
   Run `/ace:step solicitation-review --opp <opp-name>` to score responses
   and award an awardee. The orchestrator's pre-Phase-7 gate should have
   caught this; if you're seeing this from a manual /ace:step invocation,
   the gate was bypassed.
   ```
   Halt.
2. Use `selected_llo.org_slug` as the target for `connect_send_llo_invite`
   and `selected_llo.contact_email` as the recipient for the ACE
   onboarding email.
```

(c) Drop any prose that talks about iterating a multi-LLO roster — Phase 7 onboards exactly one awardee.

- [ ] **Step 3: Smoke a fixture**

Run: `npm test -- --run test/fixtures/`

Expected: PASS. Fixtures don't currently set `selected_llo`, but the SKILL.md change is prose; tests don't execute the skill.

- [ ] **Step 4: Commit**

```bash
git add skills/llo-onboarding/
git commit -m "refactor(skill): llo-onboarding reads opp.yaml.selected_llo

Replaces the connect-setup/invites.md roster read with a single
selected_llo lookup populated by Phase 6 solicitation-review. Fails fast
with an actionable message if Phase 7 is reached without an awardee.

The Connect program-level invite (connect_send_llo_invite) and the ACE
onboarding email both target selected_llo.org_slug /
selected_llo.contact_email.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Add the `solicitation-management` subagent

**Files:**
- Create: `agents/solicitation-management.md`

- [ ] **Step 1: Read an existing subagent for shape**

Run: `cat agents/closeout.md` (it's the simplest subagent in the codebase).

- [ ] **Step 2: Write the new agent**

Create `agents/solicitation-management.md`:

```markdown
---
name: solicitation-management
description: >
  Phase 6 of the CRISPR-Connect lifecycle: publish a solicitation derived
  from the PDD, invite PDD-named candidate LLOs to it by email, and stop.
  The review-and-award lifecycle continues via the manually-invoked
  solicitation-review skill (gated on a human-in-the-loop checkpoint
  before award_response is called). Phase 7 starts once an awardee is
  recorded in opp.yaml.selected_llo.
model: inherit
phase: solicitation-management
phase_display: Solicitation Management
phase_ordinal: 6
skills:
  - { name: solicitation-create,  has_judge: true,  eval_skill: solicitation-create-eval }
  - { name: llo-invite,           has_judge: false }
recurring_skills:
  - { name: solicitation-monitor, has_judge: false }
manual_skills:
  - { name: solicitation-review,  has_judge: true,  eval_skill: solicitation-review-eval }
---

# Solicitation Management Agent (Phase 6)

You run the solicitation phase of a CRISPR-Connect opportunity. By the
time this phase starts, Phases 1–5 have produced an approved PDD,
deployed CommCare apps, a configured Connect opportunity, a quality-gated
OCS chatbot, and per-opp training materials. The opportunity is fully
prepared on the ACE side — what's missing is an LLO to run it.

This phase publishes a solicitation that potential LLOs can respond to.
In default `/ace:run` mode, you publish the solicitation and email the
PDD-named candidate LLOs (if any), then stop. The review-and-award
lifecycle requires explicit human approval and is run manually via
`/ace:step solicitation-review`.

## Workflow (default run)

### Step 1: Solicitation Create

Run the `solicitation-create` skill. It translates the PDD into a
solicitation payload, derives evaluation criteria via labs's
`generate_criteria` endpoint, and publishes the solicitation via the
`connect-labs` MCP. Captures `solicitation_id` and `public_url` into
`opp.yaml.solicitation`.

- Input: approved PDD, opp.yaml (program_id, total_budget)
- Output: `solicitation/published.md`, `opp.yaml.solicitation` populated
- Eval (unless `--no-evals`): `solicitation-create-eval`

### Step 2: LLO Invite

Run the `llo-invite` skill. For each PDD-named candidate LLO, send an
invitation email pointing at the public solicitation URL.

- Input: PDD `preferred_llos`, `opp.yaml.solicitation.public_url`
- Output: `solicitation/invitations.md`
- No-op when PDD has no `preferred_llos` (long-term solicitation flow).

### Recurring: Solicitation Monitor

While `opp.yaml.solicitation.status == open`, the orchestrator's recurring
loop calls `solicitation-monitor` to pull new responses, write one file
per response to `solicitation/responses/`, and append a tick line to
`comms-log/observations.md`.

This loop runs OUTSIDE the default `/ace:run` invocation (which exits
after Step 2). It is meant to be scheduled (cron or manual `/ace:step
solicitation-monitor`) until the deadline passes.

### Manual: Solicitation Review

Once the deadline has passed (or whenever a human decides to award), the
human runs:

```
/ace:step solicitation-review --opp <opp-name>
```

This skill scores all responses, presents a recommendation, gates on
explicit human approval, then calls `award_response` and populates
`opp.yaml.selected_llo`. Only this skill unblocks Phase 7.

## Pause-points

- **End of Step 2** (default `/ace:run` exit): `/ace:run` halts here. Phase 7
  cannot start until `solicitation-review` has populated `selected_llo`.
- **Inside `solicitation-review`**: HITL gate before `award_response`.

## Outputs at phase end (default run)

- `ACE/<opp-name>/solicitation/draft.md`
- `ACE/<opp-name>/solicitation/published.md`
- `ACE/<opp-name>/solicitation/invitations.md`
- `opp.yaml.solicitation.{solicitation_id, public_url, deadline, status: open}`
- `opp.yaml.selected_llo.*` (stubbed, null until award)

## Completion

The phase is "complete" in the orchestrator's sense after Step 2. The
recurring monitor and manual review are NOT part of phase completion —
they happen post-`/ace:run` and gate Phase 7 entry.
```

- [ ] **Step 3: Commit**

```bash
git add agents/solicitation-management.md
git commit -m "feat(agent): add solicitation-management subagent (Phase 6)

Owns the new Phase 6: solicitation-create + llo-invite (auto, default
run), solicitation-monitor (recurring), solicitation-review (manual,
HITL-gated). Default /ace:run halts at the end of llo-invite; Phase 7 is
gated on opp.yaml.selected_llo being populated by solicitation-review.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Update `ace-orchestrator` phases block and pause-points

**Files:**
- Modify: `agents/ace-orchestrator.md`

- [ ] **Step 1: Locate the `phases:` block**

Run: `grep -n "^phases:" agents/ace-orchestrator.md`

Read the block (lines 66-105 in the current file). Note the existing entries.

- [ ] **Step 2: Rewrite the phases block**

Replace the existing `phases:` block in `agents/ace-orchestrator.md` with:

```yaml
phases:
  design-review:        # Phase 1
    # (existing entries, unchanged)
  commcare-setup:       # Phase 2
    # (existing entries, unchanged)
  connect-setup:        # Phase 3
    # (existing entries, unchanged)
  ocs-setup:            # Phase 4
    # (existing entries, unchanged)
  qa-and-training:      # Phase 5
    # (existing entries, unchanged)
  solicitation-management:  # Phase 6 (NEW)
    solicitation-create: pending
    llo-invite: pending
    # solicitation-monitor and solicitation-review run outside /ace:run.
  execution-management:     # Phase 7 (was llo-management, Phase 6)
    llo-onboarding: pending
    llo-uat: pending
    llo-launch: pending
  closeout:             # Phase 8 (was Phase 7)
    # (existing entries, unchanged)
```

(Preserve the existing pending/skip values inside each unchanged phase — the example above shows only the structure, not literal replacement of inner entries. Use `Edit` with surgical replacements for each block; do not blow away the inner state.)

- [ ] **Step 3: Update the pause-points list**

Locate the pause-points list in `agents/ace-orchestrator.md` (around lines 274-307 — search for "Phase 5→6 transition" and "After `llo-invite`"). Replace the existing pause-points text with:

```markdown
**Pause-points:**
- After `idea-to-pdd` (Phase 1) — PDD must be approved before building apps
- After `app-deploy` (Phase 2) — apps must be verified before Connect setup
- After `ocs-chatbot-eval --deep` (Phase 4) — OCS quality must clear pre-launch bar
- **Phase 6 → 7 boundary** — `/ace:run` halts here in default mode. Phase 7
  cannot start until `opp.yaml.selected_llo.org_slug` is populated, which
  only happens via the manual `solicitation-review` skill. This is the new
  external-communication boundary (Phase 7 sends the first email to the
  awardee LLO).
- After `solicitation-review` (Phase 6, manual) — HITL gate before
  `award_response` is called.
- After `llo-launch` (Phase 7) — activation verified before monitoring
- Phase 5 → 6 is **no longer mandatory pause**. Solicitation publication
  is passive (labs portal listing); the active-outreach boundary moves
  to Phase 6 → 7.
```

- [ ] **Step 4: Update the agent dispatch references**

Run: `grep -n "Agent(llo-manager)\|Agent('llo-manager')" agents/ace-orchestrator.md`

For each match, replace with `Agent(execution-manager)` / `Agent('execution-manager')`. Then add a new dispatch reference for `solicitation-management` between Phase 5 and Phase 7 dispatch sites:

```markdown
After Phase 5 (qa-and-training) completes, dispatch Phase 6:

  Agent(solicitation-management)

Wait for it to return. After Phase 6 completes, the orchestrator HALTS in
default mode. The next phase requires manual intervention
(/ace:step solicitation-review). Resume Phase 7 only after
opp.yaml.selected_llo.org_slug is populated:

  Agent(execution-manager)
```

- [ ] **Step 5: Update prose references to phase numbering**

Throughout `ace-orchestrator.md`, update prose references:
- "Phase 5→6 transition: always pause" → moved to Phase 6→7 (covered above)
- "Phase 6 is where LLOs first hear from ACE" → "Phase 7 is where the awardee LLO first hears from ACE; Phase 6 publishes the public solicitation but does not contact specific LLOs unless the PDD names preferred_llos."

- [ ] **Step 6: Commit**

```bash
git add agents/ace-orchestrator.md
git commit -m "feat(orchestrator): wire Phase 6 (solicitation-management)

phases: block now lists solicitation-management between qa-and-training
and execution-management. Pause-points: Phase 5→6 no longer mandatory;
Phase 6→7 is the new external-comms boundary. Agent dispatch now calls
Agent(solicitation-management) and Agent(execution-manager).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: Update commands/run.md and commands/step.md

**Files:**
- Modify: `commands/run.md`
- Modify: `commands/step.md`

- [ ] **Step 1: Find references to llo-manager**

Run: `grep -n "llo-manager\|llo_management\|llo-management" commands/`

- [ ] **Step 2: Apply replacements**

For each match: `llo-manager` → `execution-manager`, `llo_management` → `execution_management`, `llo-management` → `execution-management`.

If `commands/step.md` documents the `/ace:step` command's valid skill list, add the four new Phase 6 skills (`solicitation-create`, `llo-invite`, `solicitation-monitor`, `solicitation-review`) and the two new eval skills.

- [ ] **Step 3: Commit**

```bash
git add commands/run.md commands/step.md
git commit -m "chore(commands): rename llo-manager → execution-manager in command docs

Also adds the four new Phase 6 skills to /ace:step's documented skill list.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: Add CRISPR-Test-004-Solicitation fixture

**Files:**
- Create: `test/fixtures/CRISPR-Test-004-Solicitation/inputs/pdd.md`
- Create: `test/fixtures/CRISPR-Test-004-Solicitation/opp.yaml`
- Modify: `test/fixtures/artifact-manifest.test.ts`

- [ ] **Step 1: Read an existing fixture for shape**

Run: `ls test/fixtures/CRISPR-Test-001*/`, then read its `pdd.md` and `opp.yaml` for structure.

- [ ] **Step 2: Create the fixture**

Create `test/fixtures/CRISPR-Test-004-Solicitation/inputs/pdd.md`:

```markdown
---
title: "FLW Outreach for Maternal Health — Niger"
archetype: atomic-visit
intervention_summary: >
  CHWs visit pregnant women and new mothers monthly to provide ANC/PNC
  guidance, basic screening, and referrals. The program targets districts
  with low facility-delivery rates.
target_flw_profile: >
  Existing community-elected health volunteers, primarily women, with
  basic literacy in Hausa or French. 6-month engagement, ~30 visits per
  month per FLW.
visit_structure: >
  Single-visit data collection at each woman's home. Form covers
  demographics, pregnancy status, danger signs screening, and referral
  log. ~15 minutes per visit.
success_criteria:
  - "≥80% of pregnant women in catchment receive at least 1 ANC visit"
  - "≥60% of identified danger-sign cases referred to facility"
  - "FLW retention ≥85% over 6 months"
total_budget: 75000

# Solicitation fields
solicitation_type: EOI
solicitation_deadline_days: 21
llo_questions:
  - "Describe your prior experience deploying CHW programs in West Africa"
  - "How will you recruit and train 40 FLWs across 3 districts?"
  - "What is your timeline for fielding once awarded?"
  - "What is your supervision model for FLW visits?"
  - "Do you have local-language capacity (Hausa or French)?"
  - "Provide a budget breakdown for the proposed scope"

preferred_llos:
  - { name: "Niger Health Initiative", contact_email: "ops@niger-health.example", organization_slug: "niger-health-initiative" }
  - { name: "Sahel Maternal Care", contact_email: "info@sahel-maternal.example", organization_slug: "sahel-maternal-care" }
---
```

Create `test/fixtures/CRISPR-Test-004-Solicitation/opp.yaml`:

```yaml
display_name: "Niger Maternal Health Pilot"
slug: niger-maternal-health-pilot
program_id: 42
created_at: 2026-05-04T12:00:00Z
created_by: ace@dimagi-ai.com
last_run_id: null
tags: [solicitation-fixture, atomic-visit]
```

- [ ] **Step 3: Update the manifest validation test**

In `test/fixtures/artifact-manifest.test.ts`, add `'CRISPR-Test-004-Solicitation'` to the list of fixtures that get walked. (Look for an array like `const FIXTURES = ['CRISPR-Test-001-...', ...]` and append.)

- [ ] **Step 4: Run the test**

Run: `npm test -- --run test/fixtures/`

Expected: PASS for all 4 fixtures.

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/CRISPR-Test-004-Solicitation/ test/fixtures/artifact-manifest.test.ts
git commit -m "test(fixture): add CRISPR-Test-004-Solicitation

PDD with all three new optional solicitation fields populated, two
preferred_llos. Used by Phase 6 skill tests and the LABS_INTEGRATION
e2e test.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: Update opp-eval to include solicitation category

**Files:**
- Modify: `skills/opp-eval/SKILL.md`

- [ ] **Step 1: Read the current category list**

Run: `grep -n "category\|categories" skills/opp-eval/SKILL.md`

Note the existing 6 categories (likely: design, commcare, connect, ocs, operate, closeout).

- [ ] **Step 2: Add the solicitation category**

In `skills/opp-eval/SKILL.md`, add a new category between `connect` and `ocs` (or wherever the phase-ordering sits in the document):

- Category: `solicitation`
- Eval rubrics aggregated: `solicitation-create-eval`, `solicitation-review-eval` (when present)
- Phase: 6
- Coverage tier rule: full coverage requires verdicts from both rubrics; partial coverage requires `solicitation-create-eval` only.

If the SKILL.md has a "category coverage tier" table that says "6 of 6 = full", update to "7 of 7 = full". The "full" threshold lifts by one.

- [ ] **Step 3: Commit**

```bash
git add skills/opp-eval/
git commit -m "feat(eval): add solicitation category to opp-eval

opp-eval now aggregates verdicts from solicitation-create-eval and
solicitation-review-eval as a 7th category. Full coverage threshold
lifts from 6 → 7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 19: Add LABS_INTEGRATION end-to-end test

**Files:**
- Create: `test/mcp/connect-labs/integration/e2e.integration.test.ts`

- [ ] **Step 1: Write the test**

Create `test/mcp/connect-labs/integration/e2e.integration.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { forward } from '../../../../mcp/connect-labs-server';

const RUN = process.env.LABS_INTEGRATION === '1';
const URL = process.env.LABS_MCP_URL || 'https://labs.connect.dimagi.com/mcp/';
const TOKEN = process.env.LABS_MCP_TOKEN || '';

describe.runIf(RUN)('connect-labs MCP — live integration', () => {
  beforeAll(() => {
    if (!TOKEN) throw new Error('LABS_MCP_TOKEN required for LABS_INTEGRATION=1');
  });

  it('lists tools (sanity)', async () => {
    const reply = await forward(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { token: TOKEN, url: URL },
    );
    expect(reply.error).toBeUndefined();
    expect((reply.result as any)?.tools?.length).toBeGreaterThan(0);
    const names = (reply.result as any).tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'list_solicitations',
      'create_solicitation',
      'list_responses',
      'award_response',
    ]));
  });

  it('list_solicitations returns at least an empty list (Connect OAuth bridge live)', async () => {
    const reply = await forward(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_solicitations', arguments: {} },
      },
      { token: TOKEN, url: URL },
    );
    expect(reply.error).toBeUndefined();
    // Result is the labs-side serialized list; shape may be a JSON-encoded
    // string or a structured array depending on the labs MCP transport.
    expect(reply.result).toBeDefined();
  });

  it('create_solicitation → list_responses → cleanup (smoke)', async () => {
    // Create a draft solicitation in a test program. The fixture's program_id
    // must point at a "Solicitation Test" program in labs that has no real
    // responders. Skip the test (don't fail) if the env doesn't provide one.
    const programId = process.env.LABS_TEST_PROGRAM_ID;
    if (!programId) {
      console.warn('LABS_TEST_PROGRAM_ID unset — skipping create_solicitation smoke');
      return;
    }
    const create = await forward(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'create_solicitation',
          arguments: {
            program_id: programId,
            title: `ACE integration test ${new Date().toISOString()}`,
            solicitation_type: 'EOI',
            description: 'integration test — please ignore',
            scope_of_work: 'integration test',
            budget: 1,
            deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
            evaluation_criteria: [{ id: 'fit', weight: 1.0, scale: 10 }],
            response_template: ['Why are you interested?'],
            status: 'draft',  // never publish from a test
          },
        },
      },
      { token: TOKEN, url: URL },
    );
    expect(create.error).toBeUndefined();
  });
});
```

- [ ] **Step 2: Verify the test is skipped without the env var**

Run: `npm test -- --run test/mcp/connect-labs/integration/`

Expected: 0 tests run (the `runIf` skips when `LABS_INTEGRATION` is unset).

- [ ] **Step 3: Run the test with the env var (manual verification)**

Run: `LABS_INTEGRATION=1 LABS_MCP_TOKEN=<actual> npm test -- --run test/mcp/connect-labs/integration/`

Expected: 3/3 pass against live labs (only if you have a labs PAT and a `LABS_TEST_PROGRAM_ID` to target).

If you don't have a PAT yet, skip this verification — the test exists for CI / future runs.

- [ ] **Step 4: Commit**

```bash
git add test/mcp/connect-labs/integration/
git commit -m "test(integration): add LABS_INTEGRATION e2e for connect-labs MCP

Three checks: tools/list, list_solicitations (verifies Connect OAuth
bridge), create_solicitation smoke (skipped without LABS_TEST_PROGRAM_ID).
Gated like OCS_INTEGRATION — does not run in default npm test.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 20: Update CLAUDE.md and README.md prose

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Update CLAUDE.md phase order list**

Locate the phase listing in `CLAUDE.md` (search for "Orchestration runs 7 phases"). Update to:

> **Orchestration runs 8 phases as of <next version>.** Phase order: (1) design-review → (2) commcare-setup → (3) connect-setup → (4) ocs-setup → (5) qa-and-training → (6) solicitation-management → (7) execution-management → (8) closeout. Phase 6 (new) publishes a solicitation derived from the PDD and emails PDD-named candidate LLOs the public URL. Phase 7 (renamed from llo-management) onboards the awardee chosen by the manual solicitation-review skill.

- [ ] **Step 2: Update CLAUDE.md MCP section**

Add a new bullet under the existing MCP-server description block:

> - `connect-labs-server.ts` → `connect-labs` (stdio proxy forwarding to `labs.connect.dimagi.com/mcp/`). 10 atoms consumed: `list/get/create/update_solicitation`, `list/get_responses`, `create_review`, `list_reviews`, `award_response`, `generate_criteria`. Source under `mcp/connect-labs-server.ts` is a thin proxy — the real catalog lives in connect-labs (`commcare_connect/mcp/tools/`). Auth: Bearer PAT in `LABS_MCP_TOKEN` (1Password). Provisioned per-machine via `op inject -i .env.tpl`.

- [ ] **Step 3: Update CLAUDE.md gotchas section**

Add a new bullet under "Gotchas":

> - **Connect Labs MCP is HTTP, but ACE consumes it via a stdio proxy.** `mcp/connect-labs-server.ts` reads `LABS_MCP_TOKEN` from `${CLAUDE_PLUGIN_DATA}/.env` and forwards JSON-RPC frames to `labs.connect.dimagi.com/mcp/`. If the labs MCP gains first-class HTTP support in `plugin.json` later, the proxy can be removed.
> - **`solicitation` and `selected_llo` are separate blocks in `opp.yaml`.** `solicitation` is the audit trail (URLs, deadline, status); `selected_llo` is the narrow contract Phase 7 reads. Only `solicitation-review` populates `selected_llo`. If you see `selected_llo` set without a corresponding `solicitation` block, that's a contract violation.

- [ ] **Step 4: Update README.md (if present)**

If `README.md` lists phases, update to the 8-phase order. If it has a "What ACE does" summary, add a sentence about Phase 6 being solicitation-driven.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: update CLAUDE.md + README for 8-phase order

Phase 6 (Solicitation Management) added between qa-and-training and the
renamed Execution Management. New connect-labs MCP entry, new gotchas
on the stdio proxy + opp.yaml.solicitation/selected_llo split.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 21: Bump version, update CHANGELOG, final smoke

**Files:**
- Modify: `VERSION`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump VERSION (worktree-safe)**

Run: `scripts/version-bump.sh`

Expected: prints something like `bumped 0.11.9 → 0.12.0` (the bumper picks `max(local, origin) + patch+1`; the actual minor-vs-patch depends on the current state). For a feature this size, manually override to a minor bump if the script picked patch:

If needed, edit `VERSION` to `0.12.0` and run the pre-commit-style sync:

```bash
echo "0.12.0" > VERSION
bash scripts/sync-version.sh
```

- [ ] **Step 2: Update CHANGELOG.md**

Prepend to `CHANGELOG.md`:

```markdown
## 0.12.0 — Solicitation Management (new Phase 6)

**Phase topology shifts.** Inserts Phase 6 (Solicitation Management) between
qa-and-training and the renamed Execution Management (was llo-management,
Phase 6). Closeout shifts to Phase 8.

**New phase: Solicitation Management.**
- Default `/ace:run` publishes a solicitation derived from the PDD via the
  new `connect-labs` MCP, then emails PDD-named candidate LLOs the public
  URL. `/ace:run` halts at the Phase 6→7 boundary.
- Recurring `solicitation-monitor` polls labs for responses; runs outside
  `/ace:run`.
- Manual `solicitation-review` (HITL-gated) scores responses, presents a
  recommendation, and on human approval calls `award_response` and
  populates `opp.yaml.selected_llo`. The only path that unblocks Phase 7.

**New MCP: `connect-labs`.** A thin stdio proxy at
`mcp/connect-labs-server.ts` forwards JSON-RPC frames to
`labs.connect.dimagi.com/mcp/` with a Bearer PAT (`LABS_MCP_TOKEN`).
Consumes 10 atoms; no new code in `ace-connect`.

**Phase 7 changes:** `llo-manager` agent renamed to `execution-manager`.
`llo-invite` skill moved to Phase 6 with rewritten behavior (sends
solicitation invites instead of preparing a Connect roster).
`llo-onboarding` reads `opp.yaml.selected_llo` and fails fast if empty.

**Pause-points:**
- Phase 5→6 no longer mandatory pause.
- Phase 6→7 is the new external-communication boundary (where `/ace:run`
  halts in default mode).
- HITL gate inside `solicitation-review` before `award_response`.

**Doctor:** new `[Connect Labs]` section with three checks
(env / reachable / Connect OAuth bridge).

**Provisional eval rubrics:** `solicitation-create-eval`,
`solicitation-review-eval`. Calibration TBD per `eval-calibration` once
3+ real solicitations + awards have shipped.

**No migration script.** In-flight opps finish on the old code; new opps
use the new schema.
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test -- --run`

Expected: full pass.

- [ ] **Step 4: Run /ace:doctor smoke**

Run: `bin/ace-doctor`

Expected: all sections OK or WARN. The new `[Connect Labs]` section will
likely FAIL on `connect_labs_env` until a PAT is provisioned in 1Password
— that's expected and not a blocker for the merge. The doctor exit
status should reflect the FAIL, but the operator will provision the PAT
during/after the merge.

- [ ] **Step 5: Commit**

```bash
git add VERSION package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json CHANGELOG.md
git commit -m "release: 0.12.0 — Solicitation Management (new Phase 6)

Inserts Phase 6 (Solicitation Management) between qa-and-training and
the renamed Execution Management (was llo-management, Phase 6). Closeout
shifts to Phase 8. Adds the connect-labs stdio proxy MCP, four new
skills (solicitation-create, llo-invite-rewritten, solicitation-monitor,
solicitation-review), two provisional eval rubrics, and a new doctor
section.

See CHANGELOG.md for full details.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage:** Walked each section of the spec —

- ✅ Phase topology (renumbering): Tasks 1, 2, 14, 15
- ✅ MCP integration (proxy, auth, doctor): Tasks 3, 4, 5
- ✅ PDD additions: Task 6
- ✅ Solicitation skills: Tasks 7, 9, 10
- ✅ Eval rubrics: Tasks 8, 11
- ✅ Transformed llo-invite: Task 12
- ✅ Updated llo-onboarding: Task 13
- ✅ Solicitation-management agent: Task 14
- ✅ Orchestrator phases + pause-points: Task 15
- ✅ Commands updates: Task 16
- ✅ Fixture: Task 17
- ✅ opp-eval coverage: Task 18
- ✅ Integration test: Task 19
- ✅ Doc updates: Task 20
- ✅ Version + CHANGELOG: Task 21

**Placeholder scan:** No "TBD", "TODO", "implement later", or
"add appropriate error handling" without specifics. Provisional rubrics
are explicitly flagged with calibration plans.

**Type consistency:** Skill names match between manifest entries
(Task 7), the agent's `skills:` block (Task 14), and orchestrator
references (Task 15). Atom names (`create_solicitation`, `list_responses`,
`award_response`, etc.) match what `connect-labs/commcare_connect/mcp/tools/solicitations.py`
registers.

**Known limitation:** The doctor wiring in Task 5 step 5 ("if `bin/ace-doctor`
is a thin bash wrapper around `tsx`") branches on the current shape of
`ace-doctor`. The implementation step should inspect the file first and
match its existing convention. This is documented in the task itself.

---

Plan complete and saved to `docs/superpowers/plans/2026-05-04-ace-solicitations-phase.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
