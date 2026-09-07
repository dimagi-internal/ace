/**
 * ace#174 — `nova_scopes`: does the configured NOVA_API_KEY carry the scopes
 * Phase 3 needs, or only enough to be accepted at the transport?
 *
 * Every response fixture below is a real frame, captured 2026-09-06 against
 * https://mcp.commcare.app/mcp with the live ACE key (and, for the refusals,
 * with a deliberately bad bearer / a nonexistent tool name). The one shape ACE
 * cannot mint on demand — `scope_missing` — is quoted from the two places it
 * was recorded live: `turmeric/20260508-1951`'s Phase 3 halt and
 * `bednet-check-2-visit/20260823-2210` session A, both transcribed on the
 * issue. Per CLAUDE.md § "close the loop to the source of truth", these are
 * observations, not predictions — including the SSE framing, which is not
 * guessable from the request being plain JSON.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyNovaScopeProbe,
  NOVA_SCOPES_SCOPE_LINE,
} from '../../lib/nova-scope-probe.js';

/** Captured verbatim (domain list trimmed to three of the nine). */
const LIVE_OK =
  'event: message\n' +
  'data: {"result":{"content":[{"type":"text","text":"{\\"configured\\":true,\\"server\\":\\"production\\",' +
  '\\"server_url\\":\\"https://www.commcarehq.org\\",\\"available_domains\\":[{\\"name\\":\\"ace-crispr-connect\\",' +
  '\\"displayName\\":\\"ACE CRISPR-Connect\\"},{\\"name\\":\\"connect-ace-prod\\",\\"displayName\\":\\"connect-ace-prod\\"},' +
  '{\\"name\\":\\"auto-connect-master\\",\\"displayName\\":\\"auto-connect-master\\"}]}"}]},"jsonrpc":"2.0","id":1}\n';

/** Captured with `Authorization: Bearer not-a-real-key` — HTTP 401, NOT SSE. */
const LIVE_401 = '{"jsonrpc":"2.0","error":{"code":-32000,"message":"no token payload"},"id":null}';

/** Captured with a nonexistent tool name — a JSON-RPC error inside an SSE frame. */
const LIVE_UNKNOWN_TOOL =
  'event: message\n' +
  'data: {"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Tool no_such_tool_xyz not found"}}\n';

/** The recorded refusal shape (ace#174). */
const SCOPE_MISSING =
  'event: message\n' +
  'data: {"result":{"content":[{"type":"text","text":"{\\"error_type\\":\\"scope_missing\\",' +
  '\\"required_scope\\":\\"nova.hq.read\\"}"}]},"jsonrpc":"2.0","id":1}\n';

const NO_HQ_KEY =
  'event: message\n' +
  'data: {"result":{"content":[{"type":"text","text":"{\\"configured\\":false}"}]},"jsonrpc":"2.0","id":1}\n';

const ok = (over: Partial<Parameters<typeof classifyNovaScopeProbe>[0]> = {}) =>
  classifyNovaScopeProbe({ keyConfigured: true, httpStatus: 200, body: LIVE_OK, ...over });

