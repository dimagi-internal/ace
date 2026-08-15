#!/usr/bin/env npx tsx
/**
 * The RENDERED half of the external-review-surface audit.
 *
 *   npx tsx scripts/audit-run-surface-render.ts <summary-page-url>
 *
 * Prints one JSON `RenderReport` (see `lib/run-surface-audit.ts`) on stdout.
 * Spawned by `scripts/audit-run-surface.ts --render`; runnable standalone for
 * debugging.
 *
 * ── Why a browser at all ──────────────────────────────────────────────
 *
 * Four of the twelve defects found on `spark-facilitator/20260813-2126` are
 * **structurally invisible to a payload check**, and each of them shipped:
 *
 *   9.  editing a decision required pick → name → Save on EVERY row, where the
 *       Workbench commits on click. Caught only by a human comparing the two by
 *       eye.
 *   10. decisions were grouped by phase only inside a COLLAPSED disclosure, so
 *       where a decision came from was invisible by default.
 *   5.  (its rendered face) the page said walkthroughs and dashboards were "Not
 *       created" while both existed.
 *       — plus "can a partner actually respond?", which is the point of the
 *       surface and which no static read can answer.
 *
 * ── Posture ───────────────────────────────────────────────────────────
 *
 * **Anonymous.** A brand-new incognito-equivalent context per run: no storage
 * state, no cookies, no PAT. A member sees a different document.
 *
 * **Non-destructive.** It never clicks an option pill (in `immediate` commit
 * mode a pill click IS a durable write into a real opp's Drive folder) and never
 * submits a comment. The write paths are proven live by sending a deliberately
 * INVALID body and asserting the handler rejects it on validation — a 422 means
 * the route exists, is wired, and is reachable anonymously; a 404/405/5xx means
 * a partner cannot respond. Nothing is written either way. The end-to-end write
 * ROUND-TRIP belongs in ace-web's own hermetic suite against a fake Drive, not
 * against a partner's real run.
 *
 * ── Failing loudly ────────────────────────────────────────────────────
 *
 * Every check reports `true`, `false`, or `null`. `null` means "the probe could
 * not find what it was looking for" and surfaces as an explicit
 * `RENDER-UNDETERMINED` finding — NEVER as a pass. Selectors drift; a probe that
 * silently returns "fine" when the markup moved is the exact failure this whole
 * capability exists to eliminate.
 */

import type { RenderReport } from '../lib/run-surface-audit.js';

/** Copy the page draws for a section it believes was never produced. */
const NOT_CREATED_TEXT = 'Not created';

/**
 * Where the reviewer identity is remembered (ace-web
 * `components/opps/decisions/reviewerIdentity.ts`).
 *
 * Seeding it is a CLIENT-ONLY write into localStorage — it touches nothing on
 * the server. It is how the probe reaches the state defect 9 is really about:
 * the surface legitimately stages the FIRST edit behind a Save (nobody knows
 * who is editing yet), and the bug was making that a per-surface constant so
 * every one of 42 rows kept the Save button after the name was known.
 */
const IDENTITY_KEYS = {
  name: 'ace.summary.reviewerName',
  email: 'ace.summary.reviewerEmail',
};

const PROBE_IDENTITY = { name: 'ACE surface audit (probe)', email: '' };

