/**
 * scripts/run-form-walk.ts — walk a released CCZ and emit a structured
 * field inventory for every form.
 *
 * Background: the `app-multimedia-coverage` SKILL needs per-form
 * metadata (form_unique_id + each visible field's id, kind, label,
 * options) to drive the LLM judge that decides which fields get an
 * attached image. The previous approach was inline `npx tsx -e "..."`
 * scripts during the live skill drive, which is brittle and not
 * reusable. This wrapper packages that walk into a real CLI plus an
 * exported pure function (`walkFormFields`) that the unit tests can
 * exercise without live CCHQ.
 *
 * Read-only: never mutates app state. Authenticates via the existing
 * CommCare backend (same pattern as `scripts/probe-multimedia-upload.ts`).
 *
 * Usage:
 *   npx tsx scripts/run-form-walk.ts <domain> <app_id> [--build-id <hex>] [--out <path>]
 *
 * Output (JSON, to stdout or --out):
 *   {
 *     "domain": "...",
 *     "app_id": "...",
 *     "build_id": "..." | null,
 *     "forms": [
 *       {
 *         "module": 0,
 *         "form": 0,
 *         "form_unique_id": "<32-hex>" | null,
 *         "form_path": "modules-0/forms-0.xml",
 *         "fields": [
 *           { "field_id": "...", "kind": "label|text|int|single_select|multi_select|date|geo|trigger|unknown", "label": "<text>", "options": ["..."] }
 *         ]
 *       }
 *     ]
 *   }
 *
 * Field-kind inference is conservative: edge cases (mixed-content
 * forms, repeats, custom appearances) emit `kind: "unknown"` rather
 * than guess wrong. The skill operator-LLM treats unknowns conservatively.
 *
 * Shipped 0.13.29.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';

// ── Public types ─────────────────────────────────────────────────

export type FieldKind =
  | 'label'
  | 'text'
  | 'int'
  | 'decimal'
  | 'date'
  | 'datetime'
  | 'time'
  | 'single_select'
  | 'multi_select'
  | 'geo'
  | 'trigger'
  | 'unknown';

export interface WalkedField {
  field_id: string;
  kind: FieldKind;
  label: string;
  options: string[];
}

export interface WalkedForm {
  module: number;
  form: number;
  form_unique_id: string | null;
  form_path: string;
  fields: WalkedField[];
}

export interface FormWalkOutput {
  domain: string;
  app_id: string;
  build_id: string | null;
  /**
   * Where the per-form `form_unique_id` came from:
   *   - 'draft_api' — the draft-app API at /a/<domain>/api/v0.5/application/<app_id>/.
   *     This is the value the `commcare_patch_xform` atom expects.
   *   - 'suite_xml' — the released CCZ's suite.xml `<resource id="...">` blocks.
   *     CCHQ rewrites the unique_id when serializing suite.xml (chars 11+
   *     diverge from the draft uid), so this value will be REJECTED by
   *     `commcare_patch_xform` with a 400/"Form not found" error.
   *
   * The CLI prefers 'draft_api' when `ACE_HQ_USERNAME` + `ACE_HQ_API_KEY`
   * are set in the env; otherwise it falls back to 'suite_xml' with a
   * stderr warning.
   */
  form_unique_id_source: 'draft_api' | 'suite_xml';
  forms: WalkedForm[];
}

/**
 * Per-module-form unique-id map derived from CCHQ's draft-app API
 * (/a/<domain>/api/v0.5/application/<app_id>/). The shape mirrors the
 * suite.xml `parseSuiteFormResources` output for drop-in overlay:
 *   key   = "modules-N/forms-M.xml"
 *   value = 32-hex form_unique_id from the draft module's forms[M].unique_id
 *
 * Exported for unit tests.
 */
export type DraftFormUidMap = Map<string, string>;

// ── Pure helpers (testable without live CCHQ) ─────────────────────

/**
 * Parse a CCZ `suite.xml` and return a map of form path
 * (`modules-0/forms-0.xml`) → 32-hex `form_unique_id` from the
 * matching `<resource id="...">` block.
 *
 * suite.xml shape (verified live 2026-05-05 against connect-ace-prod):
 *
 *   <suite>
 *     <xform>
 *       <resource id="<32-hex form_unique_id>">
 *         <location authority="local">./modules-0/forms-0.xml</location>
 *         <location authority="remote">/a/.../forms/.../</location>
 *       </resource>
 *       ...
 *     </xform>
 *     ...
 *   </suite>
 *
 * The 32-hex `id` attribute is what CCHQ uses as `form_unique_id`
 * elsewhere — same value the `commcare_patch_xform` atom expects.
 *
 * Exported for unit tests.
 */
