/**
 * ace#1964 — unit cover for the analyzer behind the Bash-reachable env-loading
 * ratchet (`test/scripts/bash-reachable-env-loading.test.ts`).
 *
 * The ratchet's whole value is that it CANNOT quietly under-detect: a analyzer
 * that misses a read reports green over exactly the defect it exists to catch,
 * and that is how ten scripts accumulated in the first place. So the cases here
 * are mostly about what the parse must NOT lose — with the regex-literal case
 * kept as a live control, because the first cut of this module did lose it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeScriptSource,
  DECLARED_ENV_NAMES,
  discoverBashReachableScripts,
  EXTRA_GUARDED_VARS,
  findUndeclaredEnvSpellings,
  isGuardedVar,
  RETIRED_ENV_SPELLINGS,
  shellEnvNames,
} from '../../lib/bash-reachable-scripts.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('isGuardedVar', () => {
  it('matches the vault name families and the documented extras', () => {
    for (const n of ['ACE_HQ_USERNAME', 'NOVA_API_KEY', 'OCS_TEAM_SLUG', 'LABS_MCP_TOKEN', 'ACE_WEB_BASE_URL']) {
      expect(isGuardedVar(n), n).toBe(true);
    }
    for (const extra of Object.keys(EXTRA_GUARDED_VARS)) expect(isGuardedVar(extra)).toBe(true);
    for (const n of ['HOME', 'PATH', 'ACE_MOBILE_BACKEND']) expect(isGuardedVar(n), n).toBe(false);
  });

  it('every extra carries a reason — the only hand-maintained input here', () => {
    for (const [name, why] of Object.entries(EXTRA_GUARDED_VARS)) {
      expect(why.length, `${name} needs a reason`).toBeGreaterThan(10);
    }
  });
});

describe('analyzeScriptSource', () => {
  it('finds a dotted read and the loader, in source order', () => {
    const a = analyzeScriptSource(
      'x.ts',
      ['loadPluginEnv(import.meta.url);', 'const u = process.env.ACE_HQ_USERNAME;'].join('\n'),
    );
    expect(a.envReads.map((r) => r.variable)).toEqual(['ACE_HQ_USERNAME']);
    expect(a.loaderIndex).toBeGreaterThan(-1);
    expect(a.loaderIndex).toBeLessThan(a.envReads[0].index);
  });

  it('finds the bracket form too', () => {
    const a = analyzeScriptSource('x.ts', "const u = process.env['OCS_TEAM_SLUG'];");
    expect(a.envReads.map((r) => r.variable)).toEqual(['OCS_TEAM_SLUG']);
  });

  it('does not count a variable that is only NAMED in a comment or a string', () => {
    const a = analyzeScriptSource(
      'x.ts',
      [
        '/** Requires process.env.NOVA_API_KEY in the plugin-data .env. */',
        "// also process.env.OCS_PASSWORD, mentioned in prose",
        "const msg = 'set process.env.ACE_HQ_PASSWORD first';",
        'const real = process.env.ACE_HQ_USERNAME;',
      ].join('\n'),
    );
    expect(a.envReads.map((r) => r.variable)).toEqual(['ACE_HQ_USERNAME']);
  });

  it('still sees a read that follows a regex literal containing a quote', () => {
    // The live control. A hand-rolled comment/string blanker read the
    // apostrophe inside /'/g as opening a string and swallowed everything
    // after it: `scripts/grant-review-access.ts` reported its first credential
    // read 467 lines late, and `scripts/probe-connect-learn-handoff.ts` fell
    // out of the results entirely. Same shape as the dump-atom-schemas.ts
    // parser bug in CLAUDE.md § Gotchas.
    const a = analyzeScriptSource(
      'x.ts',
      [
        "const q = name.replace(/'/g, \"\\\\'\");",
        'const base = process.env.ACE_HQ_BASE_URL;',
      ].join('\n'),
    );
    expect(a.envReads.map((r) => r.variable)).toEqual(['ACE_HQ_BASE_URL']);
  });

  it('does not mistake a URL inside a string for a line comment', () => {
    const a = analyzeScriptSource(
      'x.ts',
      "const b = process.env.OCS_BASE_URL ?? 'https://www.openchatstudio.com'; const t = process.env.OCS_TEAM_SLUG;",
    );
    expect(a.envReads.map((r) => r.variable)).toEqual(['OCS_BASE_URL', 'OCS_TEAM_SLUG']);
  });

  it('reports the loader as absent when it is absent', () => {
    const a = analyzeScriptSource('x.ts', 'const u = process.env.ACE_HQ_USERNAME;');
    expect(a.loaderIndex).toBe(-1);
  });

  it('throws rather than returning an empty walk when the source will not parse', () => {
    // A parse failure yields zero reads, which would PASS the ratchet. Loud is
    // the only safe direction.
    expect(() => analyzeScriptSource('x.ts', 'const x = process.env.A;\nfunction ( {{{\n')).toThrow(
      /parse diagnostic/,
    );
  });

  it('records 1-based line numbers', () => {
    const a = analyzeScriptSource('x.ts', ['', '', 'const u = process.env.NOVA_API_KEY;'].join('\n'));
    expect(a.envReads[0].line).toBe(3);
  });
});

describe('discoverBashReachableScripts on the real repo', () => {
  const findings = discoverBashReachableScripts(REPO_ROOT);

  it('finds a non-trivial set — an empty result would mean the walk is broken', () => {
    expect(findings.length).toBeGreaterThanOrEqual(10);
  });

  it('every finding names at least one skills/ agents/ commands/ file', () => {
    for (const f of findings) {
      expect(f.referencedBy.length, `${f.script} has no referrer`).toBeGreaterThan(0);
    }
  });

  it('includes the two scripts ace#1957 already fixed', () => {
    const names = findings.map((f) => f.script);
    expect(names).toContain('scripts/run-content-generator.ts');
    expect(names).toContain('scripts/run-nova-media-upload.ts');
  });
});

