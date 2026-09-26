/**
 * setVerificationFlags must NOT follow the PM-only redirect (ace#2419).
 *
 * Upstream `verification_flags_config` 302s to `opportunity:detail` unless
 * `request.is_opportunity_pm` — true only when the requesting org manages the
 * program AND is not the opportunity's holding org. Following the redirect
 * parsed the detail page and blamed the payload; with empty flags it POSTed
 * into the redirect and returned `{ok:true}` having written nothing.
 *
 * Observed: spark-facilitator/20260925-1536 (self-managed opp, rules never
 * applied). Reproduced live 2026-09-26 on the NM-held probe opportunity
 * 7bfcb845-015c-416a-a200-9795c68dfc55: at the NM-org URL `flags: {}` returned
 * `{ok:true}` and a real rule was refused as "no input for form_field_rules";
 * at the PM-org URL the same rule saved (`form_field_rules_saved: 1`).
 */
import { describe, it, expect } from 'vitest';
import type { APIRequestContext, APIResponse } from 'playwright';
import { PlaywrightBackend } from '../../../../mcp/connect/backends/playwright.js';
import { VerificationPagePmOnlyError } from '../../../../mcp/connect/errors.js';

interface Call { method: 'GET' | 'POST'; url: string; opts?: { maxRedirects?: number } }

function ctx(responses: Array<{ status: number; body?: string; location?: string }>, calls: Call[]): APIRequestContext {
  let i = 0;
  const respond = (r: { status: number; body?: string; location?: string }): APIResponse =>
    ({
      status: () => r.status,
      headers: () => ({ 'content-type': 'text/html', ...(r.location ? { location: r.location } : {}) }),
      text: async () => r.body ?? '',
    }) as unknown as APIResponse;
  return {
    get: async (url: string, opts?: { maxRedirects?: number }) => {
      calls.push({ method: 'GET', url, opts });
      return respond(responses[i++]);
    },
    post: async (url: string) => {
      calls.push({ method: 'POST', url });
      return respond(responses[i++]);
    },
  } as unknown as APIRequestContext;
}

const OPP = '7bfcb845-015c-416a-a200-9795c68dfc55';

describe('setVerificationFlags — PM-only page (ace#2419)', () => {
  it('throws VerificationPagePmOnlyError on the redirect and never POSTs (empty flags included)', async () => {
    const calls: Call[] = [];
    const backend = new PlaywrightBackend({
      baseUrl: 'https://connect.example',
      csrfToken: 'c',
      request: ctx([{ status: 302, location: `/a/nm-org/opportunity/${OPP}/` }], calls),
    });
    const err = await backend
      .setVerificationFlags({ organization_slug: 'nm-org', opportunity_id: OPP, flags: {} })
      .catch((e) => e);
    expect(err).toBeInstanceOf(VerificationPagePmOnlyError);
    expect(err.toJSON()).toMatchObject({ error: 'verification_page_pm_only', organization_slug: 'nm-org' });
    expect(err.message).toMatch(/PROGRAM-MANAGER org/);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    // The GET must not follow redirects — following them is the bug.
    expect(calls[0].opts?.maxRedirects).toBe(0);
  });
});
