/**
 * ace#1448 — a fix can land in the backend and the client and NOT in the MCP
 * tool registration, in which case no caller can reach it.
 *
 * #1022 taught `listOpportunities` to take `hydrate` and to refuse `program_id`
 * loudly. Both landed in `mcp/connect/client.ts` and
 * `mcp/connect/backends/playwright.ts`; neither reached
 * `server.tool('connect_list_opportunities', …)`. So `hydrate` was unreachable
 * — the Zod object had no such key, so the argument never arrived — and every
 * call silently got unhydrated rows.
 *
 * Downstream, `connect-program-setup § Step 4a` says `hydrate` is REQUIRED for
 * the ace#588 budget-headroom check and `connect-opp-setup § Step 4` calls it
 * "not optional" for the single-active-opp WARN. Neither was reachable, so the
 * headroom check silently no-opped again — the exact failure #1022 was filed to
 * prevent — and resurfaced later as an un-actionable "Budget exceeds the
 * program budget" rejection at create time.
 *
 * The drift is mechanically detectable, which is what this file is.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');
const server = readFileSync(join(REPO, 'mcp/connect-server.ts'), 'utf8');
const client = readFileSync(join(REPO, 'mcp/connect/client.ts'), 'utf8');

/** The Zod keys registered for a tool. */
function registeredKeys(tool: string): string[] {
  const at = server.indexOf(`server.tool('${tool}'`);
  if (at < 0) return [];
  // The registration's shape object ends at the handler.
  const seg = server.slice(at, server.indexOf('async (args)', at));
  return [...new Set([...seg.matchAll(/^\s{4}([a-z_][a-z0-9_]*):\s*z\./gm)].map((m) => m[1]))];
}

/** The arg keys the CLIENT interface declares for a method. */
function clientKeys(method: string): string[] {
  const at = client.indexOf(`${method}(args: {`);
  if (at < 0) return [];
  const seg = client.slice(at, client.indexOf('}', client.indexOf('Promise<', at)) + 1);
  const body = seg.slice(seg.indexOf('{') + 1, seg.indexOf('})'));
  return [...new Set([...body.matchAll(/^\s*([a-z_][a-z0-9_]*)\??:/gm)].map((m) => m[1]))];
}

describe('connect_list_opportunities registration matches its client contract', () => {
  const reg = registeredKeys('connect_list_opportunities');

  it('the extractor found the registration', () => {
    expect(reg).toContain('organization_slug');
  });

  it('exposes hydrate — unreachable before ace#1448', () => {
    expect(reg).toContain('hydrate');
  });

  it('every client-declared argument is reachable through the tool', () => {
    const declared = clientKeys('listOpportunities');
    expect(declared.length, 'client interface extractor drifted').toBeGreaterThan(0);
    const missing = declared.filter((k) => !reg.includes(k));
    expect(
      missing,
      `these arguments exist on the client/backend but no caller can pass them: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('still advertises program_id, so the backend’s loud refusal can explain itself', () => {
    // Dropping it would trade a documented refusal for a bare schema
    // rejection with no reason — one silent failure for another.
    expect(reg).toContain('program_id');
  });

  it('and says in the schema that it is refused', () => {
    const at = server.indexOf("server.tool('connect_list_opportunities'");
    const seg = server.slice(at, server.indexOf('async (args)', at));
    expect(seg).toMatch(/REFUSED/i);
    expect(seg).toMatch(/ace#1022/);
  });
});

describe('getOpportunity reports only fields the live form carries (ace#1448)', () => {
  const pw = readFileSync(join(REPO, 'mcp/connect/backends/playwright.ts'), 'utf8');

  it('parses is_test, which the edit form does carry', () => {
    // ace#1461 wrapped this in the viewer-tier degrade
    // (`editDenied ? dash.is_test : v['is_test'] === 'on' || ...`), so the
    // old exact-literal match no longer holds. The INTENT is unchanged and is
    // what's asserted: the edit form remains the source for is_test whenever
    // we can read it. The behavioural counterpart — that the form still wins
    // at member tier — is pinned in playwright-fallbacks.test.ts.
    expect(pw).toMatch(/is_test:[^\n]*v\['is_test'\]/);
  });

  it('does NOT fabricate total_budget or start_date', () => {
    // Measured live 2026-08-15: neither is on the opportunity edit form nor on
    // the program init/edit form. Returning them would be inventing data.
    const at = pw.indexOf("getOpportunity: ConnectClient['getOpportunity']");
    const body = pw.slice(at, pw.indexOf('};', at));
    expect(body).not.toMatch(/total_budget:/);
    expect(body).not.toMatch(/start_date:/);
  });

  it('records the measured field list so nobody re-probes it', () => {
    expect(pw).toMatch(/verified LIVE against the real edit form/i);
    expect(pw).toMatch(/enable_credentials/);
  });
});
