/**
 * The last two items of the 2026-07-31 audit that were still open:
 *   - ace#1112 `ocs_delete_pipeline` — no protected id in config, so unlike the
 *     chatbot/collection guards it has to RESOLVE the golden pipeline.
 *   - ace#1110 `ocs_add_custom_action` `server_url` — configures a PRODUCTION
 *     chatbot to call a host as an LLM-invocable tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  assertNotGoldenTemplatePipeline,
  __resetGoldenPipelineCacheForTests,
  DestructiveGuardError,
} from '../../lib/destructive-guards';
import {
  assertAllowedActionHost,
  ALLOWED_ACTION_HOST_SUFFIXES,
  PathContainmentError,
} from '../../lib/contained-path';

const env = { OCS_GOLDEN_TEMPLATE_ID: '42' } as NodeJS.ProcessEnv;
const resolver = (pipelineId: number) => ({
  getChatbotPipelineId: vi.fn().mockResolvedValue({ pipeline_id: pipelineId }),
});

beforeEach(() => __resetGoldenPipelineCacheForTests());

describe('ocs_delete_pipeline — the golden template’s pipeline (ace#1112)', () => {
  it('refuses to delete it', async () => {
    await expect(assertNotGoldenTemplatePipeline(777, resolver(777), env))
      .rejects.toThrow(DestructiveGuardError);
  });

  it('explains why a safe-to-sweep pipeline can never match', async () => {
    // Per-opp clones get their own pipeline via create_new_version(is_copy=True).
    await expect(assertNotGoldenTemplatePipeline(777, resolver(777), env))
      .rejects.toThrow(/create_new_version\(is_copy=True\)/);
  });

  it('allows any other pipeline', async () => {
    await expect(assertNotGoldenTemplatePipeline(999, resolver(777), env)).resolves.toBeUndefined();
  });

  it('resolves the golden pipeline once per session, not per delete', async () => {
    const r = resolver(777);
    await assertNotGoldenTemplatePipeline(1, r, env);
    await assertNotGoldenTemplatePipeline(2, r, env);
    await assertNotGoldenTemplatePipeline(3, r, env);
    expect(r.getChatbotPipelineId).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no golden template is configured', async () => {
    const r = resolver(777);
    await expect(assertNotGoldenTemplatePipeline(777, r, {} as NodeJS.ProcessEnv)).resolves.toBeUndefined();
    expect(r.getChatbotPipelineId).not.toHaveBeenCalled();
  });

  it('FAILS OPEN when resolution errors — a sweep must not stall on a flaky OCS', async () => {
    // The ace#1026 lesson: a guard that blocks every delete because OCS was
    // briefly unreachable trains operators to route around it. A pipeline
    // delete is recoverable (is_archived=True); a collection purge is not.
    const broken = { getChatbotPipelineId: vi.fn().mockRejectedValue(new Error('502')) };
    await expect(assertNotGoldenTemplatePipeline(777, broken, env)).resolves.toBeUndefined();
  });

  it('does not re-probe after a failed resolution either', async () => {
    const broken = { getChatbotPipelineId: vi.fn().mockRejectedValue(new Error('502')) };
    await assertNotGoldenTemplatePipeline(1, broken, env);
    await assertNotGoldenTemplatePipeline(2, broken, env);
    expect(broken.getChatbotPipelineId).toHaveBeenCalledTimes(1);
  });
});

describe('ocs_add_custom_action — host allowlist (ace#1110)', () => {
  const opts = { atom: 'ocs_add_custom_action' };

  it.each([
    'https://www.commcarehq.org',
    'https://eu.commcarehq.org/a/x/api',
    'https://connect.dimagi.com/api',
    'https://labs.connect.dimagi.com/mcp/',
  ])('allows %s', (u) => {
    expect(() => assertAllowedActionHost(u, opts)).not.toThrow();
  });

  it('refuses an arbitrary host', () => {
    expect(() => assertAllowedActionHost('https://attacker.example.com/collect', opts))
      .toThrow(PathContainmentError);
  });

  it('explains that the host becomes a tool called on every conversation', () => {
    // The durable-channel framing is the point: this is not a one-shot read.
    expect(() => assertAllowedActionHost('https://attacker.example.com', opts))
      .toThrow(/every\s+conversation/);
  });

  it('is not fooled by a lookalike prefix', () => {
    expect(() => assertAllowedActionHost('https://evil-dimagi.com', opts)).toThrow();
  });

  it('is not fooled by an allowed host used as a prefix of another domain', () => {
    expect(() => assertAllowedActionHost('https://dimagi.com.attacker.net', opts)).toThrow();
  });

  it('requires https — a production bot’s tool endpoint must not be plaintext', () => {
    expect(() => assertAllowedActionHost('http://www.commcarehq.org', opts)).toThrow(/must be https/);
  });

  it('rejects a malformed URL rather than passing it through', () => {
    expect(() => assertAllowedActionHost('not a url', opts)).toThrow(/not a valid URL/);
  });

  it('honours an extra host from configuration', () => {
    expect(() =>
      assertAllowedActionHost('https://staging.example.org/api', {
        ...opts,
        extraHosts: ['staging.example.org'],
      }),
    ).not.toThrow();
  });

  it('the allowlist is Dimagi-operated hosts only', () => {
    expect([...ALLOWED_ACTION_HOST_SUFFIXES].sort()).toEqual(
      ['commcarehq.org', 'dimagi-ai.com', 'dimagi.com'].sort(),
    );
  });
});
