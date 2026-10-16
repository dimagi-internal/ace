/**
 * dimagi-internal/ace#2855 — a doctor probe that cannot run must never render
 * as a pass.
 *
 * `agents/commcare-setup.md § Step 0a` halts Phase 3 until `nova_auth` and
 * `nova_header_readiness` are both green. On
 * turmeric-market-study-ghana/20261012-1749 the probe emitted no line at all —
 * not PASS, not WARN, not FAIL — and appeared in none of the summary's three
 * buckets, so an agent following Step 0a literally could not tell "green" from
 * "never ran". The doctor's own verdict was `PASS: 49  WARN: 9  FAIL: 1` with
 * the probe in none of them.
 *
 * The cause was a three-line contract: capture with `2>/dev/null || true`
 * (discarding both the reason and the exit code), then
 * `[ -n "$X" ] && printf '%s\n' "$X"` with no else-branch. Reproduced here by
 * running that exact expression with `$TSX_CLI` unresolvable:
 * `captured_length=0`, zero lines printed.
 *
 * This matters more than a missing log line because the probe is also what
 * INSTALLS the user-scope `nova` MCP entry — since nova plugin v2 the only path
 * by which the API key reaches Nova. So the silent case is exactly the case
 * where the self-heal did not run, and ace#1604's documented remedy ("run
 * /ace:doctor, its nova_header_readiness probe installs the entry") silently
 * no-ops too.
 *
 * Three probes shared the shape (nova_header_readiness, nova_scopes,
 * static_header_drift), so the fix is the shared `run_line_probe` /
 * `emit_line_probe` pair rather than a patch to the one that was noticed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCTOR = path.join(__dirname, '../../bin/ace-doctor');
const doctorSrc = fs.readFileSync(DOCTOR, 'utf8');

/** Pull a top-level shell function out of bin/ace-doctor by name. */
function extractFn(name: string): string {
  const lines = doctorSrc.split('\n');
  const start = lines.findIndex((l) => l === `${name}() {`);
  if (start < 0) throw new Error(`${name}() not found in bin/ace-doctor`);
  const end = lines.indexOf('}', start);
  if (end < 0) throw new Error(`${name}() has no closing brace`);
  return lines.slice(start, end + 1).join('\n');
}

let harnessDir: string;

/**
 * Run the two real functions, lifted verbatim out of bin/ace-doctor, against a
 * scratch ROOT. `warn` is the doctor's own one-liner so the emitted shape is
 * exactly what the end-of-run summary greps.
 */