export function parseSuiteFormResources(suiteXml: string): Map<string, string> {
  const out = new Map<string, string>();
  const doc = new DOMParser({
    onError: () => {},
  }).parseFromString(suiteXml, 'text/xml');
  const resources = doc.getElementsByTagName('resource');
  for (let i = 0; i < resources.length; i++) {
    const res = resources.item(i)!;
    const id = res.getAttribute('id');
    if (!id || !/^[0-9a-f]{32}$/.test(id)) continue;
    const locations = res.getElementsByTagName('location');
    for (let j = 0; j < locations.length; j++) {
      const loc = locations.item(j)!;
      if (loc.getAttribute('authority') !== 'local') continue;
      const text = (loc.textContent ?? '').trim().replace(/^\.\//, '');
      // Normalize ./modules-0/forms-0.xml → modules-0/forms-0.xml
      if (/^modules-\d+\/forms-\d+\.xml$/.test(text)) {
        out.set(text, id);
      }
    }
  }
  return out;
}

/**
 * Walk a CCHQ form-XML string and return a per-field inventory.
 *
 * Strategy:
 *   1. Build an itext map of `<text id="...">` → first-`<value>` text.
 *   2. Walk the body subtree (anything inside `<h:body>`) and record
 *      each input-bearing element's `ref`, mapped kind, and label.
 *   3. For `<select1>` / `<select>`, collect option labels via item
 *      `<value>` joined to itext refs.
 *
 * Body elements without a `ref` (pure layout) are skipped. `<bind>`-only
 * fields (calculate, hidden) never appear in the body and are skipped
 * by construction. Unrecognised body elements (or refs whose path can't
 * be reduced to a leaf field id) emit `kind: "unknown"` instead of
 * guessing — the skill operator-LLM treats unknowns conservatively.
 *
 * Exported for unit tests.
 */
export function walkFormFields(formXml: string): WalkedField[] {
  const doc = new DOMParser({
    onError: () => {},
  }).parseFromString(formXml, 'text/xml');

  // Build itext map. CCHQ forms ship a single default <translation>
  // (typically lang="en"); if multiple are present we pick the one
  // marked default="" first, else the first translation child.
  const itextMap = new Map<string, string>();
  const translations = doc.getElementsByTagName('translation');
  let chosenTranslation: Element | null = null;
  for (let i = 0; i < translations.length; i++) {
    const t = translations.item(i)!;
    if (t.getAttribute('default') !== null && t.getAttribute('default') !== undefined) {
      chosenTranslation = t as unknown as Element;
      break;
    }
  }
  if (!chosenTranslation && translations.length > 0) {
    chosenTranslation = translations.item(0) as unknown as Element;
  }
  if (chosenTranslation) {
    const texts = chosenTranslation.getElementsByTagName('text');
    for (let i = 0; i < texts.length; i++) {
      const t = texts.item(i)!;
      const id = t.getAttribute('id');
      if (!id) continue;
      // Prefer the plain <value> (no `form` attr) over <value form="markdown">.
      const values = t.getElementsByTagName('value');
      let plain = '';
      let firstAny = '';
      for (let j = 0; j < values.length; j++) {
        const v = values.item(j)!;
        const text = (v.textContent ?? '').trim();
        if (j === 0) firstAny = text;
        if (!v.hasAttribute('form')) {
          plain = text;
          break;
        }
      }
      itextMap.set(id, plain || firstAny);
    }
  }

  // Build a bind map (ref → bind type) so <input> elements with no
  // explicit type attribute can still be classified.
  const bindMap = new Map<string, string>();
  const binds = doc.getElementsByTagName('bind');
  for (let i = 0; i < binds.length; i++) {
    const b = binds.item(i)!;
    const ns = b.getAttribute('nodeset');
    const type = b.getAttribute('type');
    if (ns && type) bindMap.set(ns, type);
  }

  // Locate the body. h:body is the canonical location; some form
  // builders emit a bare <body>. We try both.
  const bodyCandidates = ['body', 'h:body'];
  let body: Element | null = null;
  for (const tag of bodyCandidates) {
    const list = doc.getElementsByTagName(tag);
    if (list.length > 0) {
      body = list.item(0) as unknown as Element;
      break;
    }
  }
  if (!body) return [];

  const fields: WalkedField[] = [];
  walkBody(body, itextMap, bindMap, fields);
  return fields;
}

function walkBody(
  node: Element,
  itextMap: Map<string, string>,
  bindMap: Map<string, string>,
  out: WalkedField[],
): void {
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes.item(i);
    if (!child || child.nodeType !== 1 /* ELEMENT_NODE */) continue;
    const el = child as Element;
    const tag = stripNs(el.tagName ?? el.nodeName);

    if (tag === 'group' || tag === 'repeat') {
      // Recurse — group/repeat wrap fields. We don't emit a row for
      // the group itself (it's structural). For repeats, the contained
      // fields will be emitted with their own refs; the operator-LLM
      // already treats repeat-children as conservatively in scope.
      walkBody(el, itextMap, bindMap, out);
      continue;
    }

    const ref = el.getAttribute('ref');
    if (!ref) continue; // layout-only element

    const fieldId = leafFromRef(ref);
    if (!fieldId) continue;

    const label = readLabel(el, itextMap);
    let kind: FieldKind = 'unknown';
    let options: string[] = [];

    switch (tag) {
      case 'input':
        kind = mapXsdType(bindMap.get(ref));
        break;
      case 'select1':
        kind = 'single_select';
        options = readSelectOptions(el, itextMap);
        break;
      case 'select':
        kind = 'multi_select';
        options = readSelectOptions(el, itextMap);
        break;
      case 'trigger':
        kind = 'trigger';
        break;
      case 'output':
      case 'item':
      case 'value':
        // Not a top-level field — these only appear inside a parent
        // input element. Skip.
        continue;
      default:
        kind = 'unknown';
    }

    out.push({ field_id: fieldId, kind, label, options });
  }
}

