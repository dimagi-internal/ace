/**
 * bin/ace-doctor must run clean on a Linux cloud runner and must never report
 * "HEALTHY" over a report that silently lost checks.
 *
 * ## The incident (2026-11-02, cloud runner)
 *
 * `stat -f %m F || stat -c %Y F` is correct on macOS and wrong on Linux: GNU
 * `stat -f` is "filesystem status", valid and exit-0, so the fallback never ran
 * and the doctor interpolated a multi-line filesystem report into `$(( ))`.
 * The syntax error aborted the whole enclosing block, so `nova_env`,
 * `hq_api_key_env` and `connect_labs_env` never ran, their variables stayed
 * empty, and `nova_auth`/`labs_auth`/`hq_api_key_auth` reported "key not set"
 * for three keys that were present — all under a "HEALTHY" verdict.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

function sh(script: string): string {
  return execFileSync('bash', ['-c', script], { encoding: 'utf-8' }).trim();
}

describe('portable stat helpers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ace-stat-'));
  const file = join(dir, 'f');
  writeFileSync(file, 'hello world'); // 11 bytes

  it('ace_file_size is a single integer equal to the byte length', () => {
    const out = sh(`. "${ROOT}bin/_ace-plugin-paths.sh"; ace_file_size "${file}"`);
    expect(out).toBe('11');
  });

  it('ace_file_mtime is a single epoch integer, not a filesystem report', () => {
    const out = sh(`. "${ROOT}bin/_ace-plugin-paths.sh"; ace_file_mtime "${file}"`);
    expect(out).toMatch(/^\d{9,}$/);
    expect(Math.abs(Number(out) - Date.now() / 1000)).toBeLessThan(120);
  });

  it('both return 0 (not garbage) for a missing file', () => {
    expect(sh(`. "${ROOT}bin/_ace-plugin-paths.sh"; ace_file_mtime /nonexistent/x`)).toBe('0');
    expect(sh(`. "${ROOT}bin/_ace-plugin-paths.sh"; ace_file_size /nonexistent/x`)).toBe('0');
  });

  it('no shell script writes the broken `stat -f … || stat -c …` chain', () => {
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(join(ROOT, d))) {
        const rel = join(d, name);
        if (statSync(join(ROOT, rel)).isDirectory()) continue;
        const text = readFileSync(join(ROOT, rel), 'utf-8')
          .split('\n')
          .filter((l) => !l.trim().startsWith('#'))
          .join('\n');
        if (/stat -f [^\n]*\|\|\s*stat -c/.test(text)) offenders.push(rel);
      }
    };
    walk('bin');
    walk('scripts');
    expect(offenders, 'use ace_file_mtime / ace_file_size from bin/_ace-plugin-paths.sh').toEqual([]);
  });
});

describe('ace-doctor reports its own failures', () => {
  const doctor = read('bin/ace-doctor');

  it('stderr joins the log so a bash crash inside a check is visible to the summary', () => {
    expect(doctor).toMatch(/exec > >\(tee "\$DOCTOR_LOG"\) 2>&1/);
  });

  it('a crashed check becomes a FAIL, not a quiet HEALTHY', () => {
    expect(doctor).toContain('doctor_internal_error');
    expect(doctor).toMatch(/ace-doctor: line \[0-9\]\+:/);
  });

  it('a check that never reported becomes a FAIL', () => {
    expect(doctor).toContain('doctor_coverage');
    for (const probe of ['nova_env', 'hq_api_key_env', 'connect_labs_env', 'connect_session']) {
      expect(doctor, `${probe} must be on the required-probe list`).toMatch(
        new RegExp(`for _probe in [^\\n]*\\b${probe}\\b`),
      );
    }
  });

  it('never mutates the needs-auth cache on the strength of a probe that did not run', () => {
    expect(doctor).toMatch(/NOVA_HDR_MISSING" = "1" \] \|\| \[ "\$\{NOVA_HDR_RC:-0\}" != "0"/);
  });
});

describe('ace-doctor is backend-aware on mobile', () => {
  const doctor = read('bin/ace-doctor');

  it('demands local Maestro/adb/AVD only where the local backend will run', () => {
    expect(doctor).toContain('resolve-mobile-backend.ts');
    expect(doctor).toMatch(/MOBILE_DEFAULT_BACKEND" = "lease"/);
  });

  it('the resolver script uses the MCP\'s own rule', () => {
    expect(read('scripts/resolve-mobile-backend.ts')).toContain('leaseIsDefaultHere');
  });
});

describe('env_drift compares against the vault, not a stale side file', () => {
  const doctor = read('bin/ace-doctor');
  it('resolves the vault with canopy agent env and compares names and values', () => {
    expect(doctor).toMatch(/canopy agent env --plugin ace --out "\$_VDIR\/\.env"/);
    expect(doctor).toContain('value changed in vault');
  });
  it('says so when it could not compare, instead of staying silent', () => {
    expect(doctor).toContain('was NOT compared');
  });
});
