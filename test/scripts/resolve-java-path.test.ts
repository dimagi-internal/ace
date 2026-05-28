import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'resolve-java-path.ts');

function runResolver(env: NodeJS.ProcessEnv): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('npx', ['tsx', SCRIPT], {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
    });
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? '', status: err.status ?? 1 };
  }
}

describe('scripts/resolve-java-path.ts', () => {
  it('echoes $ACE_JAVA_BIN verbatim and exits 0 (mirrors resolveJavaPath precedence)', () => {
    const explicit = '/opt/some/jdk/bin/java';
    const { stdout, status } = runResolver({ ...process.env, ACE_JAVA_BIN: explicit });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(explicit);
  });

  it('prints a non-empty path XOR exits 1 — never both', () => {
    // Environment-agnostic invariant: with ACE_JAVA_BIN cleared the result
    // depends on the host JDK, but the contract is binary — a path on exit 0,
    // or empty stdout on exit 1.
    const env = { ...process.env };
    delete env.ACE_JAVA_BIN;
    const { stdout, status } = runResolver(env);
    if (status === 0) {
      expect(stdout.trim().length).toBeGreaterThan(0);
    } else {
      expect(status).toBe(1);
      expect(stdout.trim()).toBe('');
    }
  });
});
