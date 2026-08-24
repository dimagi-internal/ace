/**
 * ace#1561 — the chatbots-table scrape stopped resolving ANY `experiment_id`,
 * and the failure was reported as a stale table.
 *
 * Two independent defects, tested separately here:
 *
 *  1. THE PARSE. `ChatbotTable.name` is a `chip_action`. OCS PR #4220
 *     ("Consistent chip rendering in tables", merged 2026-08-18T11:56Z) changed
 *     `templates/generic/action.html` from emitting `{{ label }}` inside the
 *     `<a>` to `{% include "generic/chip_label.html" %}`, and set
 *     `truncate=True` on this table — so the anchor body became
 *     `<span class="min-w-0 truncate" title="NAME">NAME</span>`.
 *     ACE's regex captured the anchor's RAW inner HTML, so the map came back
 *     keyed on markup: 72 entries, 0 matches, every `experiment_id` null.
 *     ACE's side of that path had not changed since 2026-04-28 (62da71bb).
 *
 *  2. THE MISDIAGNOSIS, which is the more damaging half. An unparseable table
 *     and an empty one both produced an empty map with no error, so
 *     `getChatbot` fell through to `ExperimentIdStaleError` — "a freshly-cloned
 *     bot takes minutes to appear, wait and retry" — for a bot created seven
 *     weeks earlier. Empty-because-unparseable and empty-because-not-yet-created
 *     must now produce different, honest errors.
 *
 * The fixture is re-derived from upstream template SOURCE (see its header), not
 * from a guess. NOT exercised here: a live round-trip against OCS.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PlaywrightBackend,
  parseChatbotTable,
  parseChatbotTableRows,
} from '../../../mcp/ocs/backends/playwright.js';
import { CompositeBackend } from '../../../mcp/ocs/backends/composite.js';
import { ChatbotTableShapeError, ExperimentIdStaleError } from '../../../mcp/ocs/errors.js';
import type { RequestFn } from '../../../mcp/ocs/backends/pipeline-patch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The live shape today: chip anchor wrapping a truncation <span>. */
const POST_4220 = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'chatbots-table-post-4220.html'),
  'utf-8',
);

/** The shape before PR #4220 — the label sat directly in the anchor. */
const PRE_4220 = `
  <table><tbody>
    <tr class="border-b" id="record-12003" data-redirect-url="/a/connect-ace/chatbots/12003/">
      <td><div class="join">
        <a href="/a/connect-ace/chatbots/12003/" class="btn btn-sm join-item btn-soft btn-primary">
            ACE - hh-poverty-targeting
          </a>
      </div></td>
    </tr>
    <tr class="border-b" id="record-11792" data-redirect-url="/a/connect-ace/chatbots/11792/">
      <td><div class="join">
        <a href="/a/connect-ace/chatbots/11792/" class="btn">ACE Golden Template &amp; Fixtures</a>
      </div></td>
    </tr>
  </tbody></table>`;

/** django-tables2 renders `Meta.empty_text` for a team with no chatbots. No
 *  record ids, no `data-redirect-url` — nothing that looks like a row. */
const EMPTY_TEAM = `
  <div class="table-container"><table class="table w-full">
    <thead><tr><th>Name</th><th>Total Participants</th></tr></thead>
    <tbody><tr><td colspan="2" class="text-center">No chatbots found.</td></tr></tbody>
  </table></div>`;

