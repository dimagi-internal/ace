/**
 * dimagi-internal/ace#1637 — an unread field must not read as an absent one.
 *
 * `total_budget`, `start_date` and `program_name` are read ONLY off the
 * opportunity dashboard (the edit form carries none of them), and each degrades
 * to `undefined` when its card is absent. So two very different facts arrived
 * at the caller as identical bytes:
 *
 *   - "this opportunity is in no program / states no budget"  (absent)
 *   - "we could not read the page that would have told us"    (unread)
 *
 * `connect-program-setup § Step 4a` sums `total_budget` over a program's opps to
 * size the shared ceiling, and treated the second as the first. On
 * `bednet-check-2-visit/20260825-1310` 16 of 81 hydrated `ai-demo-space` rows
 * came back with the LIST-page key set only — two of them prior runs of the very
 * program being sized — so Σ went UNKNOWN and the unconditional conservative
 * raise fired, taking a live LLO-facing ceiling from 19,400 to 64,400 against a
 * known consumption of 4,062. On every run, forever, because the raise was
 * expressed relative to the CURRENT ceiling and so was not idempotent.
 *
 * This test pins both halves: the classifier that makes the distinction
 * decidable, and the Step 4a text that must consume it.
 *
 * NOT pinned, because we do not know it: WHY those 16 rows render no cards.
 * `active` is correlated but demonstrably not causal (5 inactive rows DO carry
 * the fields). That needs the live surface and is left open on the issue.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  classifyDashboardRead,
  parseOpportunityDashboard,
} from '../../../../mcp/connect/backends/html-scrape.js';

const dashboardHtml = readFileSync(
  fileURLToPath(new URL('../../../fixtures/connect-opportunity-dashboard.html', import.meta.url)),
  'utf8',
);

/**
 * A dashboard that rendered its shell and its infocards, but genuinely states
 * no program and no budget. `safe_display` renders a missing value as the
 * literal "---", which the parser already maps to `undefined`. This is the row
 * whose `undefined` is a FACT, and it must classify `ok`.
 */
const NO_PROGRAM_NO_BUDGET = `
<h1 class="text-2xl font-medium block">Standalone Pilot</h1>
<p class="text-sm">A one-off opportunity attached to no program.</p>
<span class="badge badge-md">Inactive</span>
<div class="basic_details">
  <h6>Delivery Type</h6><p>Household visit</p>
  <h6>Start Date</h6><p>---</p>
  <h6>End Date</h6><p>2026-10-09</p>
  <h6>Max Budget</h6><p>---</p>
</div>`;

/**
 * The observed defect shape: a body that renders as an opportunity page but
 * carries no infocard block at all, so Max Budget / Start Date were never on
 * the page to be read. Reproduced structurally rather than captured, per
 * CLAUDE.md § close the loop to the source of truth — the parser's dependency
 * is the `<h6>label</h6><p>value</p>` block, so its absence is the fact under
 * test, and a capture would only show one page's version of it.
 */
const NO_CARDS = `
<h1 class="text-2xl font-medium block">20260820-0832 · Bednet Check — Two-Visit Household Follow-Up</h1>
<p class="text-sm">Two-visit bednet check: register, then follow up</p>`;

describe('classifyDashboardRead (ace#1637)', () => {
  it("says ok for a real dashboard, so its undefined fields can be read as absent", () => {
    expect(classifyDashboardRead(dashboardHtml)).toBe('ok');
  });

  it('says ok for a dashboard that renders "---" for program and budget', () => {
    expect(classifyDashboardRead(NO_PROGRAM_NO_BUDGET)).toBe('ok');
    // And the parse agrees the fields are genuinely absent, which is the
    // combination Step 4a excludes from Σ rather than calling unknown.
    const d = parseOpportunityDashboard(NO_PROGRAM_NO_BUDGET);
    expect(d.program_name).toBeUndefined();
    expect(d.total_budget).toBeUndefined();
  });

  it('says no_cards when the infocard block that carries Max Budget is absent', () => {
    expect(classifyDashboardRead(NO_CARDS)).toBe('no_cards');
    // Same `undefined` as the row above — which is the entire point. Without
    // the marker these two rows are indistinguishable to Step 4a.
    const d = parseOpportunityDashboard(NO_CARDS);
    expect(d.total_budget).toBeUndefined();
    expect(d.program_name).toBeUndefined();
  });

  it('says not_a_dashboard for a body that is not an opportunity page', () => {
    expect(classifyDashboardRead('<html><body>Server error</body></html>')).toBe('not_a_dashboard');
  });

  it('says not_fetched when the detail page did not return a body', () => {
    expect(classifyDashboardRead('')).toBe('not_fetched');
    expect(classifyDashboardRead(undefined)).toBe('not_fetched');
    expect(classifyDashboardRead(null)).toBe('not_fetched');
  });
});

describe('connect-program-setup § Step 4a consumes the marker (ace#1637)', () => {
  const skill = readFileSync(
    fileURLToPath(new URL('../../../../skills/connect-program-setup/SKILL.md', import.meta.url)),
    'utf8',
  );
  const process = skill.slice(0, skill.search(/^## Change Log\s*$/m));

  it('splits rows on dashboard_read rather than on a missing program_name', () => {
    expect(
      /dashboard_read/.test(process),
      'Step 4a must branch on `dashboard_read` — a missing `program_name` on a ' +
        'readable dashboard is a FACT (exclude the row) and on an unreadable one ' +
        'is an UNKNOWN (ace#1637).',
    ).toBe(true);
  });

  it('does not raise the ceiling relative to the current budget when Σ is unknown', () => {
    // The non-idempotent form. `program.budget + EXPECTED_OPP_BUDGET × 10`
    // compounds on every run of every opp sharing the program, purely because
    // a read failed — 19,400 → 64,400 on one run against 4,062 consumed.
    const relativeRaises = [
      ...process.matchAll(/program\.budget\s*\+\s*\n?\s*`?EXPECTED_OPP_BUDGET/g),
    ].map((m) => m[0]);
    // Exactly one survives, and only inside the `listing.complete !== true`
    // carve-out, where the row count itself is unknown so no bound exists.
    expect(
      relativeRaises.length,
      'The Σ-unknown raise must compute an absolute TARGET from knownΣ + ' +
        'unreadable_rows × EXPECTED_OPP_BUDGET + headroom, and raise only if the ' +
        'ceiling is below it. A raise relative to `program.budget` is not ' +
        'idempotent (ace#1637). The single permitted survivor is the ' +
        '`listing.complete !== true` fallback.',
    ).toBe(1);
    const idx = process.search(/program\.budget\s*\+\s*\n?\s*`?EXPECTED_OPP_BUDGET/);
    expect(
      /listing\.complete/.test(process.slice(Math.max(0, idx - 600), idx + 300)),
      'The surviving relative raise must be the listing-incomplete fallback.',
    ).toBe(true);
  });

  it('states the absolute target formula', () => {
    expect(/unreadable_rows\s*×\s*EXPECTED_OPP_BUDGET/.test(process)).toBe(true);
    expect(/program\.budget\s*<\s*target/.test(process)).toBe(true);
  });
});
