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
  discoverBashReachableScripts,
  EXTRA_GUARDED_VARS,
  guardedVars,
  parseEnvTemplateKeys,
} from '../../lib/bash-reachable-scripts.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('parseEnvTemplateKeys', () => {
  it('takes the KEY= names and ignores comments, blanks and indented text', () => {
    const keys = parseEnvTemplateKeys(
      ['# a comment', '', 'ACE_HQ_USERNAME=op://x', '  INDENTED=1', 'OCS_TEAM_SLUG=y', 'lower=z'].join(
        '\n',
      ),
    );
    expect(keys).toEqual(['ACE_HQ_USERNAME', 'OCS_TEAM_SLUG']);
  });

  it('reads the real .env.tpl and finds the keys ACE actually declares', () => {
    const keys = parseEnvTemplateKeys(readFileSync(join(REPO_ROOT, '.env.tpl'), 'utf8'));
    expect(keys).toContain('ACE_HQ_USERNAME');
    expect(keys).toContain('NOVA_API_KEY');
    expect(keys).toContain('OCS_TEAM_SLUG');
  });
});

describe('guardedVars', () => {
  it('unions the template keys with the documented extras', () => {
    const g = guardedVars('ACE_HQ_USERNAME=1\n');
    expect(g.has('ACE_HQ_USERNAME')).toBe(true);
    for (const extra of Object.keys(EXTRA_GUARDED_VARS)) expect(g.has(extra)).toBe(true);
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
