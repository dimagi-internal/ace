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

  it('parses is_test from the edit form, via the shared checkbox predicate', () => {
    // ace#1461 wrapped this in the viewer-tier degrade; ace#1491 then replaced
    // the inline predicate with `isCheckboxChecked`, because reading the
    // extracted VALUE map alone can never answer this — Django emits a boolean
    // checkbox with no `value` attribute, so checked and unchecked both
    // extract to ''. The old assertion here matched the SOURCE TEXT of the
    // expression and passed for months while the expression was wrong; that is
    // the whole reason it is not a source-text assertion any more.
    //
    // Behaviour is pinned against the live-captured edit form in
    // test/mcp/connect/unit/checkbox-readback.test.ts. What this drift test
    // still owns is narrower and genuinely textual: the edit form must remain
    // the SOURCE for is_test whenever we can read it.
    expect(pw).toMatch(/is_test:\s*editDenied \?[^\n]*isCheckboxChecked/);
  });

  it('sources total_budget / start_date from the DASHBOARD, never from the edit form (ace#1550)', () => {
    // Measured live 2026-08-15: neither is on the opportunity edit form nor on
    // the program init/edit form, so reading either out of the form's value
    // map would be inventing data. They ARE on the opportunity dashboard,
    // which this method already fetches for the app-wire ids — and until they
    // were surfaced from there, connect-program-setup § Step 4a's
    // Σ(total_budget) headroom sum had no obtainable inputs on any run.
    // Slice the RETURNED OBJECT, not `indexOf('};')` from the method head —
    // any `: {};` ternary earlier in the body (there is one) ends that slice
    // before the return is reached, which reads as "the field is absent".
    const at = pw.indexOf("getOpportunity: ConnectClient['getOpportunity']");
    const retAt = pw.indexOf('return {', at);
    const body = pw.slice(retAt, pw.indexOf('\n    };', retAt));
    expect(body).not.toMatch(/total_budget:\s*v\[/);
    expect(body).not.toMatch(/start_date:\s*v\[/);
    expect(body).toMatch(/total_budget:[\s\S]{0,200}?detail\.total_budget/);
    expect(body).toMatch(/start_date:\s*detail\.start_date/);
    expect(body).toMatch(/program_name:\s*detail\.program_name/);
  });

  it('records the measured field list so nobody re-probes it', () => {
    expect(pw).toMatch(/verified LIVE against the real edit form/i);
    expect(pw).toMatch(/enable_credentials/);
  });
});
