/**
 * ace#1451 — `getChatbot`'s third branch returned `experiment_id: null` for
 * both "the bot lives on a non-default team" (honest) and "the chatbots table
 * is stale because the bot was just cloned" (not honest). Live on
 * bednet-check-2-visit/20260814-2019 Phase 5: null at t0, 12948 ~7 minutes
 * later, same call, nothing changed in between.
 *
 * The null is what makes it dangerous. `ocs-setup`'s Resumption Contract makes
 * this read authoritative, and the stale window is exactly when resume fires —
 * a run that dies between the clone and the Step 11 state write. The resuming
 * agent gets null and the natural recovery is the duplicate clone that #1017
 * and #1028 both forbid.
 */
import { describe, it, expect, vi } from 'vitest';
import { CompositeBackend } from '../../../mcp/ocs/backends/composite';
import { ExperimentIdStaleError, ExperimentIdEnrichmentError } from '../../../mcp/ocs/errors';

const BOT = { id: 'a14441b4-7cd8-407c-aaeb-9b78b5b07391', name: 'ACE - bednet-check-2-visit (20260814-2019)' };

function backend(opts: {
  scrape: Map<string, number> | Error;
  defaultTeamIds: string[] | Error;
  experimentId?: number | null;
}) {
  const rest = {
    getChatbot: vi.fn().mockResolvedValue({ ...BOT, experiment_id: opts.experimentId ?? null }),
    listChatbots: vi.fn().mockImplementation(async () => {
      if (opts.defaultTeamIds instanceof Error) throw opts.defaultTeamIds;
      return { chatbots: opts.defaultTeamIds.map((id) => ({ id, name: 'x' })) };
    }),
  };
  const playwright = {
    fetchExperimentIdsByName: vi.fn().mockImplementation(async () => {
      if (opts.scrape instanceof Error) throw opts.scrape;
      return opts.scrape;
    }),
  };
  return new CompositeBackend({ rest, playwright } as never);
}

describe('the stale window is now loud (ace#1451)', () => {
  it('throws ExperimentIdStaleError when REST says default team but the scrape lacks it', () => {
    const b = backend({ scrape: new Map(), defaultTeamIds: [BOT.id] });
    return expect(b.getChatbot({ public_id: BOT.id })).rejects.toThrow(ExperimentIdStaleError);
  });

  it('tells the caller to WAIT AND RETRY, not to clone', async () => {
    const b = backend({ scrape: new Map(), defaultTeamIds: [BOT.id] });
    const err = await b.getChatbot({ public_id: BOT.id }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Wait and retry/i);
    expect((err as Error).message).toMatch(/Do NOT clone/);
    expect((err as Error).message).toMatch(/STALE scrape, not absence/);
  });
});

describe('honest absence stays honest', () => {
  it('returns a null id when the bot is NOT on the default team', async () => {
    // The documented degraded mode — a bot on another team is genuinely
    // absent from the default team's table, permanently.
    const b = backend({ scrape: new Map(), defaultTeamIds: ['some-other-bot'] });
    const out = await b.getChatbot({ public_id: BOT.id });
    expect(out.experiment_id).toBeNull();
  });

  it('degrades to a null id when the team check itself fails', async () => {
    // A flaky extra call must not invent a loud error.
    const b = backend({ scrape: new Map(), defaultTeamIds: new Error('502') });
    const out = await b.getChatbot({ public_id: BOT.id });
    expect(out.experiment_id).toBeNull();
  });
});

describe('the other two branches are unchanged', () => {
  it('a scrape that throws is still ExperimentIdEnrichmentError (ace#1028)', () => {
    const b = backend({ scrape: new Error('session expired'), defaultTeamIds: [BOT.id] });
    return expect(b.getChatbot({ public_id: BOT.id })).rejects.toThrow(ExperimentIdEnrichmentError);
  });

  it('a scrape that has the name still enriches', async () => {
    const b = backend({ scrape: new Map([[BOT.name, 12948]]), defaultTeamIds: [BOT.id] });
    expect((await b.getChatbot({ public_id: BOT.id })).experiment_id).toBe(12948);
  });

  it('an id already on the REST payload short-circuits — no scrape at all', async () => {
    const b = backend({ scrape: new Error('should not be called'), defaultTeamIds: [], experimentId: 999 });
    expect((await b.getChatbot({ public_id: BOT.id })).experiment_id).toBe(999);
  });
});
