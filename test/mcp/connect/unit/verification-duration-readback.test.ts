/**
 * dimagi-internal/ace#2945 — `connect_set_verification_flags` wrote
 * `deliver_unit_checks[].duration_minutes` and returned no read-back of it, so
 * a Phase 4 duration rule had no evidence it persisted.
 *
 * Fixture shape is the live `verification_flags_config` page as read on
 * smallholder-seasonal/20261014-0859 (opp 30605010-…, `ace-pm-org`): one
 * deliver_unit formset row per deliver unit, each a DISABLED select listing
 * every unit of the opportunity with ONE `selected`, plus a number input for
 * the duration. Row 0 was 7248 / 6; the other 11 rows read 0. No live write.
 */
import { describe, it, expect } from 'vitest';
import type { APIRequestContext, APIResponse } from 'playwright';
import { parseDeliverUnitChecks } from '../../../../mcp/connect/backends/html-scrape.js';
import { PlaywrightBackend, durationMismatches } from '../../../../mcp/connect/backends/playwright.js';
import { VerificationDurationNotPersistedError } from '../../../../mcp/connect/errors.js';

const DUS = Array.from({ length: 12 }, (_, i) => 7248 + i);

function duRow(i: number, du: number, duration: string): string {
  const options = DUS.map((d) => `<option value="${d}"${d === du ? ' selected' : ''}>Unit ${d}</option>`).join('');
  return `
    <select name="deliver_unit-${i}-deliver_unit" class="select form-select" disabled id="id_deliver_unit-${i}-deliver_unit">
      <option value="">---------</option>${options}
    </select>
    <input type="checkbox" name="deliver_unit-${i}-check_attachments" class="checkboxinput form-check-input" id="id_deliver_unit-${i}-check_attachments">
    <input type="number" name="deliver_unit-${i}-duration" value="${duration}" class="numberinput form-control" id="id_deliver_unit-${i}-duration">
    <input type="hidden" name="deliver_unit-${i}-id" value="${5000 + i}" id="id_deliver_unit-${i}-id">`;
}

function page(durations: Record<number, string> = {}): string {
  const rows = DUS.map((du, i) => duRow(i, du, durations[du] ?? '0')).join('\n');
  return `<html><body><form method="post">
    <input type="hidden" name="csrfmiddlewaretoken" value="CSRF123">
    <input type="time" name="form_submission_start" value="">
    <input type="time" name="form_submission_end" value="">
    <input type="hidden" name="deliver_unit-TOTAL_FORMS" value="${DUS.length}">
    <input type="hidden" name="deliver_unit-INITIAL_FORMS" value="${DUS.length}">
    <input type="hidden" name="deliver_unit-MIN_NUM_FORMS" value="0">
    <input type="hidden" name="deliver_unit-MAX_NUM_FORMS" value="1000">
    ${rows}
    <input type="hidden" name="form_json-TOTAL_FORMS" value="1">
    <input type="hidden" name="form_json-INITIAL_FORMS" value="0">
    <input type="hidden" name="form_json-MIN_NUM_FORMS" value="0">
    <input type="hidden" name="form_json-MAX_NUM_FORMS" value="1000">
  </form></body></html>`;
}

describe('parseDeliverUnitChecks (ace#2945)', () => {
  it('reads one entry per row: the SELECTED option of a disabled select, and the duration', () => {
    const checks = parseDeliverUnitChecks(page({ 7248: '6' }));
    expect(checks).toHaveLength(12);
    expect(checks[0]).toEqual({ deliver_unit_id: 7248, duration_minutes: 6 });
    expect(checks.slice(1).every((c) => c.duration_minutes === 0)).toBe(true);
    // Each row its own unit — not the first or last option of the list.
    expect(checks.map((c) => c.deliver_unit_id)).toEqual(DUS);
  });

  it('a blank duration reads as 0; a row with no selected unit and the __prefix__ row are skipped', () => {
    const html = `
      ${duRow(0, 7250, '')}
      <select name="deliver_unit-1-deliver_unit" disabled><option value="">---------</option><option value="7251">U</option></select>
      <input type="number" name="deliver_unit-1-duration" value="9">
      <select name="deliver_unit-__prefix__-deliver_unit"><option value="7252" selected>U</option></select>`;
    expect(parseDeliverUnitChecks(html)).toEqual([{ deliver_unit_id: 7250, duration_minutes: 0 }]);
  });

  it('returns [] for a page with no deliver_unit formset', () => {
    expect(parseDeliverUnitChecks('<form></form>')).toEqual([]);
  });
});

