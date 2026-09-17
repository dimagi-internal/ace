/**
 * Scan a deck's `ace_stencil_*` pages for builder/template placeholder drift,
 * and optionally repair it in place.
 *
 * ## Why this exists (dimagi-internal/ace#2429)
 *
 * The rendered deck's text does not arrive with the template copy — the copy is
 * BARE stencils, and every value is substituted by `replaceAllText`. So the
 * live template and `lib/training-deck-spec.ts` are two halves of one contract
 * kept in different places, and they drift both ways. `unmatchedReplacements`
 * only reports tokens the builder TRIED to replace, so it is structurally blind
 * to a token the builder has STOPPED emitting: `poverty-graduation/20260915-1518`
 * rendered 281 requests / 281 replies / 0 unmatched while shipping a literal
 * `{{DURATION}}` on all 13 of its exercise slides.
 *
 * This is the check at the one point where both halves are in hand: the copied
 * deck, read back, compared against `STENCIL_PLACEHOLDERS`. The comparison
 * itself is pure and unit-tested in `lib/stencil-token-drift.ts`; this file is
 * only the Slides round-trip around it.
 *
 * ## Repair
 *
 * `--repair` reconciles each drifted stencil page to
 * `lib/training-deck-stencil-geometry.ts` IN PLACE: delete every text-bearing
 * shape on the page, then re-layer that stencil's builder output. That is
 * exactly what `scripts/bootstrap-training-deck-template.ts` step 4 does per
 * page, so the repaired page is equivalent to a fresh mint's — but the
 * presentationId does not change, so `ACE_TRAINING_DECK_TEMPLATE_ID` needs no
 * rotation in 1Password and no `/ace:setup --force-env` + restart. Chrome (the
 * accent bar, right rule and corner mark) is not text-bearing and is left
 * untouched.
 *
 * Usage:
 *   # gate — exit 1 on drift (what training-deck-render runs)
 *   npx tsx scripts/check-stencil-token-drift.ts --deck <presentationId>
 *
 *   # operator repair of the live template, same id. `--deck` defaults to
 *   # ACE_TRAINING_DECK_TEMPLATE_ID read from <plugin-data>/.env — do NOT
 *   # interpolate that var in the shell, it expands to EMPTY there (ace#1147).
 *   npx tsx scripts/check-stencil-token-drift.ts --repair
 *
 *   [--key <gws-sa-key.json>] [--json]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { google } from '../lib/google-shim.js';
import { STENCILS, STENCIL_PLACEHOLDERS, type StencilKey } from '../lib/training-deck-spec.js';
import { STENCIL_TEXT_BUILDERS } from '../lib/training-deck-stencil-geometry.js';
import {
  scanStencilTokenDrift,
  formatStencilTokenDrift,
  type StencilPageText,
} from '../lib/stencil-token-drift.js';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';
import { loadPluginEnv } from '../lib/load-plugin-env.js';

// ace#1964 — a script reached from a Bash tool call inherits NONE of ACE's
// secrets, so it has to load `<plugin-data>/.env` itself. Module top, before
// any credential read. This is also what makes `--deck` defaultable below:
// `$ACE_TRAINING_DECK_TEMPLATE_ID` expands to EMPTY in a Bash tool call
// (ace#1147), so an operator command that interpolates it in the shell sends
// an empty id. Reading it here, after the .env load, is the correct place.
loadPluginEnv(import.meta.url);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  deck: string;
  key?: string;
  repair: boolean;
  json: boolean;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const args: Record<string, string> = {};
  let repair = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repair') { repair = true; continue; }
    if (argv[i] === '--json') { json = true; continue; }
    const m = argv[i].match(/^--(deck|template|key)$/);
    if (!m) throw new Error(`unknown argument: ${argv[i]}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for --${m[1]}`);
    }
    // --template is an alias for --deck: the gate runs against the COPY, the
    // operator repair runs against the TEMPLATE, and they are the same call.
    args[m[1] === 'template' ? 'deck' : m[1]] = value;
    i++;
  }
  // Defaulting to the live template is what makes the operator repair command
  // safe to paste: interpolating $ACE_TRAINING_DECK_TEMPLATE_ID in the shell
  // would send an EMPTY id, because ACE's env lives in <plugin-data>/.env and
  // is loaded into MCP subprocesses, not into the calling shell (ace#1147).
  const deck = args.deck || env.ACE_TRAINING_DECK_TEMPLATE_ID || '';
  if (!deck) {
    throw new Error(
      '--deck (or --template) is required, and ACE_TRAINING_DECK_TEMPLATE_ID is not ' +
        'set in the environment or in <plugin-data>/.env.\n' +
        'Usage: npx tsx scripts/check-stencil-token-drift.ts [--deck <presentationId>] ' +
        '[--repair] [--json] [--key <sa-key.json>]',
    );
  }
  return { deck, key: args.key, repair, json };
}

function resolveKeyFile(cliKey: string | undefined): string {
  if (cliKey) {
    if (!fs.existsSync(cliKey)) throw new Error(`--key file not found: ${cliKey}`);
    return cliKey;
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const dataDir = resolvePluginDataDir(import.meta.url);
  if (dataDir) {
    const derived = path.join(dataDir, 'gws-sa-key.json');
    if (fs.existsSync(derived)) return derived;
  }
  const conventional = path.join(os.homedir(), '.claude', 'plugins', 'data', 'ace-ace', 'gws-sa-key.json');
  if (fs.existsSync(conventional)) return conventional;
  throw new Error(
    'Cannot resolve the GWS service-account key: no --key given, no plugin data dir ' +
      `resolvable, and ${conventional} does not exist. Pass --key <path-to-gws-sa-key.json>.`,
  );
}

// ---------------------------------------------------------------------------
// Slides round-trip
// ---------------------------------------------------------------------------

const GET_FIELDS = 'slides(objectId,pageElements(objectId,shape(text(textElements(textRun(content))))))';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Concatenate a shape's textRuns — a token may span runs after manual edits. */
function shapeText(el: any): string | null {
  const elements = el?.shape?.text?.textElements;
  if (!Array.isArray(elements)) return null;
  return elements.map((te: any) => te?.textRun?.content ?? '').join('');
}

