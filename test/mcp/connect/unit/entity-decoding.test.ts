/**
 * HTML-entity decoding on Connect's form scrapes (dimagi-internal/ace#1140).
 *
 * `extractFormFieldValues` read `<input value>`, `<textarea>` bodies and
 * selected `<option value>` verbatim. Django autoescapes on render, so every
 * apostrophe in a stored value came back as the literal 7-character string
 * `&#x27;`. Two failures followed:
 *
 *   1. Lossy read — `getProgram` / `getOpportunity` returned escaped text.
 *   2. **A corruption ratchet.** `updateProgram` is a read-modify-write: it
 *      re-POSTs every field it wasn't asked to change straight out of that
 *      escaped read. Django stored the escaped form and escaped it again on
 *      the next render, so each update added ONE level, permanently. Observed
 *      live on three `ai-demo-space` programs (`Neal Lesh&amp;#x27;s`,
 *      `confidence &amp;amp;gt;=0.80` — three levels on a single `>`).
 *
 * The tests below are the regression: an escape/decode round-trip must be
 * STABLE over repeated updates, and the decode must be single-pass (exactly
 * one `escape()` undone) rather than fixed-point.
 */
import { describe, it, expect } from 'vitest';
import type { APIRequestContext, APIResponse } from 'playwright';
import {
  decodeHtmlEntities,
  extractFormFieldValues,
  parseProgramsList,
} from '../../../../mcp/connect/backends/html-scrape.js';
import { PlaywrightBackend } from '../../../../mcp/connect/backends/playwright.js';

/**
 * Django's `django.utils.html.escape`, verbatim: `&` first, then the four
 * characters whose escapes would otherwise be re-escaped.
 */
function djangoEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** The text that actually broke in production, minus the run-specific bits. */
const DIRTY = `Spark's M&E shape — concat(community_id, '-', date) with confidence >=0.80 and a "quoted" phrase`;

describe('decodeHtmlEntities', () => {
  it('is the exact inverse of one Django escape() for every escaped character', () => {
    expect(decodeHtmlEntities(djangoEscape(DIRTY))).toBe(DIRTY);
    for (const ch of ['&', '<', '>', '"', "'"]) {
      expect(decodeHtmlEntities(djangoEscape(ch))).toBe(ch);
    }
  });

  it('decodes the legacy &#39; apostrophe form (pre-Django-3.0 renders)', () => {
    expect(decodeHtmlEntities('Spark&#39;s')).toBe("Spark's");
  });

  it('decodes &amp; LAST — one pass, never a fixed point', () => {
    // This is the ordering trap. `&amp;#x27;` is what Django renders for a
    // STORED `&#x27;`. Decoding it must yield `&#x27;` (one level), not `'`
    // (two levels) — otherwise a legitimately-stored entity is corrupted.
    expect(decodeHtmlEntities('&amp;#x27;')).toBe('&#x27;');
    expect(decodeHtmlEntities('&amp;amp;gt;')).toBe('&amp;gt;');
    expect(decodeHtmlEntities('&amp;quot;')).toBe('&quot;');
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeHtmlEntities('&amp;amp;')).toBe('&amp;');
  });

  it('peels exactly one level per call from an n-times-escaped string', () => {
    let s = DIRTY;
    for (let i = 0; i < 4; i++) s = djangoEscape(s);
    for (let i = 0; i < 4; i++) s = decodeHtmlEntities(s);
    expect(s).toBe(DIRTY);
  });

  it('leaves text that merely looks entity-ish alone', () => {
    expect(decodeHtmlEntities('A & B')).toBe('A & B');
    expect(decodeHtmlEntities('cost &euro;5')).toBe('cost &euro;5');
    expect(decodeHtmlEntities('&#8212; em dash')).toBe('&#8212; em dash');
  });
});