async function main(): Promise<void> {
  const pageUrl = process.argv[2];
  if (!pageUrl) throw new Error('usage: audit-run-surface-render.ts <summary-page-url> [<expected-phase-labels-json>]');
  // The phase labels the PAYLOAD says this run's decisions carry. Passed in by
  // the caller so the provenance check is keyed to the actual data rather than
  // to a regex guessing at the page's copy — a regex that guesses is how a
  // check ends up unable to see the thing it checks.
  const expectedPhaseLabels: string[] = process.argv[3] ? (JSON.parse(process.argv[3]) as string[]) : [];

  const undetermined: string[] = [];
  const report: RenderReport = {
    renderedHrefs: [],
    notCreatedLabels: [],
    decisionEditCommitsOnPick: null,
    provenanceVisibleByDefault: null,
    writePaths: { comment: null, edit: null },
    undetermined,
  };

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  // A genuinely fresh context: no storageState, no HTTP credentials, no
  // extraHTTPHeaders. Anything else makes this a member's test.
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 60_000 });

    // ── Rendered links ─────────────────────────────────────────────
    // Collected across EVERY tab and unioned. The summary is one document
    // split across an Overview and a Decisions tab; a first cut scraped only
    // the landing tab and reported the open-questions doc as never rendered
    // when it is rendered one tab over. "Not on the tab I happened to open" is
    // not "not on the page".
    const hrefs = new Set<string>(await collectHrefs(page));

    // ── "Not created" placeholders ─────────────────────────────────
    report.notCreatedLabels = await page.evaluate((needle) => {
      const out: string[] = [];
      document.querySelectorAll('span').forEach((el) => {
        if ((el.textContent ?? '').trim() !== needle) return;
        const label = el.parentElement?.querySelector('span')?.textContent?.trim();
        out.push(label || needle);
      });
      return out;
    }, NOT_CREATED_TEXT);

    // ── Decisions: provenance visible by default (defect 10) ───────
    const decisionsUrl = pageUrl.includes('?') ? `${pageUrl}&tab=decisions` : `${pageUrl}?tab=decisions`;
    const resp = await page.goto(decisionsUrl, { waitUntil: 'networkidle', timeout: 60_000 });
    for (const h of await collectHrefs(page)) hrefs.add(h);
    report.renderedHrefs = [...hrefs];
    if (!resp || !resp.ok()) {
      undetermined.push(`the decisions tab did not load (HTTP ${resp?.status() ?? 'none'}) — nothing about decisions was judged`);
    } else {
      // The phase heading is the ONLY thing that says where a call came from.
      // Judged on VISIBLE text with ZERO interaction: `innerText` excludes
      // anything a collapsed container has hidden, which is exactly the
      // distinction defect 10 turned on — the labels existed, in the DOM,
      // inside a disclosure that was shut.
      //
      // Keyed to the payload's OWN phase labels rather than to a pattern
      // guessing at the page's copy. A first cut used /Phase \d+ ·/ and
      // reported this page as hiding provenance when it renders
      // "PHASE 1 / Idea to Design" on a line break — a false positive is the
      // same class of failure as a false negative.
      const visible = (await page.locator('body').innerText()).replace(/\s+/g, ' ').toLowerCase();
      const hasAnyDecision = await page.locator('button[aria-expanded]').count();
      if (!hasAnyDecision) {
        undetermined.push('no decision rows were found on the decisions tab — provenance and edit affordance were not judged');
      } else if (!expectedPhaseLabels.length) {
        undetermined.push('no expected phase labels were supplied — whether provenance is visible by default was not judged');
      } else {
        const missing = expectedPhaseLabels.filter((l) => !visible.includes(l.toLowerCase()));
        report.provenanceVisibleByDefault = missing.length === 0;
        if (missing.length) {
          undetermined.push(`phase label(s) not visible without interaction: ${missing.join(', ')}`);
        }
      }

      // ── Decisions: does an edit commit on pick? (defect 9) ───────
      report.decisionEditCommitsOnPick = await probeCommitAffordance(page, decisionsUrl, undetermined);
    }

    // ── Write paths: reachable, without writing anything ───────────
    report.writePaths = await probeWritePaths(page, pageUrl, undetermined);
  } catch (e) {
    undetermined.push(`the browser probe failed part-way: ${String(e instanceof Error ? e.message : e)}`);
  } finally {
    await context.close();
    await browser.close();
  }

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

async function collectHrefs(page: import('playwright').Page): Promise<string[]> {
  return page.$$eval('a[href]', (as) => as.map((a) => (a as HTMLAnchorElement).href).filter(Boolean));
}

/**
 * Judge the PRIMARY pick affordance on a decision row.
 *
 * Returns `true` when picking an option commits as it happens (option pills
 * present, no per-row commit control gating them), `false` when a Save button
 * stands between the pick and the change, and `null` when the row could not be
 * reached — reported as undetermined, never as a pass.
 *
 * Deliberately does NOT click a pill: in `immediate` commit mode that click IS
 * a durable write into the run's real Drive folder. The affordance is judged
 * from the SHAPE of the controls, which is what the defect was about.
 *
 * Calibrated against the live page on 2026-08-14 rather than guessed from the
 * source: the pills are `button[aria-pressed]` (ace-web
 * `components/opps/decisions/OptionPills.tsx`), and the write-in path — which
 * legitimately keeps a Save, because free text has to be finished before it
 * means anything — is a separate control.
 */
