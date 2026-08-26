import { describe, it, expect } from 'vitest';
import {
  classifyGenerationFailure,
  extractTracePointer,
  pickGenerationProviderId,
  remediationFor,
} from '../../lib/ocs-generation-probe.js';

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1516 — the pure half of the `ocs_generation` doctor probe.
//
// Every string in this file is VERBATIM from the incident record or from the
// repo, never a paraphrase: a classifier calibrated against invented error text
// is exactly the "predicted external behaviour with no reproducer" class
// CLAUDE.md bans.
// ---------------------------------------------------------------------------

/** Verbatim, bednet-check-2-visit/20260817-1720, observed 2026-08-19. */
const CAPPED = `sendTestMessage: OCS generation error — Error code: 400 - {'type': 'error', 'error': {'type': 'invalid_request_error', 'message': 'You have reached your specified API usage limits. You will regain access on 2026-09-01 at 00:00 UTC.'}, 'request_id': 'req_011CeBWxogVBT6phfC5QR3C5'}`;

describe('classifyGenerationFailure', () => {
  it('classifies the 2026-08-19 usage-cap message as provider_capped', () => {
    const out = classifyGenerationFailure(CAPPED);
    expect(out.class).toBe('provider_capped');
    expect(out.summary).toMatch(/cap/i);
  });

  it('classifies a revoked provider key as provider_auth (ace#743)', () => {
    const out = classifyGenerationFailure('401 invalid x-api-key');
    expect(out.class).toBe('provider_auth');
  });

  it('classifies a missing widget channel as no_channel', () => {
    // Verbatim from mcp/ocs/backends/playwright.ts getChatbotEmbedInfo.
    const msg =
      'No EMBEDDED_WIDGET channel found on chatbot home page for experiment 11792. ' +
      'Clone may have skipped the channel-creation step; run cloneChatbot instead.';
    expect(classifyGenerationFailure(msg).class).toBe('no_channel');
  });

  it('classifies the rest.ts poll deadline as timeout', () => {
    // Verbatim from mcp/ocs/backends/rest.ts sendTestMessage.
    expect(
      classifyGenerationFailure('sendTestMessage: timed out after 120s waiting for response').class,
    ).toBe('timeout');
  });

  it('classifies the probe’s own wall-clock cap as timeout, not unknown', () => {
    expect(
      classifyGenerationFailure('sendTestMessage: timed out after 25s (probe wall-clock cap)').class,
    ).toBe('timeout');
  });

  it('falls back to unknown when OCS reports a generation error with no inner cause', () => {
    // This is what OCS surfaces when debug_mode is off: its generic fallback,
    // which is precisely why the trace pointer exists.
    const msg =
      'sendTestMessage: OCS generation error — Sorry, an intermittent error related to load occurred.';
    expect(classifyGenerationFailure(msg).class).toBe('unknown');
  });

  it('classifies transport failures separately from provider failures', () => {
    expect(classifyGenerationFailure('fetch failed: ECONNREFUSED 127.0.0.1:443').class).toBe(
      'transport',
    );
  });

  it('never throws on empty input', () => {
    expect(classifyGenerationFailure('').class).toBe('unknown');
  });
});

describe('extractTracePointer', () => {
  /**
   * Literal copy of the suffix RestBackend.describeSessionTrace builds
   * (mcp/ocs/backends/rest.ts). If that template changes, this test is the
   * thing that notices.
   */
  const SUFFIX =
    ' [session 7b6c1f22-1f9a-4a9e-9d3a-8f2b21a2f001; underlying trace: https://chatbots.dimagi.com/a/connect-ace/traces/862138/ — OCS masks the real provider error' +
    ' behind this generic fallback unless debug_mode is on. Open the trace (team login)' +
    ' before diagnosing a platform outage; known class: revoked team LLM provider key' +
    ' (jjackson/ace#743).]';

  it('recovers the trace URL from the enrichment suffix', () => {
    expect(extractTracePointer(CAPPED + SUFFIX)).toBe(
      'https://chatbots.dimagi.com/a/connect-ace/traces/862138/',
    );
  });

  it('returns null when enrichment failed (describeSessionTrace returns "")', () => {
    expect(extractTracePointer(CAPPED)).toBeNull();
  });
});

