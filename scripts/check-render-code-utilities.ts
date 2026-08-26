#!/usr/bin/env npx tsx
/**
 * Authoring-time Tailwind-utility lint for labs workflow `render_code`.
 *
 * WHY (ace#1662)
 * --------------
 * connect-labs purges its Tailwind bundle against its OWN Django templates.
 * A workflow's `render_code` lives in the labs database and is never
 * scanned, so any utility labs does not itself use is dropped from the
 * shipped bundle — and then fails SILENTLY, degrading to the unstyled
 * baseline: a missing `bg-*` is transparent, a missing `text-*` is the
 * inherited near-black, a missing `h-*` collapses to 0px.
 *
 * On `bednet-check-2-visit/20260825-1310`, `text-rose-700` styled
 * `consent 89.7% · below the 90% floor` — the only pay-affecting figure on
 * the LLO weekly-review dashboard — and had rendered near-black for an
 * unknown number of prior runs. Three of the five misses on that workflow
 * were PRE-EXISTING, not introduced by the edit that found them.
 *
 * Run this BEFORE `workflow_update_render_code` / `workflow_patch_render_code`.
 * A non-resolving utility is a pre-upload FAILURE, not a warning.
 *
 * METHOD NOTE — READ BEFORE CHANGING THIS
 * ---------------------------------------
 * This checks against the ENUMERATED CSS RULES of the deployed stylesheet,
 * never computed styles. `text-*` and `border-*` inherit `currentColor`, so
 * a computed-style probe returns a plausible colour for a utility that does
 * not exist and yields FALSE PASSES — which is exactly why this class of
 * defect survived visual inspection for months. Equally, a "no rendering
 * diff ⇒ missing" probe emits FALSE POSITIVES on `space-y-*` (targets
 * `:not(:last-child)`), `list-disc` (value is the CSS initial) and
 * `mx-auto` (computes to `0px` on a full-width block). Enumeration is the
 * only signal that is right in both directions.
 *
 * Usage:
 *   npx tsx scripts/check-render-code-utilities.ts <render-code-path> [options]
 *
 *   <render-code-path>     File holding the render_code source about to be
 *                          uploaded. For a patch, lint the FULL post-patch
 *                          source (fetch via `workflow_get`, apply the patch
 *                          locally, lint that) — a patch hunk alone cannot
 *                          see a pre-existing miss, and pre-existing misses
 *                          were 3 of the 5 real ones.
 *
 *   --labs-url <base>      Labs deployment to read the stylesheet from.
 *                          Default $LABS_BASE_URL or
 *                          https://labs.connect.dimagi.com
 *   --run-url <url>        Also discover stylesheets from this page (a
 *                          workflow run deep-link). Unauthenticated fetches
 *                          usually redirect to the login page, which links
 *                          the same hashed bundle — that is fine.
 *   --stylesheet <ref>     Use this stylesheet URL or local path instead of
 *                          discovering one. Repeatable.
 *   --substitute           Print the ranked resolving near-neighbours per
 *                          miss, as a paste-ready mapping block.
 *   --verbose              Also list every PRESENT utility.
 *   --min-classes <n>      Refuse to lint if the enumeration has fewer than
 *                          this many class selectors (default 200). Guards
 *                          against linting against a partial stylesheet.
 *   --json <path>          Write the full machine-readable report here.
 *
 * Exit codes:
 *   0  every utility resolves
 *   1  at least one utility does not resolve  (do NOT upload)
 *   2  could not resolve a stylesheet, or a usage error
 *
 * Exit 2 is deliberately distinct from exit 1: a stylesheet that failed to
 * load makes EVERY utility look missing, and reporting that as a lint
 * failure would train readers to ignore the lint.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  classifyUtilities,
  extractStylesheetHrefs,
  renderResolutionReport,
} from '../lib/tailwind-utility-resolution.js';

const DEFAULT_LABS_URL = process.env.LABS_BASE_URL || 'https://labs.connect.dimagi.com';

interface Args {
  sourcePath: string;
  labsUrl: string;
  runUrls: string[];
  stylesheets: string[];
  substitute: boolean;
  verbose: boolean;
  minClasses: number;
  jsonOut?: string;
}

function usage(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    'usage: npx tsx scripts/check-render-code-utilities.ts <render-code-path>\n' +
      '         [--labs-url <base>] [--run-url <url>] [--stylesheet <url-or-path>]\n' +
      '         [--substitute] [--verbose] [--min-classes <n>] [--json <path>]',
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    sourcePath: '',
    labsUrl: DEFAULT_LABS_URL,
    runUrls: [],
    stylesheets: [],
    substitute: false,
    verbose: false,
    minClasses: 200,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--labs-url') args.labsUrl = argv[++i] ?? usage('--labs-url needs a value');
    else if (a === '--run-url') args.runUrls.push(argv[++i] ?? usage('--run-url needs a value'));
    else if (a === '--stylesheet') args.stylesheets.push(argv[++i] ?? usage('--stylesheet needs a value'));
    else if (a === '--substitute') args.substitute = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--min-classes') args.minClasses = Number(argv[++i] ?? usage('--min-classes needs a value'));
    else if (a === '--json') args.jsonOut = argv[++i] ?? usage('--json needs a value');
    else if (a === '--help' || a === '-h') usage();
    else if (a.startsWith('-')) usage(`unknown flag ${a}`);
    else if (!args.sourcePath) args.sourcePath = a;
    else usage('exactly one render-code path is accepted');
  }
  if (!args.sourcePath) usage('a render-code path is required');
  return args;
}

async function fetchText(url: string, what: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${what} ${url} -> HTTP ${res.status}`);
  return await res.text();
}

/**
 * Pages that link the full Tailwind bundle without authentication.
 *
 * `/labs/workflow/` answers 200 to an anonymous request and carries the
 * hashed bundle. `/accounts/login/` answers 404 but its Django error
 * template extends the same base, so it links the same bundle — which is
 * why a non-2xx body is still accepted here as a DISCOVERY source. The
 * stylesheet fetches themselves must be 200.
 */