async function probeCommitAffordance(
  page: import('playwright').Page,
  decisionsUrl: string,
  undetermined: string[],
): Promise<boolean | null> {
  try {
    // Client-only: teach the page who we are, so it is in the state a reviewer
    // is in after their first comment. No server call. This matters because the
    // surface legitimately stages the FIRST edit behind a Save (nobody knows
    // who is editing yet); the defect was making that a per-surface CONSTANT,
    // so all 42 rows kept the Save button after the name was known.
    await page.evaluate(
      ({ keys, id }) => {
        window.localStorage.setItem(keys.name, id.name);
        window.localStorage.setItem(keys.email, id.email);
      },
      { keys: IDENTITY_KEYS, id: PROBE_IDENTITY },
    );
    await page.goto(decisionsUrl, { waitUntil: 'networkidle', timeout: 60_000 });

    // Expand the first few phase groups, then the first row inside one.
    const groups = page.locator('section button[aria-expanded]');
    const groupCount = await groups.count();
    if (!groupCount) {
      undetermined.push('no expandable decision groups found — the pick affordance was not judged');
      return null;
    }
    for (let i = 0; i < Math.min(groupCount, 3); i++) {
      const g = groups.nth(i);
      if ((await g.getAttribute('aria-expanded')) === 'false') await g.click();
    }
    await page.waitForTimeout(400);

    const rows = page.locator('li button[aria-expanded]');
    const rowCount = await rows.count();
    if (!rowCount) {
      undetermined.push('no decision rows found inside the phase groups — the pick affordance was not judged');
      return null;
    }
    const row = rows.first();
    if ((await row.getAttribute('aria-expanded')) === 'false') await row.click();
    await page.waitForTimeout(400);

    const pills = page.locator('button[aria-pressed]');
    if (!(await pills.count())) {
      undetermined.push(
        'an expanded decision row offered no option pills (button[aria-pressed]) — the pick ' +
          'affordance was not judged. Check the selectors in ' +
          'scripts/audit-run-surface-render.ts against the current markup',
      );
      return null;
    }
    const save = page.getByRole('button', { name: /save this answer|^save$|saving/i });
    return (await save.count()) === 0;
  } catch (e) {
    undetermined.push(`the pick-affordance probe errored: ${String(e instanceof Error ? e.message : e)}`);
    return null;
  }
}

/**
 * Prove both public write paths are live, anonymously, WITHOUT writing.
 *
 * Sends a body the schema must reject (empty `comment` / empty `value`). A
 * 4xx-validation answer proves the route exists and reaches its handler; a 404
 * means the route is gone, a 405 means the method moved, a 5xx means it is
 * broken — all of which mean a partner cannot respond, which is the entire
 * point of this surface.
 *
 * `decision_id` is a sentinel that does not exist, so even a handler that
 * skipped validation has nothing to write against.
 */
async function probeWritePaths(
  page: import('playwright').Page,
  pageUrl: string,
  undetermined: string[],
): Promise<{ comment: number | null; edit: number | null }> {
  const m = pageUrl.match(/^(https?:\/\/[^/]+(?:\/[^/]+)?)\/opps\/([^/]+)\/([^/]+)\/runs\/([^/?#]+)\/summary/);
  if (!m) {
    undetermined.push(`could not derive the write-path URLs from ${pageUrl} — "can a partner respond?" was not judged`);
    return { comment: null, edit: null };
  }
  const [, base, ws, slug, runId] = m;
  const root = `${base}/api/opps/public/${ws}/${slug}/runs/${runId}/decisions/__ace-audit-probe__`;

  async function hit(url: string, body: Record<string, unknown>): Promise<number | null> {
    try {
      const r = await page.request.post(url, { data: body, failOnStatusCode: false, timeout: 30_000 });
      return r.status();
    } catch (e) {
      undetermined.push(`write-path probe to ${url} failed: ${String(e instanceof Error ? e.message : e)}`);
      return null;
    }
  }

  return {
    // Empty `comment` violates min_length=1 — rejected before any Drive call.
    comment: await hit(`${root}/reactions`, { reviewer: '', comment: '' }),
    // Empty `value` violates min_length=1 — same.
    edit: await hit(`${root}/edit`, { value: '' }),
  };
}

main().catch((e) => {
  // Even a total failure must produce a parseable report, so the caller
  // surfaces "not judged" rather than treating silence as clean.
  process.stdout.write(
    JSON.stringify({
      renderedHrefs: [],
      notCreatedLabels: [],
      decisionEditCommitsOnPick: null,
      provenanceVisibleByDefault: null,
      writePaths: { comment: null, edit: null },
      undetermined: [`the browser probe could not run: ${String(e instanceof Error ? e.message : e)}`],
    }) + '\n',
  );
  process.exit(0);
});