function runProbe(opts: { tsxCli: string; script?: { rel: string; body: string } }): string {
  const root = fs.mkdtempSync(path.join(harnessDir, 'root-'));
  if (opts.script) {
    const abs = path.join(root, opts.script.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, opts.script.body, { mode: 0o755 });
  }
  const harness = [
    'set -u',
    `warn() { printf 'WARN %s\\n' "$1"; [ -n "\${2:-}" ] && printf '  fix: %s\\n' "$2"; }`,
    `ROOT=${JSON.stringify(root)}`,
    `TSX_CLI=${JSON.stringify(opts.tsxCli)}`,
    extractFn('run_line_probe'),
    extractFn('emit_line_probe'),
    'run_line_probe scripts/doctor-nova-header.ts --format=lines --heal',
    'emit_line_probe nova_header_readiness',
    'exit 0',
  ].join('\n');
  const file = path.join(harnessDir, `h-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(file, harness);
  return execFileSync('bash', [file], { encoding: 'utf8' });
}

beforeAll(() => {
  harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-doctor-lineprobe-'));
});

describe('doctor line-probes always land in a bucket (ace#2855)', () => {
  it('WARNs when the runner cannot be resolved — the live repro', () => {
    // `FAIL deps: node_modules missing or tsx not installed` is a condition the
    // doctor already detects and reports; this probe used to vanish on it while
    // connect_orgs degraded loudly on the very same cause.
    const out = runProbe({
      tsxCli: '/nonexistent/tsx',
      script: { rel: 'scripts/doctor-nova-header.ts', body: '// never reached\n' },
    });
    expect(out).toMatch(/^WARN nova_header_readiness: probe did not run/m);
    expect(out).toMatch(/this is NOT a pass, the check did not happen/);
  });

  it('WARNs when the probe script is absent from the checkout', () => {
    const out = runProbe({ tsxCli: '/nonexistent/tsx' });
    expect(out).toMatch(/^WARN nova_header_readiness: probe did not run/m);
    expect(out).toMatch(/script is not present in this checkout/);
  });

  it('WARNs when the probe runs but prints nothing', () => {
    const out = runProbe({
      tsxCli: '/dev/null',
      script: { rel: 'scripts/doctor-nova-header.ts', body: '' },
    });
    // Whatever the mechanism, the invariant is the same: a bucket, not silence.
    expect(out).toMatch(/^WARN nova_header_readiness: probe did not run/m);
  });

  it('carries the failure REASON, which the old capture discarded', () => {
    // `2>/dev/null || true` threw away both stderr and the exit code, so the
    // operator had nothing to act on even once they noticed the gap.
    const out = runProbe({
      tsxCli: '/nonexistent/tsx',
      script: { rel: 'scripts/doctor-nova-header.ts', body: '// never reached\n' },
    });
    expect(out).toMatch(/exit \d+/);
  });

  it('names the stakes in the fix line, not just the mechanics', () => {
    const out = runProbe({ tsxCli: '/nonexistent/tsx' });
    expect(out).toMatch(/^ {2}fix: /m);
  });

  it('prints the probe output verbatim and adds nothing when it DOES run', () => {
    // The verbatim contract is load-bearing: the script emits the exact
    // PASS/WARN shape the summary greps, so the helper must not reformat it.
    // `TSX_CLI` stands in as a one-line runner, since the real one is tsx.
    const tsxCli = path.join(harnessDir, 'tsx-stub.cjs');
    fs.writeFileSync(
      tsxCli,
      "const fs=require('fs');eval(fs.readFileSync(process.argv[2],'utf8'));\n",
    );
    const out = runProbe({
      tsxCli,
      script: {
        rel: 'scripts/doctor-nova-header.ts',
        body: "console.log('PASS nova_header_readiness: the user-scope entry sends a header');\n",
      },
    });
    expect(out).toBe('PASS nova_header_readiness: the user-scope entry sends a header\n');
    expect(out).not.toMatch(/WARN/);
  });
});

describe('the silent shape is gone from bin/ace-doctor (ace#2855)', () => {
  it('routes every line-probe through the helper', () => {
    // capability_lease (the lease mobile backend's doctor probe) was the fourth.
    // test_worker_pool (the Connect test-worker pool lock, ace#2955) the fifth.
    // common_screenshot_pool (the pinned APK's Drive screenshot pool, ace#3060) the sixth.
    const probes = ['nova_header_readiness', 'nova_scopes', 'static_header_drift', 'capability_lease', 'test_worker_pool', 'common_screenshot_pool'];
    for (const probe of probes) {
      expect(doctorSrc).toMatch(new RegExp(`emit_line_probe ${probe}\\b`));
    }
    expect((doctorSrc.match(/^run_line_probe scripts\//gm) ?? []).length).toBe(probes.length);
  });

  it('no probe is still printed by a bare `[ -n "$X" ] && printf`', () => {
    // The exact shape that made a probe vanish. A new one reintroducing it
    // reintroduces the class.
    const offenders = doctorSrc
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /^\s*\[ -n "\$[A-Z_]+" \] && printf '%s\\n'/.test(line));
    expect(offenders.map((o) => `${o.n}: ${o.line.trim()}`)).toEqual([]);
  });

  it('no line-probe capture still discards stderr AND the exit code', () => {
    const offenders = doctorSrc
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /node "\$TSX_CLI" scripts\/doctor-[a-z-]+\.ts --format=lines/.test(line))
      .filter(({ line }) => /2>\/dev\/null \|\| true/.test(line));
    expect(offenders.map((o) => `${o.n}: ${o.line.trim()}`)).toEqual([]);
  });
});