function readLabel(el: Element, itextMap: Map<string, string>): string {
  const labels = el.getElementsByTagName('label');
  if (labels.length === 0) return '';
  const label = labels.item(0)!;
  const ref = label.getAttribute('ref');
  if (ref) {
    // jr:itext('id-label') — extract the id between the quotes.
    const m = /jr:itext\(['"]([^'"]+)['"]\)/.exec(ref);
    if (m) return itextMap.get(m[1]) ?? '';
  }
  return (label.textContent ?? '').trim();
}

function readSelectOptions(el: Element, itextMap: Map<string, string>): string[] {
  const items = el.getElementsByTagName('item');
  const out: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items.item(i)!;
    const labels = item.getElementsByTagName('label');
    let optLabel = '';
    if (labels.length > 0) {
      const ref = labels.item(0)!.getAttribute('ref');
      if (ref) {
        const m = /jr:itext\(['"]([^'"]+)['"]\)/.exec(ref);
        if (m) optLabel = itextMap.get(m[1]) ?? '';
      }
      if (!optLabel) optLabel = (labels.item(0)!.textContent ?? '').trim();
    }
    if (optLabel) out.push(optLabel);
  }
  return out;
}

function stripNs(tagName: string): string {
  // h:body → body, jr:foo → foo
  const idx = tagName.indexOf(':');
  return idx >= 0 ? tagName.slice(idx + 1) : tagName;
}

function leafFromRef(ref: string): string | null {
  // /data/foo → foo; /data/group/foo → foo. Repeat-paths (.../child)
  // collapse to the leaf segment by design.
  const segs = ref.split('/').filter(Boolean);
  if (segs.length === 0) return null;
  return segs[segs.length - 1];
}

function mapXsdType(t?: string): FieldKind {
  if (!t) return 'text';
  if (t.endsWith(':int') || t.endsWith(':integer') || t === 'int' || t === 'integer') return 'int';
  if (t.endsWith(':decimal') || t === 'decimal') return 'decimal';
  if (t.endsWith(':date') || t === 'date') return 'date';
  if (t.endsWith(':dateTime') || t === 'dateTime') return 'datetime';
  if (t.endsWith(':time') || t === 'time') return 'time';
  if (t === 'geopoint' || t === 'geoshape' || t === 'geotrace') return 'geo';
  if (t.endsWith(':string') || t === 'string') return 'text';
  return 'text';
}

/**
 * Build the form-walk output from a raw CCZ buffer + identifying
 * domain/app_id/build_id triple. Pure: no I/O, no auth.
 *
 * Always returns `form_unique_id_source: 'suite_xml'` because CCZ-only
 * walking can't see the draft API. The CLI's `main()` overlays draft uids
 * via `mergeDraftFormUids` when the env has API credentials; tests can
 * feed in a draft map directly.
 *
 * Exported so the unit tests can feed in a CCZ-shaped fixture
 * (zip-of-XMLs) without going through CommCare auth.
 */
