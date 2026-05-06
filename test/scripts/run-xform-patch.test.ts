/**
 * Tests for `scripts/run-xform-patch.ts` — the CLI wrapper around
 * `lib/multimedia-xform-patch.ts::addImageItext`. Spawns the script via
 * `npx tsx` against the existing `multimedia-sample-form.xml` fixture and
 * confirms the wrapper's contract (patched XML on stdout, JSON summary on
 * stderr, --replace-existing flag honored, exit codes correct).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/run-xform-patch.ts');
const FIXTURE_FORM = join(REPO_ROOT, 'test/fixtures/cchq/multimedia-sample-form.xml');

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'run-xform-patch-test-'));
});

afterAll(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

function runScript(args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync('npx', ['tsx', SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

describe('scripts/run-xform-patch.ts', () => {
  it('writes patched XML to stdout and a JSON summary to stderr', () => {
    const bindingsPath = join(tmp, 'bindings.json');
    writeFileSync(
      bindingsPath,
      JSON.stringify([{ fieldId: 'kmc_position_demo', cczFilename: 'kmc_position_demo.png' }]),
    );

    const { code, stdout, stderr } = runScript([FIXTURE_FORM, bindingsPath]);
    expect(code).toBe(0);
    expect(stdout).toContain(
      '<value form="image">jr://file/commcare/image/kmc_position_demo.png</value>',
    );
    // Original label content must remain.
    expect(stdout).toContain("Show the mother how to support the baby's head and neck.");

    // stderr is a single JSON line.
    const lastLine = stderr.trim().split('\n').pop() ?? '';
    const summary = JSON.parse(lastLine);
    expect(summary.patched).toBe(true);
    expect(summary.applied).toEqual(['kmc_position_demo']);
    expect(summary.skipped).toEqual([]);
    expect(summary.notFound).toEqual([]);
  });

  it('writes to -o <path> instead of stdout when given', () => {
    const bindingsPath = join(tmp, 'bindings-o.json');
    const outPath = join(tmp, 'patched.xml');
    writeFileSync(
      bindingsPath,
      JSON.stringify([{ fieldId: 'kmc_position_demo', cczFilename: 'demo.png' }]),
    );

    const { code, stdout, stderr } = runScript([FIXTURE_FORM, bindingsPath, '-o', outPath]);
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath, 'utf-8')).toContain(
      '<value form="image">jr://file/commcare/image/demo.png</value>',
    );

    const lastLine = stderr.trim().split('\n').pop() ?? '';
    const summary = JSON.parse(lastLine);
    expect(summary.applied).toEqual(['kmc_position_demo']);
  });

  it('honors --replace-existing by stripping prior <image> values before adding the new one', () => {
    // First patch — adds the original filename.
    const firstBindings = join(tmp, 'first.json');
    const intermediateXml = join(tmp, 'intermediate.xml');
    writeFileSync(
      firstBindings,
      JSON.stringify([{ fieldId: 'kmc_position_demo', cczFilename: 'old.png' }]),
    );
    runScript([FIXTURE_FORM, firstBindings, '-o', intermediateXml]);
    expect(readFileSync(intermediateXml, 'utf-8')).toContain('jr://file/commcare/image/old.png');

    // Second patch with --replace-existing — should drop old.png entirely.
    const secondBindings = join(tmp, 'second.json');
    writeFileSync(
      secondBindings,
      JSON.stringify([{ fieldId: 'kmc_position_demo', cczFilename: 'new.png' }]),
    );
    const { code, stdout } = runScript([
      intermediateXml,
      secondBindings,
      '--replace-existing',
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('jr://file/commcare/image/new.png');
    expect(stdout).not.toContain('jr://file/commcare/image/old.png');
  });

  it('records notFound when no matching itext text exists', () => {
    const bindingsPath = join(tmp, 'missing.json');
    writeFileSync(
      bindingsPath,
      JSON.stringify([{ fieldId: 'no_such_field_id', cczFilename: 'x.png' }]),
    );

    const { code, stderr } = runScript([FIXTURE_FORM, bindingsPath]);
    expect(code).toBe(0);
    const lastLine = stderr.trim().split('\n').pop() ?? '';
    const summary = JSON.parse(lastLine);
    expect(summary.patched).toBe(false);
    expect(summary.notFound).toEqual(['no_such_field_id']);
  });

  it('exits 1 with a usage message when called with no arguments', () => {
    const { code, stderr } = runScript([]);
    expect(code).toBe(1);
    expect(stderr).toContain('Usage:');
  });

  it('exits 2 on malformed bindings JSON', () => {
    const bindingsPath = join(tmp, 'bad.json');
    writeFileSync(bindingsPath, '{ not an array }');
    const { code, stderr } = runScript([FIXTURE_FORM, bindingsPath]);
    expect(code).toBe(2);
    expect(stderr).toContain('Failed to read/parse');
  });
});