describe('remediationFor', () => {
  it('names the discovered generation provider’s page, not the embeddings one', () => {
    const out = remediationFor('provider_capped', {
      baseUrl: 'https://chatbots.dimagi.com',
      teamSlug: 'connect-ace',
      providerId: 377,
      trace: 'https://chatbots.dimagi.com/a/connect-ace/traces/862138/',
    });
    expect(out).toContain('https://chatbots.dimagi.com/a/connect-ace/service_providers/llm/377/');
    expect(out).not.toContain('/378/');
    expect(out).toMatch(/1Password/);
    expect(out).toMatch(/Agent-Ace/);
    expect(out).toContain('862138');
  });

  it('names the 1Password item for a revoked key too', () => {
    const out = remediationFor('provider_auth', {
      baseUrl: 'https://chatbots.dimagi.com',
      teamSlug: 'connect-ace',
      providerId: 377,
    });
    expect(out).toContain('service_providers/llm/377/');
    expect(out).toMatch(/Agent-Ace/);
  });

  it('degrades to a placeholder path rather than a wrong one when the id is unknown', () => {
    const out = remediationFor('provider_capped', {
      baseUrl: 'https://chatbots.dimagi.com',
      teamSlug: 'connect-ace',
      providerId: null,
    });
    expect(out).toContain('<pk>');
  });

  it('points a dead session at /ace:ocs-login', () => {
    expect(remediationFor('no_session')).toMatch(/ace:ocs-login/);
  });

  it('returns nothing to remediate on ok', () => {
    expect(remediationFor('ok')).toBe('');
  });
});

describe('pickGenerationProviderId — the env var is never the answer', () => {
  /**
   * THE assertion of this file. On connect-ace, `OCS_LLM_PROVIDER_ID=378` is
   * "OpenAI for Embeddings"; generation is 377 ("Antropic", claude-sonnet-4-6).
   * In the 2026-08-19 incident 378 was perfectly healthy — 8/8 collection files
   * indexed — while 377 was capped. A probe that trusted env would have named
   * the wrong /service_providers/llm/ page in its remedy, or reported green.
   */
  it('returns the pipeline node’s 377, not the env var’s 378', () => {
    const priorEnv = process.env.OCS_LLM_PROVIDER_ID;
    process.env.OCS_LLM_PROVIDER_ID = '378';
    try {
      const inspect = {
        id: 'abc',
        pipeline: {
          id: 42,
          nodes: [
            { node_id: 'start', type: 'StaticRouterNode', label: 'Router', params: {}, llm: null },
            {
              node_id: 'llm-1',
              type: 'LLMResponseWithPrompt',
              label: 'Answer',
              params: {},
              llm: { provider_id: 377, model: 'claude-sonnet-4-6' },
            },
          ],
        },
      };
      expect(pickGenerationProviderId(inspect)).toBe(377);
      expect(pickGenerationProviderId(inspect)).not.toBe(378);
    } finally {
      if (priorEnv === undefined) delete process.env.OCS_LLM_PROVIDER_ID;
      else process.env.OCS_LLM_PROVIDER_ID = priorEnv;
    }
  });

  it('skips non-LLM nodes even when they carry an llm block', () => {
    const inspect = {
      pipeline: {
        nodes: [
          { node_id: 'a', type: 'StaticRouterNode', llm: { provider_id: 999 } },
          { node_id: 'b', type: 'LLMResponseWithPrompt', llm: { provider_id: 377 } },
        ],
      },
    };
    expect(pickGenerationProviderId(inspect)).toBe(377);
  });

  it('coerces a stringified provider id', () => {
    const inspect = { pipeline: { nodes: [{ type: 'LLMResponseWithPrompt', llm: { provider_id: '377' } }] } };
    expect(pickGenerationProviderId(inspect)).toBe(377);
  });

  it('returns null on a shape with no LLM node, and never throws', () => {
    expect(pickGenerationProviderId({ pipeline: { nodes: [] } })).toBeNull();
    expect(pickGenerationProviderId({ pipeline: null })).toBeNull();
    expect(pickGenerationProviderId(null)).toBeNull();
    expect(pickGenerationProviderId(undefined)).toBeNull();
    expect(pickGenerationProviderId({ pipeline: { nodes: 'not-an-array' } })).toBeNull();
  });
});
