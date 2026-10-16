import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

//
// ace#2433 / ace#1737 — the archived manifest must BE the wire payload.
//
// `synthetic_generate_from_manifest` takes `manifest_yaml` as an inline string
// and has no file-handle parameter, so calling it as an MCP tool forces the
// model to re-emit the YAML into the tool call. The wire payload is then one
// emission and the archive another, identical only if the model reproduces the
// file byte-for-byte — the assumption ace#1737 disproved when
// `hh-poverty-targeting/20260824-1404` archived a manifest that did not parse
// at all while generation had succeeded.
//
// This script closes that by reading the file and POSTing itself. The property
// worth pinning is therefore not "it builds a request" but "the bytes it sends
// are the bytes on disk" — including the pathological shapes, because a
// well-meaning `yaml.parse()`-then-`stringify()` "tidy-up" inside the script
// would reintroduce the exact defect while every other test stayed green.
//
const SCRIPT = resolve(__dirname, '../../scripts/run-labs-synthetic-generate.ts');
// The byte-identity tests below are about the payload, not the registry gate
// (covered at the end of this file), so they pass the explicit skip.
const SKIP = ['--registry-gate-skip', 'test fixture: no semantic registry'];

function dryRun(manifest: string, oppId = '10065'): string {
  const dir = mkdtempSync(join(tmpdir(), 'labs-manifest-'));
  const file = join(dir, 'demo-data-setup_manifest.yaml');
  writeFileSync(file, manifest);
  const out = execFileSync(
    'npx',
    ['tsx', SCRIPT, file, '--opportunity-id', oppId, '--dry-run', ...SKIP],
    { encoding: 'utf8', cwd: resolve(__dirname, '../..') },
  );
  return out;
}