const DISCOVERY_PATHS = ['/labs/workflow/', '/accounts/login/'];

async function loadStylesheets(args: Args): Promise<{ css: string; sources: string[] }> {
  const chunks: string[] = [];
  const sources: string[] = [];

  if (args.stylesheets.length > 0) {
    for (const ref of args.stylesheets) {
      if (/^https?:\/\//i.test(ref)) {
        chunks.push(await fetchText(ref, 'stylesheet'));
      } else {
        chunks.push(fs.readFileSync(path.resolve(ref), 'utf8'));
      }
      sources.push(ref);
    }
    return { css: chunks.join('\n'), sources };
  }

  const pages = [
    ...args.runUrls,
    ...DISCOVERY_PATHS.map((p) => new URL(p, args.labsUrl).toString()),
  ];
  const hrefs = new Set<string>();
  const pageErrors: string[] = [];
  for (const page of pages) {
    try {
      const res = await fetch(page, { redirect: 'follow' });
      const html = await res.text();
      for (const href of extractStylesheetHrefs(html, res.url || page)) hrefs.add(href);
    } catch (err) {
      pageErrors.push(`${page}: ${(err as Error).message}`);
    }
  }
  if (hrefs.size === 0) {
    throw new Error(
      `no stylesheets discovered from ${pages.join(', ')}` +
        (pageErrors.length ? ` (${pageErrors.join('; ')})` : '') +
        ' — pass --stylesheet explicitly rather than linting against an empty enumeration',
    );
  }
  for (const href of hrefs) {
    chunks.push(await fetchText(href, 'stylesheet'));
    sources.push(href);
  }
  return { css: chunks.join('\n'), sources };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let source: string;
  try {
    source = fs.readFileSync(path.resolve(args.sourcePath), 'utf8');
  } catch (err) {
    console.error(`error: cannot read render_code at ${args.sourcePath}: ${(err as Error).message}`);
    process.exit(2);
  }

  let css: string;
  let sources: string[];
  try {
    ({ css, sources } = await loadStylesheets(args));
  } catch (err) {
    // Exit 2, never 1: an unreadable stylesheet makes everything look
    // missing, and a lint that cries wolf gets ignored.
    console.error(`error: could not load the deployed stylesheet — ${(err as Error).message}`);
    console.error('       NOT reporting utilities as missing; the enumeration would be empty.');
    process.exit(2);
  }

  const report = classifyUtilities(source, css);

  if (report.stylesheetClassCount < args.minClasses) {
    // A partial enumeration (e.g. only the pre-login sheet, because an
    // authenticated run URL bounced to the marketing page) makes every real
    // utility look missing. Refuse rather than emit a wall of false
    // positives — the deployed bundle carries thousands of classes.
    console.error(
      `error: the stylesheet(s) enumerated only ${report.stylesheetClassCount} class selectors ` +
        `(floor ${args.minClasses}) — refusing to lint against a partial enumeration.`,
    );
    console.error(`       stylesheets read: ${sources.join(', ')}`);
    process.exit(2);
  }

  console.log(renderResolutionReport(report, { verbose: args.verbose, sourceLabel: args.sourcePath }));
  console.log('');
  console.log(`stylesheets: ${sources.join(', ')}`);

  if (args.substitute && report.missing.length > 0) {
    console.log('');
    console.log('substitutions (best first; empty means no safe near-neighbour):');
    for (const f of report.missing) {
      console.log(`  ${f.token}  ->  ${(f.substitutions ?? []).join('  |  ') || '(use an inline style prop)'}`);
    }
  }

  if (args.jsonOut) {
    fs.writeFileSync(path.resolve(args.jsonOut), JSON.stringify({ ...report, stylesheets: sources }, null, 2));
    console.log(`\nwrote ${args.jsonOut}`);
  }

  process.exit(report.missing.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