describe('durationMismatches (ace#2945)', () => {
  const persisted = [
    { deliver_unit_id: 7248, duration_minutes: 6 },
    { deliver_unit_id: 7249, duration_minutes: 0 },
  ];
  it('is empty when every requested floor read back', () => {
    expect(durationMismatches([{ deliver_unit_id: 7248, duration_minutes: 6 }, { deliver_unit_id: 7249 }], persisted)).toEqual([]);
  });
  it('names a wrong value and a unit with no row', () => {
    expect(
      durationMismatches(
        [{ deliver_unit_id: 7249, duration_minutes: 5 }, { deliver_unit_id: 9999, duration_minutes: 3 }],
        persisted,
      ),
    ).toEqual([
      { deliver_unit_id: 7249, requested_minutes: 5, persisted_minutes: 0 },
      { deliver_unit_id: 9999, requested_minutes: 3, persisted_minutes: null },
    ]);
  });
});

// ---- backend harness ----
function makeRequest(scripted: Array<{ status: number; body: string }>, posts: Array<Record<string, string>>): APIRequestContext {
  let i = 0;
  const respond = (n: { status: number; body: string }) =>
    ({ status: () => n.status, headers: () => ({}), text: async () => n.body }) as unknown as APIResponse;
  return {
    get: async () => respond(scripted[i++]),
    post: async (_url: string, init?: { form?: Record<string, string> }) => {
      posts.push(init?.form ?? {});
      return respond(scripted[i++]);
    },
  } as unknown as APIRequestContext;
}
const backend = (request: APIRequestContext) =>
  new PlaywrightBackend({ baseUrl: 'https://connect.example', csrfToken: 'CSRF123', request });
const ARGS = {
  organization_slug: 'ace-pm-org',
  opportunity_id: '30605010-4be8-49e3-954c-deeb0b4ad8d6',
  flags: { deliver_unit_checks: [{ deliver_unit_id: 7248, duration_minutes: 6 }] },
};

describe('setVerificationFlags returns the duration read-back (ace#2945)', () => {
  it('returns deliver_unit_checks from the post-write GET when the floor persisted', async () => {
    const posts: Array<Record<string, string>> = [];
    const req = makeRequest([{ status: 200, body: page() }, { status: 302, body: '' }, { status: 200, body: page({ 7248: '6' }) }], posts);
    const res = await backend(req).setVerificationFlags(ARGS);
    expect(posts[0]['deliver_unit-0-duration']).toBe('6');
    expect(res.ok).toBe(true);
    expect(res.deliver_unit_checks?.[0]).toEqual({ deliver_unit_id: 7248, duration_minutes: 6 });
    expect(res.deliver_unit_checks).toHaveLength(12);
  });

  it('throws a typed error when the requested floor does not read back', async () => {
    const posts: Array<Record<string, string>> = [];
    const req = makeRequest([{ status: 200, body: page() }, { status: 302, body: '' }, { status: 200, body: page() }], posts);
    const err = await backend(req).setVerificationFlags(ARGS).catch((e) => e);
    expect(err).toBeInstanceOf(VerificationDurationNotPersistedError);
    expect(err.toJSON()).toMatchObject({
      error: 'verification_duration_not_persisted',
      mismatches: [{ deliver_unit_id: 7248, requested_minutes: 6, persisted_minutes: 0 }],
    });
  });

  it('a read-back that cannot run stays diagnostic: ok with deliver_unit_checks undefined', async () => {
    const posts: Array<Record<string, string>> = [];
    const req = makeRequest([{ status: 200, body: page() }, { status: 302, body: '' }, { status: 500, body: '' }], posts);
    const res = await backend(req).setVerificationFlags(ARGS);
    expect(res.ok).toBe(true);
    expect(res.deliver_unit_checks).toBeUndefined();
  });
});
