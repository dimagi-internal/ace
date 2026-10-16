/**
 * Every `scripts/probe-*.ts` that reads a secret loads the plugin-data `.env`
 * through `loadPluginEnv(import.meta.url)` (ace#2141).
 *
 * A probe is run from a Bash tool call, which inherits none of ACE's secrets —
 * `.env` is loaded into MCP subprocesses only (CLAUDE.md § Gotchas). A probe
 * that reads `process.env.<SECRET>` without loading the file reports
 * "credentials missing" on a machine where they are provisioned, and because
 * it is a PROBE, that false negative reads as an authoritative "the service is
 * unavailable". `probe-content-generator.ts` did exactly that while its
 * sibling `run-content-generator.ts` already carried the fix (ace#1957).
 *
 * `import 'dotenv/config'` is NOT the fix: it reads `.env` from the CWD, which
 * from an installed plugin is not the plugin-data dir. The probes that still
 * rely on it (or on a hand-rolled reader) are a LEDGER below. It may only
 * shrink: a new secret-reading probe must use loadPluginEnv, and converting a
 * ledger entry fails this test until the entry is removed.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = 'scripts';
const SECRET_READ =
  /process\.env(?:\.|\[['"`])([A-Z0-9_]*(?:_KEY|_TOKEN|_PASSWORD|_SECRET))\b/;
const LOADS = /\bloadPluginEnv\(\s*import\.meta\.url\s*\)/;

// Known debt as of 2026-10-16 — dotenv/config (CWD .env) or a hand-rolled
// reader. Shrink-only.
const LEDGER = new Set([
  'probe-commcare-create-domain.ts',
  'probe-commcare-link-domains.ts',
  'probe-commcare-lookup-rows.ts',
  'probe-commcare-lookup-table.ts',
  'probe-composite-list.ts',
  'probe-connect-create-opp.ts',
  'probe-connect-login.ts',
  'probe-experiment-id-recovery.ts',
  'probe-fixed-create-opp.ts',
  'probe-hq-scoped-api-key.ts',
  'probe-list-chatbots-shape.ts',
  'probe-ocs-add-chatbot-event.ts',
  'probe-ocs-add-custom-action.ts',
  'probe-ocs-add-pipeline-node.ts',
  'probe-ocs-create-chatbot.ts',
  'probe-ocs-link-action-to-node.ts',
  'probe-ocs-peek-raw.ts',
  'probe-verification-form-field-rules.ts',
]);

function probes(): { name: string; text: string }[] {
  return readdirSync(SCRIPTS)
    .filter((n) => /^probe-.*\.ts$/.test(n))
    .map((name) => ({ name, text: readFileSync(join(SCRIPTS, name), 'utf8') }));
}

const secretReaders = () => probes().filter((p) => SECRET_READ.test(p.text));

describe('secret-reading probes load the plugin-data .env (ace#2141)', () => {
  it('the scan is not vacuous — it sees the probe this rule was written for', () => {
    const names = secretReaders().map((p) => p.name);
    expect(names).toContain('probe-content-generator.ts');
    expect(names.length).toBeGreaterThan(LEDGER.size);
  });

  it('the patterns match the real shapes (controls)', () => {
    expect('const KEY = process.env.CONTENT_GENERATOR_API_KEY!;').toMatch(SECRET_READ);
    expect("process.env['OCS_PASSWORD']").toMatch(SECRET_READ);
    expect('process.env.CONTENT_GENERATOR_URL').not.toMatch(SECRET_READ);
    expect('const __env = loadPluginEnv(import.meta.url);').toMatch(LOADS);
  });

  it('every secret-reading probe outside the ledger calls loadPluginEnv', () => {
    const bad = secretReaders()
      .filter((p) => !LEDGER.has(p.name) && !LOADS.test(p.text))
      .map((p) => `scripts/${p.name}`);
    expect(
      bad,
      'Load the env before the first secret read:\n' +
        "  import { loadPluginEnv } from '../lib/load-plugin-env.js';\n" +
        '  loadPluginEnv(import.meta.url);\n' +
        bad.join('\n'),
    ).toEqual([]);
  });

  it('the ledger only shrinks — a converted or deleted entry must be removed', () => {
    const byName = new Map(probes().map((p) => [p.name, p.text]));
    const stale = [...LEDGER].filter((n) => {
      const t = byName.get(n);
      return t === undefined || LOADS.test(t) || !SECRET_READ.test(t);
    });
    expect(stale, `Remove these from LEDGER:\n${stale.join('\n')}`).toEqual([]);
  });
});
