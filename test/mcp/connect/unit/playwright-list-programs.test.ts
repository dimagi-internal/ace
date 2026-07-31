/**
 * Unit tests for PlaywrightBackend.listPrograms (jjackson/ace#1089).
 *
 * Two defects, both confirmed live on ai-demo-space (run 20260730-1718):
 *
 *   1. The `name` filter was exact-match, so a literal PREFIX of a real
 *      program name ("Spark FCAP Facilitation" vs "Spark FCAP Facilitation
 *      — Malawi Field Deployment") silently returned []. connect-program-setup
 *      reads [] as "no program exists" and mints a duplicate. The filter is
 *      now a case-insensitive substring match.
 *
 *   2. Every list row carried typed zeros (`budget: 0`, `currency: ""`, ...)
 *      for the six fields the list page does not render — indistinguishable
 *      from real values. Unfiltered rows now carry `null`; name-filtered
 *      rows are hydrated via a per-row getProgram.
 */
import { describe, it, expect } from 'vitest';
import type { APIRequestContext, APIResponse } from 'playwright';
import { PlaywrightBackend } from '../../../../mcp/connect/backends/playwright.js';

const SPARK_UUID = 'a115e4f2-6af6-401b-8add-8b97af80f43c';
const OTHER_UUID = '34d4fb36-2028-4a79-8cd3-aa8e5e7d842f';

// Minimal list-page markup matching parseProgramsList's card anchors
// (x-data="{showOpp...}" container, card_title, card_description, edit URL).
const card = (uuid: string, name: string, description: string) => `
  <div class="flex flex-col p-6" x-data="{showOpp: false, showInviteModal: false}">
    <div class="w-full">
      <p class="card_title">${name}</p>
      <p class="card_description w-full">${description}</p>
    </div>
    <button class="button-icon" hx-get="/a/ai-demo-space/program/${uuid}/edit"></button>
  </div>`;

// The two wrapper divs matter: parseProgramsList's card regex terminates the
// LAST card at a `</div></div></div>` run (or at the next card's opener).
const LIST_HTML = `<html><body><div class="page"><div class="list">
  ${card(SPARK_UUID, 'Spark FCAP Facilitation — Malawi Field Deployment', 'CBF facilitation program')}
  ${card(OTHER_UUID, 'ACE-Probe-1777406601155', 'Created by ace-connect probe script')}
</div></div></body></html>`;

// Edit-form markup for getProgram hydration of the Spark program, carrying
// the six values the live instance renders (extractFormFieldValues shapes).
const SPARK_EDIT_HTML = `<form>
  <input type="hidden" name="csrfmiddlewaretoken" value="csrf-token-value">
  <input name="name" value="Spark FCAP Facilitation — Malawi Field Deployment">
  <textarea name="description">CBF facilitation program</textarea>
  <input name="delivery_type" value="14">
  <input name="budget" value="25000">
  <input name="currency" value="USD">
  <input name="country" value="MWI">
  <input name="start_date" value="2026-07-28">
  <input name="end_date" value="2027-01-31">
</form>`;

/** Fake APIRequestContext that routes by path and records what was fetched. */
function fakeRequest(routes: Record<string, string>, hits: string[] = []): APIRequestContext {
  return {
    get: async (path: string) => {
      hits.push(path);
      const html = routes[path];
      return {
        status: () => (html !== undefined ? 200 : 404),
        headers: () => ({ 'content-type': 'text/html' }),
        text: async () => html ?? 'not found',
      } as unknown as APIResponse;
    },
  } as unknown as APIRequestContext;
}

function backend(hits: string[] = []): PlaywrightBackend {
  return new PlaywrightBackend({
    baseUrl: 'https://connect.dimagi.com',
    csrfToken: 'csrf',
    request: fakeRequest({
      '/a/ai-demo-space/program/': LIST_HTML,
      [`/a/ai-demo-space/program/${SPARK_UUID}/edit`]: SPARK_EDIT_HTML,
    }, hits),
  });
}

describe('listPrograms name filter (jjackson/ace#1089 defect 1)', () => {
  it('matches a literal prefix of the real program name (the live false-negative)', async () => {
    const { programs } = await backend().listPrograms({
      organization_slug: 'ai-demo-space',
      name: 'Spark FCAP Facilitation',
    });
    expect(programs).toHaveLength(1);
    expect(programs[0].id).toBe(SPARK_UUID);
  });

  it('matches case-insensitively on an interior substring', async () => {
    const { programs } = await backend().listPrograms({
      organization_slug: 'ai-demo-space',
      name: 'malawi field',
    });
    expect(programs).toHaveLength(1);
    expect(programs[0].id).toBe(SPARK_UUID);
  });

  it('still matches the exact full name (findProgramByName regression)', async () => {
    const { programs } = await backend().listPrograms({
      organization_slug: 'ai-demo-space',
      name: 'Spark FCAP Facilitation — Malawi Field Deployment',
    });
    expect(programs).toHaveLength(1);
    expect(programs[0].id).toBe(SPARK_UUID);
  });

  it('returns [] when nothing matches', async () => {
    const { programs } = await backend().listPrograms({
      organization_slug: 'ai-demo-space',
      name: 'no such program anywhere',
    });
    expect(programs).toEqual([]);
  });
});

describe('listPrograms hydration (jjackson/ace#1089 defect 2)', () => {
  it('unfiltered rows carry null — never typed zeros — for the six unrendered fields', async () => {
    const hits: string[] = [];
    const { programs } = await backend(hits).listPrograms({ organization_slug: 'ai-demo-space' });
    expect(programs).toHaveLength(2);
    for (const p of programs) {
      expect(p.delivery_type).toBeNull();
      expect(p.budget).toBeNull();
      expect(p.currency).toBeNull();
      expect(p.country).toBeNull();
      expect(p.start_date).toBeNull();
      expect(p.end_date).toBeNull();
    }
    // No per-row hydration fetches on the unfiltered path (41-row org lists).
    expect(hits).toEqual(['/a/ai-demo-space/program/']);
  });

  it('name-filtered rows are hydrated to match connect_get_program on all six fields', async () => {
    const b = backend();
    const { programs } = await b.listPrograms({
      organization_slug: 'ai-demo-space',
      name: 'Spark FCAP Facilitation',
    });
    const row = programs[0];
    const full = await b.getProgram({ organization_slug: 'ai-demo-space', program_id: SPARK_UUID });
    expect(row.delivery_type).toBe(full.delivery_type);
    expect(row.budget).toBe(full.budget);
    expect(row.currency).toBe(full.currency);
    expect(row.country).toBe(full.country);
    expect(row.start_date).toBe(full.start_date);
    expect(row.end_date).toBe(full.end_date);
    expect(row).toMatchObject({
      delivery_type: 14,
      budget: 25000,
      currency: 'USD',
      country: 'MWI',
      start_date: '2026-07-28',
      end_date: '2027-01-31',
      organization_slug: 'ai-demo-space',
    });
  });
});