function backendFor(html: string) {
  const request: RequestFn = async (method, url) => {
    if (method === 'GET' && url === '/a/dimagi/chatbots/table/') {
      return { ok: true, status: 200, text: async () => html, json: async () => ({}) };
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return new PlaywrightBackend({
    teamSlug: 'dimagi',
    baseUrl: 'https://www.openchatstudio.com',
    csrfToken: 'csrf-xyz',
    request,
  });
}

// ── 1. the parse ─────────────────────────────────────────────────────

describe('the regression this fixture reproduces (ace#1561)', () => {
  it('the pre-fix regex keys the map on MARKUP, not on names', () => {
    // Verbatim from mcp/ocs/backends/playwright.ts@62da71bb, so the fixture is
    // proven to be a real reproducer rather than a fixture the new code happens
    // to like. Every key is a <span>, so no REST name can ever match one.
    const legacy = /id="record-(\d+)"[\s\S]*?<a [^>]*>([\s\S]*?)<\/a>/g;
    const legacyMap = new Map<string, number>();
    for (const m of POST_4220.matchAll(legacy)) {
      const name = m[2].trim();
      if (name) legacyMap.set(name, Number(m[1]));
    }
    expect(legacyMap.size).toBe(3);
    expect(legacyMap.has('ACE - hh-poverty-targeting')).toBe(false);
    for (const key of legacyMap.keys()) expect(key).toContain('<span');
  });
});

describe('parseChatbotTableRows on the current (post-#4220) table', () => {
  it('reads the name out of the truncation span', () => {
    const map = parseChatbotTable(POST_4220);
    expect(map.get('ACE - hh-poverty-targeting')).toBe(12003);
    expect(map.size).toBe(3);
  });

  it('decodes Django-escaped entities so the key matches the REST name', () => {
    expect(parseChatbotTable(POST_4220).get('ACE Golden Template & Fixtures')).toBe(11792);
  });

  it("keeps the archived suffix, which is part of the row's rendered label", () => {
    expect(parseChatbotTable(POST_4220).get('ACE - bednet-check-2-visit (archived)')).toBe(12948);
  });

  it('reports no unnamed rows', () => {
    const { rows } = parseChatbotTableRows(POST_4220);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.name == null)).toEqual([]);
  });
});

describe('parseChatbotTableRows still reads the pre-#4220 shape', () => {
  it('parses a bare label sitting directly in the anchor', () => {
    const map = parseChatbotTable(PRE_4220);
    expect(map.get('ACE - hh-poverty-targeting')).toBe(12003);
    expect(map.get('ACE Golden Template & Fixtures')).toBe(11792);
    expect(map.size).toBe(2);
  });
});

describe('rows are bounded to their own region', () => {
  it('a row with no name chip is null, and does not steal the next row anchor', () => {
    const html = `
      <tr id="record-500" data-redirect-url="/a/t/chatbots/500/"><td></td></tr>
      <tr id="record-501" data-redirect-url="/a/t/chatbots/501/">
        <td><a href="/a/t/chatbots/501/" class="btn">Real Bot</a></td>
      </tr>`;
    const { rows, idsByName } = parseChatbotTableRows(html);
    expect(rows).toEqual([
      { experimentId: 500, name: null },
      { experimentId: 501, name: 'Real Bot' },
    ]);
    expect(idsByName.get('Real Bot')).toBe(501);
  });
});

// ── 2. the misdiagnosis ──────────────────────────────────────────────

describe('fetchExperimentIdsByName distinguishes unparseable from empty', () => {
  it('returns the map for a table it can read', async () => {
    const map = await backendFor(POST_4220).fetchExperimentIdsByName();
    expect(map.get('ACE - hh-poverty-targeting')).toBe(12003);
  });

  it('does NOT throw for a team that genuinely has no chatbots', async () => {
    const map = await backendFor(EMPTY_TEAM).fetchExperimentIdsByName();
    expect(map.size).toBe(0);
  });

  it('throws ChatbotTableShapeError when rows are present but no name parses', async () => {
    // The next reshape of the name chip, whatever it turns out to be.
    const drifted = POST_4220.replace(/<a[\s][^>]*>/g, '<button>').replace(/<\/a>/g, '</button>');
    await expect(backendFor(drifted).fetchExperimentIdsByName()).rejects.toThrow(
      ChatbotTableShapeError,
    );
  });

  it('throws when only SOME rows lose their name chip', async () => {
    const partial = `
      <tr id="record-500" data-redirect-url="/a/t/chatbots/500/"><td></td></tr>
      <tr id="record-501" data-redirect-url="/a/t/chatbots/501/">
        <td><a href="/a/t/chatbots/501/" class="btn">Real Bot</a></td>
      </tr>`;
    const err = await backendFor(partial)
      .fetchExperimentIdsByName()
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ChatbotTableShapeError);
    expect((err as Error).message).toMatch(/500/);
  });

  it('names the template that drifted and refuses the wait-and-retry remedy', async () => {
    const drifted = POST_4220.replace(/<a[\s][^>]*>/g, '<button>').replace(/<\/a>/g, '</button>');
    const err = await backendFor(drifted)
      .fetchExperimentIdsByName()
      .catch((e: Error) => e);
    const msg = (err as Error).message;
    expect(msg).toMatch(/generic\/action\.html/);
    expect(msg).toMatch(/chip_label\.html/);
    expect(msg).toMatch(/TEMPLATE DRIFT/);
    expect(msg).toMatch(/waiting will not fix it/);
    expect(msg).toMatch(/upstream-regression-triage/);
    expect(msg).toMatch(/Do NOT clone/);
    // The lie this issue is about.
    expect(msg).not.toMatch(/Wait and retry/i);
    expect(msg).not.toMatch(/freshly-cloned/i);
  });
});