describe('extractFormFieldValues decodes all three extraction paths', () => {
  it('decodes <input value>, <textarea> body, and the selected <option>', () => {
    const html = `<form>
      <input name="name" value="${djangoEscape(`A "B" & C's`)}">
      <textarea name="description">${djangoEscape(DIRTY)}</textarea>
      <select name="country">
        <option value="US">United States</option>
        <option value="${djangoEscape(`Côte d'Ivoire`)}" selected>Côte d'Ivoire</option>
      </select>
    </form>`;
    const v = extractFormFieldValues(html);
    expect(v['name']).toBe(`A "B" & C's`);
    expect(v['description']).toBe(DIRTY);
    expect(v['country']).toBe(`Côte d'Ivoire`);
  });

  it('matches the shapes named in the issue', () => {
    expect(
      extractFormFieldValues('<textarea name="description">Spark&#x27;s M&amp;E</textarea>')['description'],
    ).toBe("Spark's M&E");
    expect(
      extractFormFieldValues('<input name="name" value="A &quot;B&quot; C">')['name'],
    ).toBe('A "B" C');
  });

  it('does not touch values with nothing to decode', () => {
    const v = extractFormFieldValues('<input name="budget" value="25000">');
    expect(v['budget']).toBe('25000');
  });
});

describe('parseProgramsList decodes card text', () => {
  it('returns the real program name so the name filter can match it', () => {
    const html = `<div class="p-6" x-data="{showOpp: false}">
      <p class="card_title">${djangoEscape(`Spark's FCAP — M&E`)}</p>
      <p class="card_description w-full">${djangoEscape(`Facilitators' program`)}</p>
      <button hx-get="/a/ai-demo-space/program/a115e4f2-6af6-401b-8add-8b97af80f43c/edit"></button>
    </div></div></div>`;
    const rows = parseProgramsList(html);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe(`Spark's FCAP — M&E`);
    expect(rows[0].description).toBe(`Facilitators' program`);
  });
});

// ── The ratchet regression ────────────────────────────────────────────────

const ORG = 'ai-demo-space';
const PROGRAM_ID = 'a115e4f2-6af6-401b-8add-8b97af80f43c';
const EDIT_PATH = `/a/${ORG}/program/${PROGRAM_ID}/edit`;

/**
 * A Django-shaped fake of Connect's program-edit endpoint: it holds the
 * STORED values, autoescapes them on render, and stores whatever the POST
 * body carries, verbatim. That is precisely the loop the ratchet ran in — if
 * the reader doesn't decode, the store deepens by one level per update.
 */
class FakeProgramEndpoint {
  constructor(public store: Record<string, string>) {}

  private renderEdit(): string {
    return `<html><body hx-headers='{"X-CSRFToken": "csrf-token-value"}'><form>
      <input name="name" value="${djangoEscape(this.store['name'])}">
      <textarea name="description">${djangoEscape(this.store['description'])}</textarea>
      <input name="delivery_type" value="${djangoEscape(this.store['delivery_type'])}">
      <input name="budget" value="${djangoEscape(this.store['budget'])}">
      <input name="currency" value="${djangoEscape(this.store['currency'])}">
      <input name="country" value="${djangoEscape(this.store['country'])}">
      <input name="start_date" value="${djangoEscape(this.store['start_date'])}">
      <input name="end_date" value="${djangoEscape(this.store['end_date'])}">
    </form></body></html>`;
  }

  asRequestContext(): APIRequestContext {
    const res = (status: number, body: string): APIResponse =>
      ({
        status: () => status,
        headers: () => ({ 'content-type': 'text/html' }),
        text: async () => body,
      }) as unknown as APIResponse;
    return {
      get: async (path: string) =>
        path === EDIT_PATH ? res(200, this.renderEdit()) : res(404, 'not found'),
      post: async (path: string, opts: { form: Record<string, string> }) => {
        if (path !== EDIT_PATH) return res(404, 'not found');
        for (const [k, val] of Object.entries(opts.form)) {
          if (k === 'csrfmiddlewaretoken') continue;
          this.store[k] = val;         // Django stores the raw POST value
        }
        return res(302, '');
      },
    } as unknown as APIRequestContext;
  }
}

