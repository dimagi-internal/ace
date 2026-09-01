import { describe, it, expect, vi } from 'vitest';
import { CompositeBackend } from '../../../mcp/ocs/backends/composite.js';
import { VersionBadgeUnreadableError } from '../../../mcp/ocs/errors.js';

describe('CompositeBackend routing', () => {
  it('routes REST atoms to the REST backend', async () => {
    const rest = { listChatbots: vi.fn().mockResolvedValue({ chatbots: [], next_cursor: undefined }) };
    const pw = {};
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });
    await c.listChatbots({});
    expect(rest.listChatbots).toHaveBeenCalled();
  });

  it('routes PLAYWRIGHT atoms to the Playwright backend', async () => {
    const rest = {};
    const pw = { cloneChatbot: vi.fn().mockResolvedValue({ experiment_id: 1, public_id: 'u', pipeline_id: 2 }) };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });
    await c.cloneChatbot({ template_id: 1, new_name: 'x' });
    expect(pw.cloneChatbot).toHaveBeenCalled();
  });

  it('routes HYBRID atoms to the Playwright backend by default', async () => {
    const rest = {};
    const pw = { getChatbotEmbedInfo: vi.fn().mockResolvedValue({ public_id: 'u', embed_key: 'e' }) };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });
    await c.getChatbotEmbedInfo({ experiment_id: 1 });
    expect(pw.getChatbotEmbedInfo).toHaveBeenCalled();
  });

  it('getChatbotPipelineId calls playwright.pipelineIdFor and wraps the result', async () => {
    const rest = {};
    const pw = { pipelineIdFor: vi.fn().mockResolvedValue(5942) };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });
    const out = await c.getChatbotPipelineId({ experiment_id: 12167 });
    expect(pw.pipelineIdFor).toHaveBeenCalledWith(12167);
    expect(out).toEqual({ pipeline_id: 5942 });
  });
});

// ---------------------------------------------------------------------------
// dimagi-internal/ace#891 — publish read-back fallback
// ---------------------------------------------------------------------------

// Also the landing site for ace#1297: a home page whose only badge is
// `Version 0` now raises the same typed error (0 is not a publishable
// version), so these cases cover that chain too — the live payload below IS
// #1297's (top-level counter 3, published default 2).
describe('CompositeBackend.publishChatbotVersion — badge-unreadable fallback (#891)', () => {
  const badgeFailure = () =>
    new VersionBadgeUnreadableError(99, 'pub-uuid', 'published, badge unreadable');

  // The live payload shape from the issue's repros: the top-level counter is
  // AHEAD of the published default. This is the whole trap.
  const chatbotPayload = {
    id: 'pub-uuid',
    name: 'ACE bot',
    version_number: 3, // working/next counter — must NOT be returned
    versions: [
      { version_number: 1, is_default_version: false },
      { version_number: 2, is_default_version: true, version_description: 'Initial ACE version' },
    ],
  };

  it('returns the PUBLISHED version, not the working counter', async () => {
    const rest = { getChatbot: vi.fn().mockResolvedValue(chatbotPayload) };
    const pw = { publishChatbotVersion: vi.fn().mockRejectedValue(badgeFailure()) };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });

    const out = await c.publishChatbotVersion({ experiment_id: 99, description: 'x' });

    // 2, not 3. Returning 3 writes an off-by-one into run_state.yaml and later
    // breaks llo-launch's freshness equality check.
    expect(out).toEqual({ version_number: 2, task_id: 'none', source: 'api' });
    expect(rest.getChatbot).toHaveBeenCalledWith({ public_id: 'pub-uuid' });
  });

  it('consults the API even when the badge scrape succeeded, and the API wins (#1828)', async () => {
    // This used to assert the opposite — that a successful scrape short-
    // circuited the API read. That WAS the #1828 defect: the badge can lag the
    // publish it describes, and when it does, the stale number is returned
    // under a field named `version_number` with nothing to flag it.
    const rest = { getChatbot: vi.fn().mockResolvedValue(chatbotPayload) };
    const pw = {
      publishChatbotVersion: vi
        .fn()
        .mockResolvedValue({ version_number: 7, task_id: 'none', public_id: 'pub-uuid' }),
    };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });

    const out = await c.publishChatbotVersion({ experiment_id: 99, description: 'x' });

    expect(out).toEqual({ version_number: 2, task_id: 'none', source: 'api' });
    expect(rest.getChatbot).toHaveBeenCalledWith({ public_id: 'pub-uuid' });
  });

  it('still fails loud when the API cannot answer either (#823 invariant)', async () => {
    // The point of the fallback is a better ANSWER, never a guess. An empty
    // versions[] must rethrow rather than invent a number.
    const rest = { getChatbot: vi.fn().mockResolvedValue({ id: 'pub-uuid', name: 'b', versions: [] }) };
    const pw = { publishChatbotVersion: vi.fn().mockRejectedValue(badgeFailure()) };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });

    await expect(
      c.publishChatbotVersion({ experiment_id: 99, description: 'x' }),
    ).rejects.toThrow(VersionBadgeUnreadableError);
  });

  it('fails loud when no version is flagged as default', async () => {
    const rest = {
      getChatbot: vi.fn().mockResolvedValue({
        id: 'pub-uuid',
        name: 'b',
        version_number: 3,
        versions: [{ version_number: 1, is_default_version: false }],
      }),
    };
    const pw = { publishChatbotVersion: vi.fn().mockRejectedValue(badgeFailure()) };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });

    await expect(
      c.publishChatbotVersion({ experiment_id: 99, description: 'x' }),
    ).rejects.toThrow(VersionBadgeUnreadableError);
  });

  it('recovers the public_id from the chatbot list when the error carries none', async () => {
    const rest = {
      listChatbots: vi.fn().mockResolvedValue({
        chatbots: [{ id: 'found-uuid', name: 'ACE bot', experiment_id: 99 }],
      }),
      getChatbot: vi.fn().mockResolvedValue({ ...chatbotPayload, id: 'found-uuid' }),
    };
    const pw = {
      publishChatbotVersion: vi
        .fn()
        .mockRejectedValue(new VersionBadgeUnreadableError(99, undefined, 'no public id')),
    };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });

    const out = await c.publishChatbotVersion({ experiment_id: 99, description: 'x' });

    expect(out.version_number).toBe(2);
    expect(rest.getChatbot).toHaveBeenCalledWith({ public_id: 'found-uuid' });
  });

  it('rethrows any error that is not the badge failure', async () => {
    const rest = { getChatbot: vi.fn() };
    const pw = { publishChatbotVersion: vi.fn().mockRejectedValue(new Error('publish rejected')) };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });

    await expect(
      c.publishChatbotVersion({ experiment_id: 99, description: 'x' }),
    ).rejects.toThrow(/publish rejected/);
    expect(rest.getChatbot).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1028 — getChatbot experiment_id enrichment must fail
