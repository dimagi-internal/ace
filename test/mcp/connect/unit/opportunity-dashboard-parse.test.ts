/**
 * dimagi-internal/ace#1461 — viewer-tier opportunity read.
 *
 * `getOpportunity` hydrated metadata exclusively from the `/edit` form, which
 * upstream guards with `org_member_required` and which raises `Http404` (not
 * 403) for a viewer. So a pure READ hard-failed 404 for an account that can
 * see the opportunity fine in a browser — blocking the Connect Interviews
 * automation, which was deliberately designed to hold read-only access to the
 * real org.
 *
 * The fixture's shape comes from the Django template and view
 * (`opportunity/dashboard.html`, `OpportunityDashboard.get_context_data`),
 * not from a single live capture — the source says what every page always
 * renders, where a capture says what one page looked like once.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseOpportunityDashboard } from '../../../../mcp/connect/backends/html-scrape.js';

const html = readFileSync(
  fileURLToPath(new URL('../../../fixtures/connect-opportunity-dashboard.html', import.meta.url)),
  'utf8',
);

describe('parseOpportunityDashboard (#1461)', () => {
  it('reads the fields the dashboard actually renders', () => {
    const d = parseOpportunityDashboard(html);
    expect(d.name).toBe('ANC Follow-up Round 3');
    expect(d.program_name).toBe('Maternal Health Interviews');
    expect(d.description).toContain('Structured follow-up interviews');
    expect(d.delivery_type).toBe('Household Visit');
    expect(d.start_date).toBe('2026-07-01');
    expect(d.end_date).toBe('2026-12-31');
    expect(d.is_test).toBe(false);
  });

  it('decodes HTML entities rather than leaking &amp;', () => {
    // The description contains "danger signs & referral uptake".
    const d = parseOpportunityDashboard(html);
    expect(d.description).toContain('&');
    expect(d.description).not.toContain('&amp;');
  });

  it('strips the tooltip span that wraps three of the six infocards', () => {
    // header_with_tooltip renders <span x-data x-tooltip.raw="...">VALUE</span>,
    // so reading the <p> raw would yield markup, not a number.
    const d = parseOpportunityDashboard(html);
    expect(d.max_workers).toBe(250);
    expect(d.max_deliveries).toBe(5000);
  });

  it('splits "USD 1,250,000" into currency and a comma-free budget', () => {
    const d = parseOpportunityDashboard(html);
    expect(d.currency).toBe('USD');
    expect(d.total_budget).toBe('1250000');
  });

  it('surfaces start_date and total_budget, which the EDIT form does not carry', () => {
    // The one place the viewer-tier read beats the write-tier one.
    const d = parseOpportunityDashboard(html);
    expect(d.start_date).toBeTruthy();
    expect(d.total_budget).toBeTruthy();
  });

  it('leaves short_description and country undefined — they are not on this page', () => {
    const d = parseOpportunityDashboard(html) as Record<string, unknown>;
    expect(d.short_description).toBeUndefined();
    expect(d.country).toBeUndefined();
  });

  describe('the three-way status badge', () => {
    it('Active -> active true', () => {
      expect(parseOpportunityDashboard(html).status_badge).toBe('Active');
      expect(parseOpportunityDashboard(html).active).toBe(true);
    });

    it('Ended ALSO means the active field is true (the lossy bit)', () => {
      // Template: {% elif object.active and has_ended %} -> "Ended". An ended
      // opportunity is still active:true in the database. Mapping Ended->false
      // would silently contradict the edit-form read.
      const ended = html.replace(
        '<span class="badge badge-md positive-dark">Active</span>',
        '<span class="badge badge-md warning-dark">Ended</span>',
      );
      const d = parseOpportunityDashboard(ended);
      expect(d.status_badge).toBe('Ended');
      expect(d.active).toBe(true);
    });

    it('Inactive -> active false, with the raw badge kept because it is ambiguous', () => {
      // Inactive is produced by active=False, by archived, AND by a null
      // end_date. status_badge is returned so a caller can see the real signal.
      const inactive = html.replace(
        '<span class="badge badge-md positive-dark">Active</span>',
        '<span class="badge badge-md negative-dark">Inactive</span>',
      );
      const d = parseOpportunityDashboard(inactive);
      expect(d.status_badge).toBe('Inactive');
      expect(d.active).toBe(false);
    });
  });

  it('treats safe_display\'s "---" as absent, not as the literal string', () => {
    const missing = html.replace('<p>2026-07-01</p>', '<p>---</p>');
    expect(parseOpportunityDashboard(missing).start_date).toBeUndefined();
  });

  it('degrades to undefined on an unexpected budget shape rather than guessing a number', () => {
    const weird = html.replace('USD 1,250,000', 'budget unavailable');
    const d = parseOpportunityDashboard(weird);
    expect(d.currency).toBeUndefined();
    expect(d.total_budget).toBeUndefined();
    // ...and the rest of the parse still succeeds.
    expect(d.name).toBe('ANC Follow-up Round 3');
  });

  it('returns an empty object on unrelated HTML instead of throwing', () => {
    expect(parseOpportunityDashboard('<html><body>nope</body></html>')).toEqual({});
  });

  it('reads is_test true when the opportunity is a test opp', () => {
    const test = html.replace('{isTest: false,', '{isTest: true,');
    expect(parseOpportunityDashboard(test).is_test).toBe(true);
  });
});
