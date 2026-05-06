/**
 * Tests for `scripts/run-content-generator.ts` — the CLI wrapper around
 * `lib/content-generator-client.ts::ContentGeneratorClient.generateImage`.
 *
 * The wrapper hits a real HTTP endpoint (Dimagi's gateway), so we don't
 * exercise the live API in unit tests. Instead we verify:
 *   - usage error path (no args → exit 1)
 *   - missing-env path (no CONTENT_GENERATOR_URL/_API_KEY → exit 2)
 *   - bad-input path (malformed input.json → exit 2)
 *
 * The happy path is covered manually via the smoke step documented in the
 * skill PR description; spinning up a fake HTTP server adds churn for
 * little additional confidence beyond what
 * `lib/content-generator-client.test.ts` already gives us.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/run-content-generator.ts');

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'run-content-generator-test-'));
});

afterAll(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

function runScript(
  args: string[],
  env: Record<string, string | undefined> = {},
): { code: number; stdout: string; stderr: string } {
  const res = spawnSync('npx', ['tsx', SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      // Allow tests to scrub these explicitly by passing undefined.
      ...env,
    },
  });
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

describe('scripts/run-content-generator.ts', () => {
  it('exits 1 with a usage message when called with no arguments', () => {
    const { code, stderr } = runScript([], {
      CONTENT_GENERATOR_URL: 'https://example.com',
      CONTENT_GENERATOR_API_KEY: 'fake',
    });
    expect(code).toBe(1);
    expect(stderr).toContain('Usage:');
  });

  it('exits 2 when CONTENT_GENERATOR_URL/_API_KEY are missing', () => {
    const inputPath = join(tmp, 'input.json');
    const outputPath = join(tmp, 'out.png');
    writeFileSync(
      inputPath,
      JSON.stringify({ applicationContext: 'ctx', formText: 'text', upscale: false }),
    );
    // Clear the env vars so the wrapper's missing-env check fires.
    const { code, stderr } = runScript([inputPath, outputPath], {
      CONTENT_GENERATOR_URL: '',
      CONTENT_GENERATOR_API_KEY: '',
    });
    expect(code).toBe(2);
    expect(stderr).toContain('CONTENT_GENERATOR_URL');
  });

  it('exits 2 on malformed input JSON (missing applicationContext)', () => {
    const inputPath = join(tmp, 'bad.json');
    const outputPath = join(tmp, 'out.png');
    writeFileSync(inputPath, JSON.stringify({ formText: 'no app context' }));
    const { code, stderr } = runScript([inputPath, outputPath], {
      CONTENT_GENERATOR_URL: 'https://example.com',
      CONTENT_GENERATOR_API_KEY: 'fake',
    });
    expect(code).toBe(2);
    expect(stderr).toContain('applicationContext');
  });

  it('exits 2 on input JSON with non-string upscale', () => {
    const inputPath = join(tmp, 'bad-upscale.json');
    const outputPath = join(tmp, 'out.png');
    writeFileSync(
      inputPath,
      JSON.stringify({ applicationContext: 'ctx', formText: 'text', upscale: 'yes' }),
    );
    const { code, stderr } = runScript([inputPath, outputPath], {
      CONTENT_GENERATOR_URL: 'https://example.com',
      CONTENT_GENERATOR_API_KEY: 'fake',
    });
    expect(code).toBe(2);
    expect(stderr).toContain('upscale');
  });
});
