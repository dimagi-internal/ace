// No skill, agent, command, template, MCP server, playbook or CLAUDE.md line may
// name a Connect org slug as the org to ACT in. The orgs an ACE instance uses
// are configuration: `lib/connect-orgs.ts` resolves them (ACE_CONNECT_PM_ORG /
// ACE_CONNECT_NM_ORG, local-only `.env` keys) and `bin/ace-doctor --preflight`
// surfaces them as `connect_orgs:`; everything else says "the configured PM org
// (`connect_orgs.pm_org`)".
//
// Why a rail: the legacy PM org was a literal in a dozen skills, the orchestrator
// guidance, CLAUDE.md and the MCP parameter examples, so another instance of ACE
// could not use its own PM/NM orgs without editing every one of them — and a
// copy-edit that missed one would silently act in the wrong org, which for an
// opportunity is unrecoverable (`target_organization_slug` is create-time only).
// Operator request 2026-09-26 (Jon), raised while moving ACE to dedicated PM/NM
// orgs after spark-facilitator/20260925-1536.
//
// What is allowed, and why:
//   - The resolver's legacy default (so existing installs keep working).
//   - HISTORICAL citations: a line recording a past measurement or incident
//     names the org it was measured in. That is a record, not configuration —
//     each one is listed below with its reason, matched by a verbatim snippet.
//   - Rows of a `## Change Log` table (dated history by construction).
// A new occurrence fails until it is either rewritten to the configured org or
// added here with a reason. Test fixtures under test/ are out of scope.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { LEGACY_DEFAULT_PM_ORG } from '../../lib/connect-orgs.js';

const ROOT = join(__dirname, '..', '..');
const SLUG = LEGACY_DEFAULT_PM_ORG;

const SCAN_DIRS = ['skills', 'agents', 'commands', 'templates', 'mcp', 'playbook', 'lib'];
const SCAN_FILES = ['CLAUDE.md'];
const TEXT_EXT = /\.(md|ts|mts|js|mjs|yaml|yml|json|txt|sh)$/;

/** [file, verbatim snippet of the line, reason]. */
const ALLOWLIST: ReadonlyArray<readonly [string, string, string]> = [
  ['lib/connect-orgs.ts', "export const LEGACY_DEFAULT_PM_ORG = 'ai-demo-space';", 'the resolver default — the one live value'],
  ['skills/app-screenshot-capture/SKILL.md', '`"ai-demo-space - malaria-itn-fgd (run 20260515-1645)"`', 'historical: tile text observed on malaria-itn-fgd/20260515-1645'],
  ['skills/app-screenshot-capture/SKILL.md', 'measured live on `ai-demo-space`', 'historical: ace#1637 measurement 2026-09-06'],
  ['skills/idea-to-pdd-qa/checks.ts', 'Measured on `ai-demo-space` 2026-09-16', 'historical: delivery-type measurement'],
  ['skills/connect-program-setup/SKILL.md', 'measured on `ai-demo-space` 2026-09-01', 'historical: ace#1799 list-size measurement'],
  ['skills/connect-program-setup/SKILL.md', '`ai-demo-space` 2026-09-16, with nothing binding', 'historical: delivery-type/currency measurement'],
  ['skills/connect-program-setup/SKILL.md', 'hydrated org-wide array measured 81,175 chars on `ai-demo-space`', 'historical: ace#1799 measurement'],
  ['skills/connect-program-setup/SKILL.md', 'hydrated `ai-demo-space` rows** came back', 'historical: bednet-check-2-visit/20260825-1310 observation'],
  ['skills/connect-program-setup/SKILL.md', '11 of 11 such rows on `ai-demo-space`', 'historical: ace#1637 root-cause measurement'],
  ['skills/connect-opp-setup/SKILL.md', 'org `ai-demo-space`) **ten**', 'historical: bednet-check-2-visit/20260908-1544 observation'],
  ['skills/sweep-connect/SKILL.md', '`ai-demo-space` held 114 opportunities at ace#938 time', 'historical: ace#938 measurement'],
  ['templates/pdd-template.md', 'measured on `ai-demo-space` 2026-09-16', 'historical: delivery-type measurement'],
  ['mcp/connect-server.ts', 'measured on `ai-demo-space` 2026-09-01, 42 rows', 'historical: ace#1799 measurement'],
  ['mcp/connect-server.ts', 'program efb8af66 (`ai-demo-space`): 21,012 chars', 'historical: ace#2291 measurement'],
  ['mcp/connect-server.ts', '(measured `ai-demo-space` 2026-09-01: 71 rows', 'historical: ace#1799 measurement'],
  ['mcp/connect/backends/html-scrape.ts', 'Confirmed live on three `ai-demo-space` programs', 'historical: ace#1140 observation'],
  ['mcp/connect/backends/html-scrape.ts', "opp `cb24ac17-…` (domain `ai-demo-space`)", 'historical: fixture provenance'],
  ['mcp/connect/backends/html-scrape.ts', "opp `1a30f061-…` (domain `ai-demo-space`)", 'historical: fixture provenance'],
  ['mcp/connect/backends/html-scrape.ts', '16 of 81 hydrated `ai-demo-space` rows', 'historical: bednet-check-2-visit/20260825-1310 observation'],
  ['mcp/connect/backends/html-scrape.ts', 'Measured on `ai-demo-space` the same day', 'historical: ace#1637 measurement'],
  ['mcp/connect/backends/playwright.ts', 'an org like `ai-demo-space` (114 opportunities', 'historical: ace#938 measurement'],
  ['mcp/connect/backends/playwright.ts', '16 of 81 hydrated ai-demo-space rows', 'historical: bednet-check-2-visit/20260825-1310 observation'],
  ['mcp/connect/backends/playwright.ts', '2026-08-15 (ai-demo-space / 34703fdb-…)', 'historical: observed dashboard sample'],
  ['playbook/integrations/connect-api.md', 'Measured on `ai-demo-space` 2026-09-06', 'historical: ace#1637 measurement'],
  ['playbook/integrations/connect-api.md', 'On `ai-demo-space` that is 11 rows', 'historical: ace#1637 measurement'],
  ['lib/connect-list-projection.ts', 'Measured on `ai-demo-space`', 'historical: ace#1799 measurement'],
  ['lib/connect-list-projection.ts', '`ai-demo-space` 2026-09-06, each costing', 'historical: ace#1637 measurement'],
  ['lib/program-locale.ts', 'Measured live on `ai-demo-space`', 'historical: currency/country measurement'],
];

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (TEXT_EXT.test(name) && !/\.test\.(ts|mts|js)$/.test(name)) out.push(abs);
  }
}