/** Harvest per-shape text for every `ace_stencil_*` page present in the deck. */
export function harvestStencilPages(
  pres: any,
  stencilPageIds: ReadonlySet<string>,
): { pages: StencilPageText[]; textShapeIdsByPageId: Map<string, string[]> } {
  const pages: StencilPageText[] = [];
  const textShapeIdsByPageId = new Map<string, string[]>();
  for (const slide of pres?.data?.slides ?? []) {
    const pageId: string | undefined = slide?.objectId ?? undefined;
    if (!pageId || !stencilPageIds.has(pageId)) continue;
    const texts: string[] = [];
    const ids: string[] = [];
    for (const el of slide.pageElements ?? []) {
      const text = shapeText(el);
      if (text === null) continue;
      texts.push(text);
      if (el.objectId) ids.push(el.objectId);
    }
    pages.push({ pageId, texts });
    textShapeIdsByPageId.set(pageId, ids);
  }
  return { pages, textShapeIdsByPageId };
}

/**
 * Requests that reconcile ONE stencil page to the geometry builder: drop every
 * text-bearing shape, then re-layer the builder's boxes. Delete-before-create
 * matters — the builder's ids (`<pageId>_title`, …) are the ones already on the
 * page, and Slides applies requests in order.
 */
export function repairRequests(
  stencil: StencilKey,
  pageId: string,
  textShapeIds: readonly string[],
): Record<string, unknown>[] {
  return [
    ...textShapeIds.map((objectId) => ({ deleteObject: { objectId } })),
    ...STENCIL_TEXT_BUILDERS[stencil](pageId),
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const keyFile = resolveKeyFile(cli.key);

  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/presentations',
    ],
  });
  const slides = google.slides({ version: 'v1', auth });
  const stencilPageIds = new Set<string>(Object.values(STENCILS));

  const pres = await slides.presentations.get({ presentationId: cli.deck, fields: GET_FIELDS });
  const { pages, textShapeIdsByPageId } = harvestStencilPages(pres, stencilPageIds);
  let report = scanStencilTokenDrift(pages, STENCILS, STENCIL_PLACEHOLDERS);

  if (!cli.json) console.log(formatStencilTokenDrift(report));

  if (cli.repair && report.findings.length) {
    const requests: Record<string, unknown>[] = [];
    for (const finding of report.findings) {
      const stencil = finding.stencil as StencilKey;
      if (!STENCIL_TEXT_BUILDERS[stencil]) {
        throw new Error(`no text builder for stencil "${stencil}" — cannot repair`);
      }
      requests.push(
        ...repairRequests(stencil, finding.pageId, textShapeIdsByPageId.get(finding.pageId) ?? []),
      );
    }
    console.log(`\nrepairing ${report.findings.length} stencil page(s): ${requests.length} requests`);
    await slides.presentations.batchUpdate({ presentationId: cli.deck, requestBody: { requests } });

    // Read back — the repair is not "the batch returned 200", it is "the page
    // no longer drifts". Same class as verifyLookupBind: prove the write.
    const after = await slides.presentations.get({ presentationId: cli.deck, fields: GET_FIELDS });
    report = scanStencilTokenDrift(
      harvestStencilPages(after, stencilPageIds).pages,
      STENCILS,
      STENCIL_PLACEHOLDERS,
    );
    console.log(`\nafter repair: ${formatStencilTokenDrift(report)}`);
  }

  if (cli.json) console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

// Only run when executed directly, so the helpers above stay unit-testable.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;

if (invokedDirectly) {
  main().catch((e: { message: string; response?: { data?: unknown } }) => {
    console.error('FAILED:', e.message);
    if (e.response?.data) console.error('  response:', JSON.stringify(e.response.data, null, 2));
    process.exit(2);
  });
}