// loud, not silently return null
// ---------------------------------------------------------------------------

describe('CompositeBackend.getChatbot — experiment_id enrichment (#1028)', () => {
  // Live REST shape: `url` is the UUID-keyed API URL, so the URL-regex parser
  // yields experiment_id: null and enrichment is the only integer-id source.
  const restBot = {
    id: 'e5fe588f-1604-418c-a1b9-26164213131d',
    name: 'ACE - spark-facilitator (20260728-1338)',
    url: 'https://www.openchatstudio.com/api/experiments/e5fe588f-1604-418c-a1b9-26164213131d/',
    version_number: 3,
    versions: [],
    experiment_id: null,
  };

  it('enriches a null experiment_id from the chatbots-table scrape by name', async () => {
    const rest = { getChatbot: vi.fn().mockResolvedValue({ ...restBot }) };
    const pw = {
      fetchExperimentIdsByName: vi
        .fn()
        .mockResolvedValue(new Map([[restBot.name, 12804]])),
    };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });

    const out = await c.getChatbot({ public_id: restBot.id });

    expect(out.experiment_id).toBe(12804);
  });

  it('throws a typed error when the scrape fails — a silent null invites the forbidden re-clone', async () => {
    // ace#1028's live shape: the id IS derivable (12804), the scrape just
    // failed that session. Swallowing the failure returns experiment_id: null
    // on exactly the read path resume idempotency depends on, and the
    // caller's documented-forbidden recovery is cloning a duplicate bot.
    const rest = { getChatbot: vi.fn().mockResolvedValue({ ...restBot }) };
    const pw = {
      fetchExperimentIdsByName: vi.fn().mockRejectedValue(new Error('401 session expired')),
    };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });

    await expect(c.getChatbot({ public_id: restBot.id })).rejects.toThrow(
      /experiment_id.*scrape failed.*ocs-login.*Do NOT clone/is,
    );
  });

  it('returns the bot with a null experiment_id when the scrape succeeds but the name is absent', async () => {
    // A successful scrape that lacks the name is honest absence (e.g. the bot
    // lives on a non-default team) — degraded null, not an error.
    const rest = { getChatbot: vi.fn().mockResolvedValue({ ...restBot }) };
    const pw = { fetchExperimentIdsByName: vi.fn().mockResolvedValue(new Map()) };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });

    const out = await c.getChatbot({ public_id: restBot.id });

    expect(out.experiment_id).toBeNull();
  });

  it('listChatbots keeps best-effort degraded mode: a scrape failure yields null ids, no throw', async () => {
    // The list contract is documented best-effort per row; only the single-bot
    // read is load-bearing enough to fail loud.
    const rest = {
      listChatbots: vi.fn().mockResolvedValue({
        chatbots: [{ id: 'u1', name: 'bot one', experiment_id: null }],
        next_cursor: undefined,
      }),
    };
    const pw = {
      fetchExperimentIdsByName: vi.fn().mockRejectedValue(new Error('401 session expired')),
    };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });

    const out = await c.listChatbots({});

    expect(out.chatbots[0].experiment_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1828 — the publish return must be the POST-publish
// version, not the pre-publish one
// ---------------------------------------------------------------------------

// Observed on bednet-check-2-visit/20260828-0629, Phase 6 ocs-knowledge-refresh:
// the bot was at published default v2; the publish created v3; the atom
// returned `{ version_number: 2, task_id: 'none' }`. The home-page `Version N`
// badge scrape had not caught up, and the scrape was the answer. Both
// ocs-agent-setup § Step 11 and ocs-knowledge-refresh § Step 4 write that
// number into run_state.yaml, so durable state went one version behind a live
// bot — quietly, because the recorded number is a real version that really
// existed.
describe('CompositeBackend.publishChatbotVersion — post-publish version (#1828)', () => {
  // The live shape after the Phase 6 republish: published default 3, working
  // counter 4, and a home page still rendering 2 as its highest badge.
  const afterPublish = {
    id: '8bbd91b4-7365-49aa-b44c-05643dab8ef8',
    name: 'ACE bot',
    version_number: 4, // working/next counter — must NOT be returned
    versions: [
      { version_number: 1, is_default_version: false },
      { version_number: 2, is_default_version: false },
      { version_number: 3, is_default_version: true, version_description: 'Phase 6 knowledge refresh' },
    ],
  };

  it('returns the API-authoritative published version, not the stale badge scrape', async () => {
    const rest = { getChatbot: vi.fn().mockResolvedValue(afterPublish) };
    const pw = {
      publishChatbotVersion: vi.fn().mockResolvedValue({
        version_number: 2, // the PRE-publish number the badge scrape reads back
        task_id: 'none',
        public_id: afterPublish.id,
      }),
    };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });

    const out = await c.publishChatbotVersion({ experiment_id: 13027, description: 'refresh' });

    expect(out.version_number).toBe(3);
    expect(out.source).toBe('api');
    expect(rest.getChatbot).toHaveBeenCalledWith({ public_id: afterPublish.id });
  });

  it('recovers the public_id from the chatbot list when the scrape did not carry one', async () => {
    const rest = {
      listChatbots: vi.fn().mockResolvedValue({
        chatbots: [{ id: afterPublish.id, name: 'ACE bot', experiment_id: 13027 }],
      }),
      getChatbot: vi.fn().mockResolvedValue(afterPublish),
    };
    const pw = {
      publishChatbotVersion: vi.fn().mockResolvedValue({ version_number: 2, task_id: 'none' }),
    };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });

    const out = await c.publishChatbotVersion({ experiment_id: 13027, description: 'refresh' });

    expect(out.version_number).toBe(3);
    expect(rest.getChatbot).toHaveBeenCalledWith({ public_id: afterPublish.id });
  });

  it('falls back to the scraped badge — labelled as such — when the API cannot answer', async () => {
    // The publish itself succeeded (the POST's 302 is handled inside the
    // Playwright backend). Losing the API read is not a reason to fail an
    // operation that demonstrably worked, but the caller must be able to tell
    // a scraped number from an authoritative one, so `source` says which.
    const rest = { getChatbot: vi.fn().mockRejectedValue(new Error('401 token expired')) };
    const pw = {
      publishChatbotVersion: vi
        .fn()
        .mockResolvedValue({ version_number: 2, task_id: 'none', public_id: afterPublish.id }),
    };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });

    const out = await c.publishChatbotVersion({ experiment_id: 13027, description: 'refresh' });

    expect(out).toEqual({ version_number: 2, task_id: 'none', source: 'home-page-badge' });
  });

  it('never returns the working counter when no version is flagged default', async () => {
    // versions[] with no default is the one shape where the API cannot name a
    // published version. Returning `version_number: 4` here is the off-by-one
    // ace#891 already ruled out; fall back to the scrape instead.
    const rest = {
      getChatbot: vi.fn().mockResolvedValue({
        ...afterPublish,
        versions: [{ version_number: 1, is_default_version: false }],
      }),
    };
    const pw = {
      publishChatbotVersion: vi
        .fn()
        .mockResolvedValue({ version_number: 2, task_id: 'none', public_id: afterPublish.id }),
    };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });

    const out = await c.publishChatbotVersion({ experiment_id: 13027, description: 'refresh' });

    expect(out.version_number).toBe(2);
    expect(out.source).toBe('home-page-badge');
  });
});
