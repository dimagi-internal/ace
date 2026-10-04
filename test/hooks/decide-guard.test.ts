/**
 * Decide-guard LOADER suite.
 *
 * hooks/decide_guard.py is a Stop-event rail: when a session ends by OFFERING to
 * do work ACE was equipped to do, it returns {decision: "block"} and the reason
 * text is fed back to the model, which then finishes the work instead of parking
 * it. Measured on ACE's own last 40 sessions (2026-08-27): 8 would block, 7 of
 * them real — "say the word and I'll…" appears four times.
 *
 * The MATCHING lives in canopy (agent-core/decide_guard.py) and is tested there.
 * This file must NOT re-test it: a second copy of the calibration is exactly the
 * drift the loader split exists to prevent (see hooks/gating_guard.py's docstring
 * for the measured cost — three of four agents silently behind the engine).
 *
 * What is ACE's to guarantee is the three things the loader itself owns:
 *   1. it runs the ENGINE, resolved from the installed plugin;
 *   2. an unresolvable engine exits 0 SILENTLY — a Stop hook that writes stderr
 *      on every stop is a hook ACE learns to ignore, and this rail's whole value
 *      is in being heeded. Unlike gating_guard, degraded mode here is simply OFF:
 *      losing the gating engine costs safety, losing this one costs a nudge;
 *   3. it hands the engine a per-agent state home, so two agents on one box
 *      cannot consume each other's single at-most-once block.
 *
 * Plus one wiring guarantee that is ACE-specific and load-bearing: the hook is
 * registered REPO-scoped in .claude/settings.json, never plugin-level in
 * hooks/hooks.json. gating_guard is plugin-level on purpose (a deny rail on the
 * ACE identity should hold wherever that identity can be used); this one asks
 * whether ACE finished ACE's work, so plugin-level it would nag every session on
 * the machine.
 *
 * Stdlib-only python3 by design, so the tests spawn `python3` the same way the
 * gating-guard suite does.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(REPO_ROOT, 'hooks', 'decide_guard.py');

/** Spawn the loader with a Stop payload, with CANOPY_PLUGIN_DIR pointed at `pluginDir`. */
function runHook(pluginDir: string, payload: Record<string, unknown>) {
  const r = spawnSync('python3', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CANOPY_PLUGIN_DIR: pluginDir },
  });
  return { exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** A plugin dir whose "engine" records the environment it was handed. */
function fakePlugin(): { dir: string; receipt: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-decide-'));
  fs.mkdirSync(path.join(dir, 'agent-core'), { recursive: true });
  const receipt = path.join(dir, 'receipt.json');
  fs.writeFileSync(
    path.join(dir, 'agent-core', 'decide_guard.py'),
    'import json, os\n' +
      `open(${JSON.stringify(receipt)}, "w").write(` +
      'json.dumps({"agent_home": os.environ.get("CANOPY_AGENT_HOME", "")}))\n',
  );
  return { dir, receipt };
}

describe('decide_guard.py (loader)', () => {
  it('runs the canopy ENGINE, resolved from the installed plugin', () => {
    const { dir, receipt } = fakePlugin();
    const r = runHook(dir, { transcript_path: '/nonexistent.jsonl', session_id: 's1' });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(receipt, 'utf8')).agent_home).toBe(
      path.join(os.homedir(), '.ace'),
    );
  });

  it('hands the engine ACE-OWN state home, so agents cannot eat each other\'s one block', () => {
    const { dir, receipt } = fakePlugin();
    runHook(dir, { transcript_path: '/nonexistent.jsonl', session_id: 's2' });
    expect(JSON.parse(fs.readFileSync(receipt, 'utf8')).agent_home).toContain('.ace');
  });

  it('exits 0 SILENTLY when the engine is missing — no block, and no stderr', () => {
    const r = runHook('/nonexistent/plugin/dir', {
      transcript_path: '/nonexistent.jsonl',
      session_id: 's3',
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('holds NO matching logic — calibration belongs to canopy, not here', () => {
    // Not paranoia: hal shipped this engine into its own repo and split it out the
    // same day, one directory away from the docstring warning about exactly that.
    const src = fs.readFileSync(HOOK, 'utf8');
    expect(src).not.toContain('re.compile');
    expect(src).not.toContain('REASON');
  });

  it('is wired REPO-scoped in .claude/settings.json, never plugin-level', () => {
    // gating_guard is plugin-level on purpose. This one is not: plugin-level it
    // would fire in every session on the machine that has ACE installed.
    const settings = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'),
    );
    const stop = settings.hooks?.Stop ?? [];
    const commands = stop.flatMap((e: { hooks?: { command?: string }[] }) =>
      (e.hooks ?? []).map((h) => h.command ?? ''),
    );
    expect(commands.some((c: string) => c.includes('decide_guard.py'))).toBe(true);
    expect(commands.some((c: string) => c.includes('$CLAUDE_PROJECT_DIR'))).toBe(true);

    const pluginHooks = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf8'),
    );
    expect(JSON.stringify(pluginHooks)).not.toContain('decide_guard');
  });
});
