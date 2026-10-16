/**
 * dimagi-internal/ace#2905 — `/ace:doctor --preflight` said `status: ok` on
 * runner cloud-ec2-2 while every Playwright-backed atom died at launch:
 *
 *   1. browserType.launch: Executable doesn't exist at ~/.cache/ms-playwright/...
 *   2. (after `npx playwright install chromium`)
 *      error while loading shared libraries: libatk-1.0.so.0 (exit 127)
 *
 * The full doctor's `playwright_chromium` only checked the executable EXISTED
 * (so case 2 passed), and preflight had no browser probe at all.
 *
 * These tests run the real `pw_launch_probe` / `pw_launch_classify`, lifted
 * verbatim out of bin/ace-doctor, against a stub `node` on PATH that prints
 * each real failure string, then parse the preflight block they render.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCTOR = path.join(__dirname, '../../bin/ace-doctor');
const doctorSrc = fs.readFileSync(DOCTOR, 'utf8');
const lines = doctorSrc.split('\n');

function extractFn(name: string): string {
  const start = lines.findIndex((l) => l === `${name}() {`);
  if (start < 0) throw new Error(`${name}() not found in bin/ace-doctor`);
  const end = lines.indexOf('}', start);
  if (end < 0) throw new Error(`${name}() has no closing brace`);
  return lines.slice(start, end + 1).join('\n');
}

/** The preflight `PF_PW_YAML="..."` assignment, verbatim. */
function extractYamlTemplate(): string {
  const start = lines.findIndex((l) => l.trim().startsWith('PF_PW_YAML="playwright_launch:'));
  if (start < 0) throw new Error('PF_PW_YAML template not found in the preflight block');
  let end = start;
  while (!lines[end].trimEnd().endsWith('\\""')) end++;
  return lines.slice(start, end + 1).join('\n');
}

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-pw-launch-'));
});

function runWithNodeOutput(nodeStdout: string, nodeRc: number) {
  const bin = fs.mkdtempSync(path.join(dir, 'bin-'));
  const root = fs.mkdtempSync(path.join(dir, 'root with space-'));
  fs.writeFileSync(
    path.join(bin, 'node'),
    `#!/bin/sh\ncat <<'__OUT__'\n${nodeStdout}\n__OUT__\nexit ${nodeRc}\n`,
    { mode: 0o755 },
  );
  const harness = [
    `export PATH=${JSON.stringify(bin)}:"$PATH"`,
    `ROOT=${JSON.stringify(root)}`,
    extractFn('pw_launch_classify'),
    extractFn('pw_launch_probe'),
    'pw_launch_probe',
    extractYamlTemplate(),
    'printf "%s\\n" "$PF_PW_YAML"',
  ].join('\n');
  const file = path.join(dir, `h-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(file, harness);
  const out = execFileSync('bash', [file], { encoding: 'utf8' });
  return { root, block: parseYaml(out).playwright_launch as Record<string, string> };
}

describe('playwright_launch (ace#2905)', () => {
  it('a clean launch passes', () => {
    const { block } = runWithNodeOutput('LAUNCH_OK', 0);
    expect(block.status).toBe('pass');
    expect(block.class).toBe('ok');
  });

  it("browser never installed (\"Executable doesn't exist\") → install chromium", () => {
    const { block, root } = runWithNodeOutput(
      "LAUNCH_ERR browserType.launch: Executable doesn't exist at /home/ubuntu/.cache/ms-playwright/chromium_headless_shell-1217/chrome-linux/headless_shell\n" +
        '╔════════════════════════════╗\n║ Looks like Playwright was just installed ║',
      1,
    );
    expect(block.status).toBe('warn');
    expect(block.class).toBe('browser_missing');
    expect(block.remediation).toBe(`cd "${root}" && npx playwright install chromium`);
    expect(block.detail).toMatch(/Executable doesn't exist/);
  });

  it('spawn ENOENT also reads as the browser missing', () => {
    const { block } = runWithNodeOutput('LAUNCH_ERR spawn /x/headless_shell ENOENT', 1);
    expect(block.class).toBe('browser_missing');
  });

  it('missing system libs ("shared libraries") → sudo install-deps', () => {
    const { block, root } = runWithNodeOutput(
      'LAUNCH_ERR browserType.launch: Target page, context or browser has been closed\n' +
        '/home/ubuntu/.cache/ms-playwright/chromium_headless_shell-1217/chrome-linux/headless_shell: ' +
        'error while loading shared libraries: libatk-1.0.so.0: cannot open shared object file: No such file or directory',
      1,
    );
    expect(block.status).toBe('warn');
    expect(block.class).toBe('system_deps_missing');
    expect(block.remediation).toBe(`cd "${root}" && sudo npx playwright install-deps chromium`);
  });

  it('never grades `fail` — a machine without Playwright must not halt /ace:run', () => {
    for (const [out, rc] of [
      ["LAUNCH_ERR Executable doesn't exist at /x", 1],
      ['LAUNCH_ERR error while loading shared libraries: libatk-1.0.so.0', 1],
      ["LAUNCH_ERR Cannot find module 'playwright'", 1],
      ['LAUNCH_TIMEOUT', 2],
      ['', 127],
      ['LAUNCH_ERR something nobody has seen', 1],
    ] as const) {
      expect(runWithNodeOutput(out, rc).block.status).not.toBe('fail');
    }
  });

  it('no output at all is a warn, never a pass', () => {
    expect(runWithNodeOutput('', 127).block.status).toBe('warn');
  });

  it('the block is emitted inside the preflight YAML heredoc', () => {
    const pf = doctorSrc.slice(doctorSrc.indexOf('if [ "$PREFLIGHT" = "1" ]; then'));
    const heredoc = pf.slice(pf.indexOf("cat <<EOF\nstatus: ok"), pf.indexOf('\nEOF\n'));
    expect(heredoc).toContain('${PF_PW_YAML}');
  });

  it('the full doctor launches too, instead of only checking the file exists', () => {
    const i = doctorSrc.indexOf('if [ "$PW_EXISTS" = "1" ]; then');
    expect(i).toBeGreaterThan(0);
    expect(doctorSrc.slice(i, i + 400)).toContain('pw_launch_probe');
  });
});