describe('scripts/run-labs-synthetic-generate.ts', () => {
  it('sends the file bytes verbatim as manifest_yaml', () => {
    const manifest = 'cohort:\n  size: 3\n  name: "Kemi"\n';
    const sent = JSON.parse(dryRun(manifest));
    expect(sent.params.arguments.manifest_yaml).toBe(manifest);
  });

  it('preserves the exact ace#1737 pathological shape', () => {
    // The real break: flow mappings column-aligned, so the longest key got ZERO
    // spaces between its `:` and its `{`. YAML requires whitespace there, so
    // this string is not valid YAML — and the script must send it unchanged
    // anyway rather than "helpfully" normalising it, because the archive is
    // this same file and the round-trip parse check downstream is what is
    // supposed to catch it.
    const pathological = 'answers:\n  ppi_q1:        { a: 1 }\n  ppi_q6_sachet_water:{ z: 3 }\n';
    const sent = JSON.parse(dryRun(pathological));
    expect(sent.params.arguments.manifest_yaml).toBe(pathological);
    expect(sent.params.arguments.manifest_yaml).toContain('ppi_q6_sachet_water:{ z: 3 }');
  });

  it('preserves trailing newline, CRLF and unicode without re-encoding', () => {
    const odd = 'name: "Kemi Adéyemí"\r\nnote: "— em dash"\n\n';
    const sent = JSON.parse(dryRun(odd));
    expect(sent.params.arguments.manifest_yaml).toBe(odd);
  });

  it('builds the tools/call envelope labs expects', () => {
    const sent = JSON.parse(dryRun('cohort: {}\n', '2255'));
    expect(sent.jsonrpc).toBe('2.0');
    expect(sent.method).toBe('tools/call');
    expect(sent.params.name).toBe('synthetic_generate_from_manifest');
    expect(sent.params.arguments.opportunity_id).toBe(2255);
  });

  it('--dry-run sends nothing and needs no token', () => {
    // The whole point of the flag: generation is a real mutation against a labs
    // opportunity, so the request must be inspectable before it is made — and
    // inspectable on a machine that has no LABS_MCP_TOKEN at all.
    const dir = mkdtempSync(join(tmpdir(), 'labs-manifest-'));
    const file = join(dir, 'm.yaml');
    writeFileSync(file, 'cohort: {}\n');
    const out = execFileSync(
      'npx',
      ['tsx', SCRIPT, file, '--opportunity-id', '1', '--dry-run', ...SKIP],
      { encoding: 'utf8', cwd: resolve(__dirname, '../..'), env: { ...process.env, LABS_MCP_TOKEN: '' } },
    );
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('refuses a non-integer opportunity id rather than sending it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'labs-manifest-'));
    const file = join(dir, 'm.yaml');
    writeFileSync(file, 'cohort: {}\n');
    expect(() =>
      execFileSync('npx', ['tsx', SCRIPT, file, '--opportunity-id', 'not-a-number', '--dry-run', ...SKIP], {
        encoding: 'utf8',
        cwd: resolve(__dirname, '../..'),
        stdio: 'pipe',
      }),
    ).toThrow();
  });

  it('the script never parses or re-serialises the manifest', () => {
    // A structural guard on the source, because the behavioural tests above
    // would all still pass if someone added a `yaml.parse` round-trip that
    // happened to be lossless for THESE fixtures. The file is read once, as
    // text, and handed straight to JSON.stringify.
    const src = readFileSync(SCRIPT, 'utf8');
    const code = src
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/*') && !l.trimStart().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/yaml\.(parse|load|safeLoad|stringify|dump)/);
    expect(code).toMatch(/readFileSync\(file, 'utf8'\)/);
  });
});

// ── The registry gate (lib/registry-eval-gate.ts) ────────────────────────────
// All three 2026-10-15 runs graded the registry AFTER generating against it.
// The script is the chokepoint, so it refuses without a passing verdict or an
// explicit, reasoned skip — and refuses BEFORE building or sending anything.
describe('scripts/run-labs-synthetic-generate.ts — registry gate', () => {
  function run(extra: string[]): { status: number; stdout: string; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), 'labs-gate-'));
    const file = join(dir, 'm.yaml');
    writeFileSync(file, 'cohort: {}\n');
    try {
      const stdout = execFileSync('npx', ['tsx', SCRIPT, file, '--opportunity-id', '7', '--dry-run', ...extra], {
        encoding: 'utf8',
        cwd: resolve(__dirname, '../..'),
        stdio: 'pipe',
      });
      return { status: 0, stdout, stderr: '' };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { status: err.status, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
    }
  }
  function verdictFile(disposition: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'labs-gate-v-'));
    const f = join(dir, 'semantic-registry-author-eval_verdict.yaml');
    writeFileSync(
      f,
      [
        'skill: semantic-registry-author-eval',
        'target: 6369',
        'ran_at: 2026-10-16T10:00:00Z',
        'capture_path: 7-synthetic/semantic-registry-author_registry.json',
        'overall_score: 8',
        `verdict: ${disposition}`,
        'dimensions:',
        '  pdd_fidelity: {score: 8, weight: 1.0}',
        '',
      ].join('\n'),
    );
    return f;
  }

  it('refuses with neither flag (exit 3), sending nothing', () => {
    const r = run([]);
    expect(r.status).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/--registry-eval-verdict/);
  });

  it('refuses a missing verdict file', () => {
    const r = run(['--registry-eval-verdict', join(tmpdir(), 'does-not-exist-registry-verdict.yaml')]);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/run semantic-registry-author-eval first/);
  });

  it('refuses a failing verdict', () => {
    const r = run(['--registry-eval-verdict', verdictFile('fail')]);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/BLOCKED/);
  });

  it('proceeds on a pass or warn verdict', () => {
    for (const d of ['pass', 'warn']) {
      const r = run(['--registry-eval-verdict', verdictFile(d)]);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).params.name).toBe('synthetic_generate_from_manifest');
    }
  });

  it('a skip needs a real reason', () => {
    expect(run(['--registry-gate-skip', '']).status).toBe(1);
    expect(run(['--registry-gate-skip', 'denovo provider: no semantic registry is authored']).status).toBe(0);
  });

  it('refuses both flags at once', () => {
    expect(
      run(['--registry-eval-verdict', verdictFile('pass'), '--registry-gate-skip', 'denovo provider here']).status,
    ).toBe(1);
  });
});
