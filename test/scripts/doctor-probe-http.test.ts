/**
 * dimagi-internal/ace#2931 — an HTTP probe in bin/ace-doctor must never report
 * a status that cannot exist.
 *
 * `curl -w '%{http_code}'` already prints `000` on a connection failure AND
 * exits non-zero, so `X="$(curl ... -w '%{http_code}' ... || echo "000")"`
 * captures BOTH and yields `000000`. Seven of the doctor's eight probes carried
 * it. On 2026-10-15 `connect_orgs` reported `HTTP 000000` for an org that
 * answered 200 three times out of three, and the reading was carried into a
 * run as a Phase 4 blocker.
 *
 * Two pins, class not instance:
 *   1. structural — every `%{http_code}` capture goes through `probe_http`, and
 *      no `|| echo "000"` sits in a capture;
 *   2. behavioural — `probe_http`, lifted verbatim, emits exactly one
 *      three-digit status for a stubbed curl that fails the way real curl does.
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
const lines = doctorSrc.split('\n');

function extractFn(name: string): string {
  const start = lines.findIndex((l) => l === `${name}() {`);
  if (start < 0) throw new Error(`${name}() not found in bin/ace-doctor`);
  const end = lines.indexOf('}', start);
  if (end < 0) throw new Error(`${name}() has no closing brace`);
  return lines.slice(start, end + 1).join('\n');
}

/** Every `$(...)` capture (start line .. line ending `)"`) that asks curl for %{http_code}. */
function httpCodeCaptures(): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/="\$\(/.test(lines[i]) || lines[i].trimStart().startsWith('#')) continue;
    let j = i;
    while (j < lines.length && !lines[j].trimEnd().endsWith(')"')) j++;
    const text = lines.slice(i, j + 1).join('\n');
    if (text.includes("%{http_code}")) out.push({ line: i + 1, text });
  }
  return out;
}

describe('bin/ace-doctor HTTP status captures (ace#2931)', () => {
  it('finds the probes (guards the scanner against matching nothing)', () => {
    expect(httpCodeCaptures().length).toBeGreaterThanOrEqual(8);
  });

  it('routes every %{http_code} capture through probe_http', () => {
    const bad = httpCodeCaptures()
      .filter((c) => !/="\$\(probe_http (curl|curl_auth) /.test(c.text))
      .map((c) => `bin/ace-doctor:${c.line}`);
    expect(bad, 'capture %{http_code} with probe_http, never bare curl').toEqual([]);
  });

  it('has no `|| echo "000"` fallback next to %{http_code} anywhere', () => {
    const bad = httpCodeCaptures()
      .filter((c) => /\|\|\s*echo\s+"?000"?/.test(c.text))
      .map((c) => `bin/ace-doctor:${c.line}`);
    expect(bad).toEqual([]);
  });
});

describe('probe_http (ace#2931)', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-probe-http-'));
  });

  /** Run probe_http over a stub "curl" that prints `stdout` and exits `rc`. */
  function run(stdout: string, rc: number): string {
    const harness = [
      'set -u',
      `fakecurl() { printf '%s' ${JSON.stringify(stdout)}; echo "curl: (6) boom" >&2; return ${rc}; }`,
      extractFn('probe_http'),
      `X="$(probe_http fakecurl -sS -o /dev/null -w '%{http_code}' https://example.invalid/)"`,
      // The exact construct that used to produce 000000, for contrast.
      `printf '%s' "$X"`,
    ].join('\n');
    const file = path.join(dir, `h-${Math.random().toString(36).slice(2)}.sh`);
    fs.writeFileSync(file, harness);
    return execFileSync('bash', [file], { encoding: 'utf8' });
  }

  it('the old construct really does produce 000000 (control)', () => {
    const out = execFileSync(
      'bash',
      ['-c', `fakecurl() { printf 000; return 6; }; X="$(fakecurl 2>/dev/null || echo "000")"; printf '%s' "$X"`],
      { encoding: 'utf8' },
    );
    expect(out).toBe('000000');
  });

  it('a connection failure (curl prints 000, exits non-zero) reads as 000', () => {
    expect(run('000', 6)).toBe('000');
  });

  it('a real status passes through unchanged', () => {
    expect(run('302', 0)).toBe('302');
    expect(run('200', 0)).toBe('200');
  });

  it('curl missing / no output reads as 000, never empty', () => {
    expect(run('', 127)).toBe('000');
  });

  it('never emits anything but a single three-digit status', () => {
    for (const [s, rc] of [['000000', 6], ['garbage', 0], ['2000', 0]] as const) {
      expect(run(s, rc)).toMatch(/^(000|[1-5]\d\d)$/);
    }
  });
});
