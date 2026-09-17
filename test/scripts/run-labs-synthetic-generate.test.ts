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

function dryRun(manifest: string, oppId = '10065'): string {
  const dir = mkdtempSync(join(tmpdir(), 'labs-manifest-'));
  const file = join(dir, 'demo-data-setup_manifest.yaml');
  writeFileSync(file, manifest);
  const out = execFileSync(
    'npx',
    ['tsx', SCRIPT, file, '--opportunity-id', oppId, '--dry-run'],
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
      ['tsx', SCRIPT, file, '--opportunity-id', '1', '--dry-run'],
      { encoding: 'utf8', cwd: resolve(__dirname, '../..'), env: { ...process.env, LABS_MCP_TOKEN: '' } },
    );
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('refuses a non-integer opportunity id rather than sending it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'labs-manifest-'));
    const file = join(dir, 'm.yaml');
    writeFileSync(file, 'cohort: {}\n');
    expect(() =>
      execFileSync('npx', ['tsx', SCRIPT, file, '--opportunity-id', 'not-a-number', '--dry-run'], {
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