/**
 * ace#1969 — the spelling-drift guard.
 *
 * The sibling ratchet asks whether a script loads `.env`; it cannot ask whether
 * the name it then reads is one `.env` sets. `ACE_WEB_BASE` (script + 2 commands
 * + 6 skills), `ACE_WEB_URL` (sweep-ace-web) and `ACE_WEB_BASE_URL` (the vault,
 * doctor, the mobile cloud backend) all named the ace-web host and never met, so
 * every Bash path took a hardcoded default regardless of what `/ace:setup`
 * provisioned — silently, the default being a real reachable host.
 */
describe('DECLARED_ENV_NAMES', () => {
  it('carries the ace-web contract', () => {
    expect(DECLARED_ENV_NAMES.has('ACE_WEB_BASE_URL')).toBe(true);
    expect(DECLARED_ENV_NAMES.has('ACE_WEB_PAT_TOKEN')).toBe(true);
  });
});

describe('shellEnvNames', () => {
  it('sees every expansion form and an inline assignment', () => {
    const names = shellEnvNames(
      [
        'BASE="${ACE_WEB_BASE_URL%/}"',
        'echo "$ACE_WEB_WORKSPACE"',
        'ACE_WEB_BASE=http://localhost:8000 npx tsx scripts/x.ts',
        '"${ACE_WEB_PAT_TOKEN:-}"',
      ].join('\n'),
    );
    for (const n of ['ACE_WEB_BASE_URL', 'ACE_WEB_WORKSPACE', 'ACE_WEB_BASE', 'ACE_WEB_PAT_TOKEN']) {
      expect(names.has(n), n).toBe(true);
    }
  });
});

describe('findUndeclaredEnvSpellings on the real repo', () => {
  const uses = findUndeclaredEnvSpellings(REPO_ROOT, 'ACE_WEB_');

  it('no runnable or instructing surface reads an undeclared ACE_WEB_* name', () => {
    const rendered = uses.map((u) => `${u.file}: ${u.variable}`).sort();
    expect(
      rendered,
      'Each of these reads a name /ace:setup never provisions, so it silently falls ' +
        'through to a hardcoded default. Either use a declared spelling, ' +
        'or add the new one to DECLARED_ENV_NAMES and the vault (ace#1969).',
    ).toEqual([]);
  });

  it('the ace-web host has exactly one spelling, and it is the declared one', () => {
    const declared = DECLARED_ENV_NAMES;
    for (const retired of ['ACE_WEB_BASE', 'ACE_WEB_URL']) {
      expect(declared.has(retired), `${retired} must stay retired`).toBe(false);
    }
    expect(declared.has('ACE_WEB_BASE_URL')).toBe(true);
  });

  it('would catch a fourth spelling', () => {
    expect(DECLARED_ENV_NAMES.has('ACE_WEB_HOST')).toBe(false);
    expect(shellEnvNames('curl "$ACE_WEB_HOST/api"').has('ACE_WEB_HOST')).toBe(true);
  });
});

/**
 * The hardcoded default is deliberately KEPT (see the PR): it is the same
 * production host the vault holds, so it can never contradict a provisioned
 * machine — it only covers the un-provisioned one. CI cannot read the vault, so
 * pin every hardcoded copy to ONE value instead: two minters that disagree are
 * the same "two places name one host" shape as the bug.
 */
describe('the ace-web fallback default', () => {
  it('is the same production host in every minter', () => {
    const literals = ['scripts/ace-web-pat-mint.ts', 'scripts/ace-web-bot-token-mint.ts'].flatMap((f) =>
      [...readFileSync(join(REPO_ROOT, f), 'utf8').matchAll(/ACE_WEB_BASE_URL \|\| '(https:\/\/[^']+)'/g)].map(
        (m) => m[1],
      ),
    );
    expect(literals.length, 'expected a hardcoded ace-web default in the minters').toBeGreaterThan(1);
    for (const literal of literals) expect(literal).toBe('https://labs.connect.dimagi.com/ace');
  });
});

describe('RETIRED_ENV_SPELLINGS', () => {
  it('every retired name points at a declared spelling', () => {
    const declared = DECLARED_ENV_NAMES;
    for (const [name, { replacement }] of Object.entries(RETIRED_ENV_SPELLINGS)) {
      expect(declared.has(name), `${name} is retired and must not be declared`).toBe(false);
      expect(declared.has(replacement), `${name} -> ${replacement} must be declared`).toBe(true);
    }
  });

  it('a refusedBy file really refuses it — the pass is an obligation, not a hole', () => {
    for (const [name, { replacement, refusedBy }] of Object.entries(RETIRED_ENV_SPELLINGS)) {
      if (!refusedBy) continue;
      const src = readFileSync(join(REPO_ROOT, refusedBy), 'utf8');
      const { envReads } = analyzeScriptSource(refusedBy, src);
      expect(
        envReads.some((r) => r.variable === name),
        `${refusedBy} is the declared refusal site for ${name} but never reads it`,
      ).toBe(true);
      // Reading it is not enough — it has to REFUSE, and say what to use instead.
      expect(src, `${refusedBy} must name ${replacement} in its refusal`).toContain(replacement);
      expect(src, `${refusedBy} must exit rather than continue on ${name}`).toMatch(
        /process\.exit\(\d+\)/,
      );
    }
  });
});