describe('classifyNovaScopeProbe (ace#174)', () => {
  it('PASSES on the live get_hq_connection frame, and names the bound domains', () => {
    const v = ok();
    expect(v.status).toBe('pass');
    expect(v.reason).toBe('hq-read-granted');
    expect(v.configured).toBe(true);
    expect(v.domains).toContain('connect-ace-prod');
    expect(v.domains).toHaveLength(3);
    expect(v.remediation).toBe('');
  });

  it('FAILS on scope_missing and names BOTH scopes Phase 3 needs', () => {
    // The whole point of the issue: this is the state that used to reach
    // app-deploy with nova_auth green.
    const v = ok({ body: SCOPE_MISSING });
    expect(v.status).toBe('fail');
    expect(v.reason).toBe('scope-missing');
    expect(v.requiredScope).toBe('nova.hq.read');
    expect(v.remediation).toMatch(/HQ Read AND HQ Write/);
    expect(v.remediation).toMatch(/commcare\.app\/settings/);
    expect(v.remediation).toMatch(/upload_app_to_hq/);
  });

  it('reads scope_missing out of a JSON-RPC error envelope too', () => {
    // ACE has only ever recorded the STRING, never the envelope it arrived in,
    // so the classifier must not depend on one shape. Same fact, other door.
    const v = ok({
      httpStatus: 200,
      body:
        'event: message\ndata: {"jsonrpc":"2.0","id":1,"error":{"code":-32000,' +
        '"message":"error_type=scope_missing required_scope=nova.hq.write"}}\n',
    });
    expect(v.status).toBe('fail');
    expect(v.requiredScope).toBe('nova.hq.write');
  });

  it('WARNS when HQ Read is granted but no HQ key is bound in Nova', () => {
    const v = ok({ body: NO_HQ_KEY });
    expect(v.status).toBe('warn');
    expect(v.reason).toBe('no-hq-key-bound');
    expect(v.configured).toBe(false);
    expect(v.remediation).toMatch(/paste a CommCare HQ API key/);
  });

  it('WARNS when ACE_HQ_DOMAIN is not among the domains Nova can see', () => {
    // Doctor's charter is setup health, and "Nova cannot see the project space
    // ACE is configured to upload to" is exactly that — it fails late, inside
    // app-deploy, exactly like the scope case.
    const v = ok({ expectedDomain: 'not-a-real-domain' });
    expect(v.status).toBe('warn');
    expect(v.summary).toMatch(/NOT among them/);
    expect(v.remediation).toMatch(/ace-crispr-connect, connect-ace-prod/);
  });

  it('PASSES and says so when ACE_HQ_DOMAIN IS among them', () => {
    const v = ok({ expectedDomain: 'connect-ace-prod' });
    expect(v.status).toBe('pass');
    expect(v.summary).toMatch(/incl\. connect-ace-prod/);
  });

  it('FAILS on the live 401 body, which is plain JSON and not an SSE frame', () => {
    // A classifier that only parsed `data:` lines would call this
    // `unexpected-response` and bury an invalid key under a vague WARN.
    const v = classifyNovaScopeProbe({ keyConfigured: true, httpStatus: 401, body: LIVE_401 });
    expect(v.status).toBe('fail');
    expect(v.reason).toBe('auth-failed');
    expect(v.remediation).toMatch(/rotate at https:\/\/commcare\.app\/settings/);
  });

  it('WARNS — never passes — on an unexpected 200', () => {
    const v = ok({ body: LIVE_UNKNOWN_TOOL });
    expect(v.status).toBe('warn');
    expect(v.reason).toBe('unexpected-response');
    expect(v.summary).toMatch(/no_such_tool_xyz not found/);
  });

  it('WARNS when the request never completed', () => {
    const v = classifyNovaScopeProbe({ keyConfigured: true, httpStatus: null, body: '' });
    expect(v.status).toBe('warn');
    expect(v.reason).toBe('unreachable');
  });

  it('SKIPS silently when no key is configured — same as nova_auth', () => {
    const v = classifyNovaScopeProbe({ keyConfigured: false, httpStatus: null, body: '' });
    expect(v.status).toBe('skip');
    expect(v.reason).toBe('no-key-configured');
    expect(v.remediation).toMatch(/1Password item "ACE - Nova"/);
  });

  it('carries the scope caveat on EVERY verdict, pass included', () => {
    // ace#174 comment 3 measured the trap: this exact curl returned
    // `configured:true` while the in-session Nova connection was unusable, so
    // a bare green here must never be read as "Nova works this session".
    for (const v of [
      ok(),
      ok({ body: SCOPE_MISSING }),
      ok({ body: NO_HQ_KEY }),
      classifyNovaScopeProbe({ keyConfigured: false, httpStatus: null, body: '' }),
      classifyNovaScopeProbe({ keyConfigured: true, httpStatus: null, body: '' }),
    ]) {
      expect(v.scope).toBe(NOVA_SCOPES_SCOPE_LINE);
      expect(v.scope).toMatch(/nova_header_readiness/);
    }
  });

  it('never echoes a bearer token, whatever comes back', () => {
    const v = classifyNovaScopeProbe({
      keyConfigured: true,
      httpStatus: 401,
      body: '{"error":{"message":"bad token sk-live-SUPERSECRET"}}',
    });
    expect(`${v.summary} ${v.remediation}`).not.toMatch(/SUPERSECRET/);
  });
});