export function walkCcz(args: {
  cczBuf: Buffer;
  domain: string;
  app_id: string;
  build_id: string | null;
}): FormWalkOutput {
  const entries = unzipSync(new Uint8Array(args.cczBuf), {
    filter: (file) => file.name === 'suite.xml' || /^modules-\d+\/forms-\d+\.xml$/.test(file.name),
  });

  const suite = entries['suite.xml'];
  const formUid = suite ? parseSuiteFormResources(strFromU8(suite)) : new Map();

  const forms: WalkedForm[] = [];
  for (const path of Object.keys(entries).sort()) {
    const m = /^modules-(\d+)\/forms-(\d+)\.xml$/.exec(path);
    if (!m) continue;
    const xml = strFromU8(entries[path]);
    forms.push({
      module: Number(m[1]),
      form: Number(m[2]),
      form_unique_id: formUid.get(path) ?? null,
      form_path: path,
      fields: walkFormFields(xml),
    });
  }

  return {
    domain: args.domain,
    app_id: args.app_id,
    build_id: args.build_id,
    form_unique_id_source: 'suite_xml',
    forms,
  };
}

/**
 * Parse the draft-app API JSON response (from
 * /a/<domain>/api/v0.5/application/<app_id>/) into a map of form path
 * → 32-hex form_unique_id. The path key matches what the CCZ entries
 * use, so this map can drop-in overlay onto `parseSuiteFormResources`'s
 * output.
 *
 * Tolerates partial/malformed responses: rows without a `unique_id` or
 * a non-32-hex one are skipped silently. The caller decides what to do
 * when the map comes back empty (CLI's main warns and falls back to
 * suite.xml).
 *
 * Exported for unit tests.
 */
export function parseDraftAppFormUids(draftJson: unknown): DraftFormUidMap {
  const out: DraftFormUidMap = new Map();
  const modules = (draftJson as { modules?: unknown[] } | null)?.modules;
  if (!Array.isArray(modules)) return out;
  for (let mi = 0; mi < modules.length; mi++) {
    const mod = modules[mi] as { forms?: unknown[] } | null;
    if (!mod || !Array.isArray(mod.forms)) continue;
    for (let fi = 0; fi < mod.forms.length; fi++) {
      const form = mod.forms[fi] as { unique_id?: unknown } | null;
      const uid = typeof form?.unique_id === 'string' ? form.unique_id : null;
      if (!uid || !/^[0-9a-f]{32}$/.test(uid)) continue;
      out.set(`modules-${mi}/forms-${fi}.xml`, uid);
    }
  }
  return out;
}

/**
 * Overlay draft-API form_unique_ids onto a `walkCcz` output, replacing
 * each form's `form_unique_id` with the draft variant when present.
 * Forms whose path isn't in the draft map keep their suite.xml value
 * (and the source flag flips to 'suite_xml' if any form falls through).
 *
 * If `draftMap` is empty, the input is returned with no changes.
 *
 * Exported for unit tests.
 */
export function mergeDraftFormUids(
  walked: FormWalkOutput,
  draftMap: DraftFormUidMap,
): FormWalkOutput {
  if (draftMap.size === 0) return walked;
  let allCovered = true;
  const forms = walked.forms.map((f) => {
    const draft = draftMap.get(f.form_path);
    if (draft) return { ...f, form_unique_id: draft };
    allCovered = false;
    return f;
  });
  return {
    ...walked,
    form_unique_id_source: allCovered ? 'draft_api' : walked.form_unique_id_source,
    forms,
  };
}

/**
 * Fetch CCHQ's draft-app representation via the read-only
 * /api/v0.5/application/<app_id>/ endpoint, using ApiKey auth from
 * `ACE_HQ_USERNAME` + `ACE_HQ_API_KEY`. Returns an empty map (and
 * logs a warning to stderr) if env vars are missing or the request
 * fails — callers fall back to suite.xml uids and warn loudly.
 *
 * Kept inline here (rather than added to CommCareBackend) because the
 * draft API accepts ApiKey directly without the Playwright session
 * bring-up — adding a backend method would force the cookie-auth path
 * for a read that has a perfectly good keyed alternative.
 */
