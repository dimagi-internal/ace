/**
 * bin/ace-labs-walkthrough-login must read the plugin .env as dotenv, not source it
 * (ace#3372). The real file has `ACE_E2E_NAME=ACE Test` and passwords with shell
 * characters; `source` died on the first of them and the login never started.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;

describe('labs login reads .env as dotenv (#3372)', () => {
  it('exports values with spaces and shell characters unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dotenv-'));
    const file = join(dir, '.env');
    writeFileSync(
      file,
      ['# a comment', 'ACE_E2E_NAME=ACE Test', 'ACE_HQ_PASSWORD=p4ss!w0rd$x&y;z', 'QUOTED="two words"', ''].join('\n'),
    );
    const out = execFileSync(
      'bash',
      ['-c', `set -euo pipefail; eval "$(python3 ${ROOT}bin/_dotenv-export.py ${file})"; printf '%s|%s|%s' "$ACE_E2E_NAME" "$ACE_HQ_PASSWORD" "$QUOTED"`],
      { encoding: 'utf-8' },
    );
    expect(out).toBe('ACE Test|p4ss!w0rd$x&y;z|two words');
  });

  it('the script no longer sources the file', () => {
    const src = readFileSync(join(ROOT, 'bin/ace-labs-walkthrough-login'), 'utf-8');
    expect(src).not.toMatch(/^\s*source\s+"\$ENV_FILE"/m);
    expect(src).toContain('_dotenv-export.py');
  });
});