function seededEndpoint(): FakeProgramEndpoint {
  return new FakeProgramEndpoint({
    name: `Spark's FCAP Facilitation — M&E`,
    description: DIRTY,
    delivery_type: '14',
    budget: '25000',
    currency: 'USD',
    country: 'MWI',
    start_date: '2026-07-28',
    end_date: '2027-01-31',
  });
}

function backendFor(endpoint: FakeProgramEndpoint): PlaywrightBackend {
  return new PlaywrightBackend({
    baseUrl: 'https://connect.dimagi.com',
    csrfToken: 'csrf',
    request: endpoint.asRequestContext(),
  });
}

describe('updateProgram read-modify-write does not escalate escaping (#1140)', () => {
  it('getProgram returns the stored text, not its escaped rendering', async () => {
    const endpoint = seededEndpoint();
    const program = await backendFor(endpoint).getProgram({
      organization_slug: ORG,
      program_id: PROGRAM_ID,
    });
    expect(program.description).toBe(DIRTY);
    expect(program.name).toBe(`Spark's FCAP Facilitation — M&E`);
    expect(program.description).not.toContain('&#x27;');
    expect(program.description).not.toContain('&amp;');
  });

  it('is a fixed point: N budget-only updates leave name/description byte-identical', async () => {
    const endpoint = seededEndpoint();
    const backend = backendFor(endpoint);
    const originalName = endpoint.store['name'];
    const originalDescription = endpoint.store['description'];

    for (let i = 0; i < 5; i++) {
      const updated = await backend.updateProgram({
        organization_slug: ORG,
        program_id: PROGRAM_ID,
        budget: 25000 + i,
      });
      // Both the STORED value (what an LLO sees on the program page) and the
      // value handed back to the caller stay clean at every iteration. Before
      // the fix, iteration i stored i+1 levels of escaping.
      expect(endpoint.store['name']).toBe(originalName);
      expect(endpoint.store['description']).toBe(originalDescription);
      expect(updated.name).toBe(originalName);
      expect(updated.description).toBe(originalDescription);
    }
    expect(endpoint.store['budget']).toBe('25004');
  });

  it('an explicitly-supplied description round-trips unescaped', async () => {
    const endpoint = seededEndpoint();
    const fresh = `Lands in Spark's shape; M&E gate at confidence >=0.80`;
    const updated = await backendFor(endpoint).updateProgram({
      organization_slug: ORG,
      program_id: PROGRAM_ID,
      description: fresh,
    });
    expect(endpoint.store['description']).toBe(fresh);
    expect(updated.description).toBe(fresh);
  });

  it('does not silently repair an ALREADY-corrupted stored value (single-pass, not fixed-point)', async () => {
    // A row that already carries the production corruption: the DB literally
    // holds `Neal Lesh&#x27;s`. One decode per read is the correct inverse of
    // one escape, so the read reports exactly what is stored and the update
    // preserves it. Un-ratcheting these rows is a separate, gated repair —
    // NOT something a read path may guess at.
    const endpoint = seededEndpoint();
    endpoint.store['description'] = 'Adopts Neal Lesh&#x27;s FIXED/ACE PDD.';
    const backend = backendFor(endpoint);

    const before = await backend.getProgram({ organization_slug: ORG, program_id: PROGRAM_ID });
    expect(before.description).toBe('Adopts Neal Lesh&#x27;s FIXED/ACE PDD.');

    await backend.updateProgram({ organization_slug: ORG, program_id: PROGRAM_ID, budget: 30000 });
    expect(endpoint.store['description']).toBe('Adopts Neal Lesh&#x27;s FIXED/ACE PDD.');
  });
});