async function fetchDraftFormUidsViaApiKey(args: {
  domain: string;
  app_id: string;
  baseUrl: string;
}): Promise<DraftFormUidMap> {
  const user = process.env.ACE_HQ_USERNAME;
  const key = process.env.ACE_HQ_API_KEY;
  if (!user || !key) {
    console.error(
      '[run-form-walk] ACE_HQ_USERNAME / ACE_HQ_API_KEY not set; falling back to suite.xml form_unique_ids. ' +
        'These will be REJECTED by commcare_patch_xform — see issue #108.',
    );
    return new Map();
  }
  const url = `${args.baseUrl}/a/${args.domain}/api/v0.5/application/${args.app_id}/`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `ApiKey ${user}:${key}` } });
  } catch (e) {
    console.error(`[run-form-walk] draft-app API fetch failed: ${(e as Error).message}`);
    return new Map();
  }
  if (!res.ok) {
    console.error(`[run-form-walk] draft-app API returned ${res.status}; falling back to suite.xml`);
    return new Map();
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    console.error(`[run-form-walk] draft-app API JSON parse failed: ${(e as Error).message}`);
    return new Map();
  }
  return parseDraftAppFormUids(body);
}

// ── CLI entrypoint ────────────────────────────────────────────────

interface CliArgs {
  domain: string;
  app_id: string;
  build_id?: string;
  out?: string;
}

function parseCliArgs(argv: string[]): CliArgs | null {
  const out: Partial<CliArgs> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--build-id') {
      out.build_id = argv[++i];
    } else if (a === '--out') {
      out.out = argv[++i];
    } else if (a.startsWith('--')) {
      console.error(`Unrecognized flag: ${a}`);
      return null;
    } else {
      positional.push(a);
    }
  }
  if (positional.length < 2) return null;
  out.domain = positional[0];
  out.app_id = positional[1];
  return out as CliArgs;
}

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args) {
    console.error(
      'Usage: npx tsx scripts/run-form-walk.ts <domain> <app_id> [--build-id <hex>] [--out <path>]',
    );
    return 1;
  }

  // Lazy-import Playwright + CommCare backend so the unit-test path
  // that imports `walkFormFields` / `walkCcz` directly does NOT pay
  // for the Connect session bring-up (Playwright launch + auth state).
  const { CommCareBackend } = await import('../mcp/connect/backends/commcare.js');
  const { PlaywrightSession } = await import('../mcp/connect/auth/playwright-session.js');
  const cchqBaseUrl = process.env.ACE_HQ_BASE_URL ?? 'https://www.commcarehq.org';
  const baseUrl = process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com';
  const session = new PlaywrightSession({
    baseUrl,
    cchqBaseUrl,
    hqUsername: process.env.ACE_HQ_USERNAME,
    hqPassword: process.env.ACE_HQ_PASSWORD,
  });
  await session.getContext();
  const c = new CommCareBackend({ baseUrl: cchqBaseUrl, session });

  const ccz = await c.downloadCcz({
    domain: args.domain,
    app_id: args.app_id,
    build_id: args.build_id,
    include_multimedia: false,
  });
  if (ccz.status !== 200 || !ccz.ccz_path) {
    console.error(`download_ccz failed: status=${ccz.status} bytes=${ccz.size_bytes}`);
    return 2;
  }

  const cczBuf = readFileSync(ccz.ccz_path);
  const walked = walkCcz({
    cczBuf,
    domain: args.domain,
    app_id: args.app_id,
    build_id: args.build_id ?? null,
  });

  // Overlay draft-API form_unique_ids onto the walk output. The CCZ's
  // suite.xml-derived uids are a CCHQ-build-only variant that the
  // commcare_patch_xform endpoint rejects (see issue #108) — the draft
  // API has the canonical values. Falls back silently to suite.xml uids
  // when ACE_HQ_USERNAME/ACE_HQ_API_KEY are missing (with a warning).
  const draftMap = await fetchDraftFormUidsViaApiKey({
    domain: args.domain,
    app_id: args.app_id,
    baseUrl: cchqBaseUrl,
  });
  const result = mergeDraftFormUids(walked, draftMap);

  const text = JSON.stringify(result, null, 2);
  if (args.out) {
    writeFileSync(args.out, text);
    console.error(`Wrote ${result.forms.length} forms to ${args.out}`);
  } else {
    process.stdout.write(text + '\n');
  }
  await session.close().catch(() => {});
  return 0;
}

// Only run main when executed as a script (not when imported by tests).
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  /run-form-walk\.ts$/.test(process.argv[1]);
if (isMain) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
