#!/usr/bin/env npx tsx
/**
 * Validate a standalone Connect opportunity spec. Step 0 of
 * `/ace:connect-opp-create`.
 *
 *   npx tsx "${CLAUDE_PLUGIN_ROOT:-.}/scripts/validate-connect-opp-spec.ts" <spec.yaml>
 *
 * Exit 0 = safe to create. Exit 1 = blocking issues. Exit 2 = could not read
 * or parse the file.
 *
 * ## Why this is a script and not an inline `tsx -e` snippet
 *
 * It was a snippet, and the snippet FAILED OPEN. `tsx -e` evaluates in a
 * context with no module path, so `import ... from './lib/connect-opp-spec.js'`
 * cannot resolve -- and in the multi-line form the process exits 0 having
 * printed nothing at all. Step 0's instruction is "halt on any [ERROR]", so an
 * operator reads the silence as "no issues" and proceeds to a create whose app
 * wiring is write-once. A gate that cannot run must fail LOUD; this one failed
 * silent, in front of the one irreversible step in the flow.
 *
 * A real file also gets a resolvable relative import, an exit code the caller
 * can branch on, and a unit-testable entry point.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import {
  validateConnectOppSpec,
  formatSpecIssues,
  hasBlockingIssue,
  type SpecIssue,
} from '../lib/connect-opp-spec.js';

/** Read + parse, or explain why not. Exported for tests. */
export function loadSpec(path: string): { spec: unknown } | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { error: `cannot read ${path}: ${(e as Error).message}` };
  }
  try {
    return { spec: parse(raw) };
  } catch (e) {
    return { error: `${path} is not valid YAML: ${(e as Error).message}` };
  }
}

/** The whole gate, minus process exit. Exported so a test can drive it. */
export function runValidation(path: string): { code: 0 | 1 | 2; output: string } {
  const loaded = loadSpec(path);
  if ('error' in loaded) return { code: 2, output: `[FATAL] ${loaded.error}` };

  const issues: SpecIssue[] = validateConnectOppSpec(loaded.spec);
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warns = issues.length - errors;
  const tally = issues.length === 0
    ? ''
    : `\n\n${errors} error(s), ${warns} warning(s).`;

  return {
    code: hasBlockingIssue(issues) ? 1 : 0,
    output: formatSpecIssues(issues) + tally,
  };
}

function main(): void {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: validate-connect-opp-spec.ts <spec.yaml>');
    process.exit(2);
  }
  const { code, output } = runValidation(path);
  console.log(output);
  if (code === 1) {
    console.error('\nBlocking issues above. Nothing was created. Fix the spec and re-run.');
  }
  process.exit(code);
}

// Only run when invoked directly, so the exports stay importable from a test.
if (process.argv[1] && process.argv[1].endsWith('validate-connect-opp-spec.ts')) {
  main();
}
