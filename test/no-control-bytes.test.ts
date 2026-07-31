import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..');

// Raw control bytes in a source file make `file` classify it as binary, so
// plain grep silently returns no matches on the whole file — hiding code from
// searches and drift detectors. Unicode escape sequences are byte-identical
// at runtime and keep the file text. See ace#1099.
describe('no raw control bytes in tracked TypeScript sources', () => {
  it('every tracked *.ts file is control-byte-free', () => {
    const files = execFileSync('git', ['ls-files', '*.ts'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const f of files) {
      const buf = readFileSync(join(repoRoot, f));
      for (let i = 0; i < buf.length; i++) {
        const b = buf[i];
        // allow \t (9), \n (10), \r (13)
        if (b < 9 || (b > 10 && b < 13) || (b > 13 && b < 32) || b === 127) {
          const line = buf.subarray(0, i).toString('utf8').split('\n').length;
          offenders.push(`${f}:${line} byte 0x${b.toString(16).padStart(2, '0')}`);
          break;
        }
      }
    }
    expect(offenders, `raw control bytes found (use \\u escapes instead):\n${offenders.join('\n')}`).toEqual([]);
  });
});