describe('getChatbot reports drift honestly, not as staleness (ace#1561)', () => {
  const BOT = { id: 'ea900d8b-dc4b-40f1-aa86-489ad3755369', name: 'ACE - hh-poverty-targeting' };

  function composite(scrapeHtml: string) {
    const rest = {
      getChatbot: async () => ({ ...BOT, experiment_id: null }),
      // The bot IS on the default team — the condition that used to make the
      // stale branch fire for all 72 bots.
      listChatbots: async () => ({ chatbots: [{ id: BOT.id, name: BOT.name }] }),
    };
    return new CompositeBackend({ rest, playwright: backendFor(scrapeHtml) } as never);
  }

  it('a table it cannot parse raises ChatbotTableShapeError, not ExperimentIdStaleError', async () => {
    const drifted = POST_4220.replace(/<a[\s][^>]*>/g, '<button>').replace(/<\/a>/g, '</button>');
    const err = await composite(drifted)
      .getChatbot({ public_id: BOT.id })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ChatbotTableShapeError);
    expect(err).not.toBeInstanceOf(ExperimentIdStaleError);
  });

  it('a readable table still enriches the id', async () => {
    const out = await composite(POST_4220).getChatbot({ public_id: BOT.id });
    expect(out.experiment_id).toBe(12003);
  });

  it('a map that overlaps REST on NOTHING is drift, even though it parsed rows', async () => {
    // The exact 2026-08-19 shape, and the one a "did anything parse?" guard
    // cannot see: 72 rows parsed, every key markup, zero matches. Simulated
    // here by handing the composite a scrape of a DIFFERENT team's names.
    const foreign = POST_4220.replace(/ACE - hh-poverty-targeting/g, '<span>garbled</span>')
      .replace(/ACE Golden Template &amp; Fixtures/g, 'unrelated-a')
      .replace(/ACE - bednet-check-2-visit \(archived\)/g, 'unrelated-b');
    const err = await composite(foreign)
      .getChatbot({ public_id: BOT.id })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ChatbotTableShapeError);
    expect((err as Error).message).toMatch(/not one of them matches/);
  });

  it('one missing row among matching ones is still staleness, not drift', async () => {
    // The ace#1451 case with a populated table: the new bot is absent, but the
    // scrape and REST agree about the rest of the team.
    const rest = {
      getChatbot: async () => ({ id: 'brand-new-uuid', name: 'ACE - just-cloned', experiment_id: null }),
      listChatbots: async () => ({
        chatbots: [
          { id: 'brand-new-uuid', name: 'ACE - just-cloned' },
          { id: 'older-uuid', name: 'ACE - hh-poverty-targeting' },
        ],
      }),
    };
    const c = new CompositeBackend({ rest, playwright: backendFor(POST_4220) } as never);
    await expect(c.getChatbot({ public_id: 'brand-new-uuid' })).rejects.toThrow(
      ExperimentIdStaleError,
    );
  });

  it('a genuinely stale table (empty team page, bot on default team) is still ExperimentIdStaleError', async () => {
    // The ace#1451 case is untouched: the scrape succeeded, the page really has
    // no rows yet, and REST says the bot is on this team — that IS staleness.
    await expect(composite(EMPTY_TEAM).getChatbot({ public_id: BOT.id })).rejects.toThrow(
      ExperimentIdStaleError,
    );
  });
});