function files(): string[] {
  const out: string[] = [];
  for (const d of SCAN_DIRS) walk(join(ROOT, d), out);
  for (const f of SCAN_FILES) out.push(join(ROOT, f));
  return out.map((abs) => relative(ROOT, abs));
}

/** A dated row of a table under a `Change Log` / `Changelog` heading. */
function isChangeLogRow(lines: string[], i: number): boolean {
  if (!/^\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(lines[i])) return false;
  for (let j = i - 1; j >= 0; j--) {
    const h = /^#{1,6}\s+(.*)$/.exec(lines[j]);
    if (h) return /change\s*-?\s*log/i.test(h[1]);
  }
  return false;
}

describe('no hardcoded Connect org slug outside lib/connect-orgs.ts', () => {
  it('every occurrence is the resolver default, an allowlisted historical citation, or a Change Log row', () => {
    const offenders: string[] = [];
    const used = new Set<number>();
    for (const rel of files()) {
      const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!line.includes(SLUG)) return;
        if (isChangeLogRow(lines, i)) return;
        const hit = ALLOWLIST.findIndex(([f, snippet]) => f === rel && line.includes(snippet));
        if (hit >= 0) {
          used.add(hit);
          return;
        }
        offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
    expect(
      offenders,
      `Hardcoded Connect org slug. Refer to "the configured PM org (\`connect_orgs.pm_org\` from preflight)" instead, ` +
        `or — if the line records a PAST observation — add it to ALLOWLIST with a reason:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);

    // Stale allowlist entries are removed, so the list cannot become a blanket pass.
    const stale = ALLOWLIST.filter((_, k) => !used.has(k)).map(([f, s]) => `${f}: ${s}`);
    expect(stale, `ALLOWLIST entries that no longer match any line — delete them:\n  ${stale.join('\n  ')}`).toEqual([]);
  });

  it('every allowlist entry carries a reason', () => {
    for (const [f, s, reason] of ALLOWLIST) {
      expect(reason.trim().length, `${f}: ${s}`).toBeGreaterThan(8);
      expect(s.includes(SLUG), `${f}: snippet must contain the slug`).toBe(true);
    }
  });

  it('the rail can see a new literal (control)', () => {
    const lines = ['## Process', `- organization_slug: \`${SLUG}\``];
    expect(lines[1].includes(SLUG) && !isChangeLogRow(lines, 1)).toBe(true);
    const log = ['## Change Log', '| Date | Change |', `| 2026-01-01 | measured on ${SLUG} |`];
    expect(isChangeLogRow(log, 2)).toBe(true);
  });
});
