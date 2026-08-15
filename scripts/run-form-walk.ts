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
 *   npx tsx scripts/run-form-walk.ts <domain> <app_id> [--build-id <hex>] [--out <path> | --out-scratch]
 *
 * Output paths (ace#1046): prefer `--out-scratch`, which derives an
 * unpredictable per-user path via `lib/scratch-file.ts` and prints only that
 * path on stdout. NEVER pass a fixed literal like `/tmp/ace-hq-<app>.json` —
 * that path is shared across macOS users, so the write can fail `EACCES`
 * while the follow-up read silently returns another session's file. Every
 * `--out` write is read back and asserted to carry this invocation's
 * `domain` + `app_id` before the script exits 0.
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
 *         "module_unique_id": "<32-hex>" | null,
 *         "form_path": "modules-0/forms-0.xml",
 *         "fields": [
 *           { "field_id": "...", "kind": "label|text|int|single_select|multi_select|date|geo|image|trigger|unknown", "label": "<text>", "options": ["..."] }
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

// Load ${CLAUDE_PLUGIN_DATA}/.env before anything reads process.env (ace#993).
// MCP subprocesses get .env injected by the server bootstrap; a plain
// `npx tsx` shell invocation does NOT — so the command block documented in
// `skills/app-hq-settings § Step 2` failed verbatim as written, and reported
// it as an unrelated issue-#108 uid halt ("falling back to suite.xml ... 0
// forms") while the credentials were correctly provisioned all along. Same
// idiom as the MCP servers (`mcp/connect-server.ts`).
import { config as dotenvConfig } from 'dotenv';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';
import * as nodePath from 'node:path';

const __formWalkPluginDataDir = resolvePluginDataDir(import.meta.url);
dotenvConfig({
  path: __formWalkPluginDataDir
    ? nodePath.join(__formWalkPluginDataDir, '.env')
    : nodePath.join(process.cwd(), '.env'),
});

import { unzipSync, strFromU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { scratchPath, writeVerifiedJson } from '../lib/scratch-file.js';

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
  | 'image'
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
  /**
   * 32-hex `unique_id` of the OWNING module (a.k.a. menu), from the
   * draft-app API's `modules[N].unique_id`. This is the value the
   * `commcare_set_menu_display` atom expects (per-module grid toggle).
   *
   * Null when the draft-app overlay didn't run (no API creds → suite.xml
   * fallback; suite.xml has no draft module uid). Callers that need to
   * set menu display MUST NOT proceed on a null value — the same
   * suite.xml-vs-draft mismatch that makes `form_unique_id_source:
   * 'suite_xml'` unsafe for `patch_xform` applies here (issue #108).
   */
  module_unique_id: string | null;
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

/**
 * Per-module unique-id map derived from CCHQ's draft-app API
 * (/a/<domain>/api/v0.5/application/<app_id>/). The key is the form path
 * (`modules-N/forms-M.xml`) — same key space as `DraftFormUidMap` — so
 * each form can be overlaid with its OWNING module's uid in a single
 * pass over `walkCcz` output. The value is the 32-hex `modules[N].unique_id`.
 *
 * Every form under module N maps to the same module uid. Keying by form
 * path (rather than module index) keeps the overlay symmetric with
 * `mergeDraftFormUids`'s existing per-form loop and avoids a second index
 * lookup that would drift if the CCZ and draft API disagreed on module
 * ordering.
 *
 * Exported for unit tests.
 */
export type DraftModuleUidMap = Map<string, string>;

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
      case 'upload':
        // <upload mediatype="image/*"> is a photo-capture control. Only
        // image uploads are relevant to this walk's image-bearing-form
        // consumers (app-hq-settings' camera-only appearance="acquire"
        // pass); audio/video uploads fall through to their own kind.
        kind = (el.getAttribute('mediatype') ?? '').startsWith('image/')
          ? 'image'
          : 'unknown';
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
      // suite.xml has no draft module uid; the CLI's mergeDraftFormUids
      // overlay fills this from the draft-app API when creds are present.
      module_unique_id: null,
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
 * Parse the draft-app API JSON response into a per-form map of the
 * OWNING module's 32-hex `unique_id` (from `modules[N].unique_id`). The
 * key is the form path (`modules-N/forms-M.xml`) so it overlays onto
 * `walkCcz` output in the same pass as `parseDraftAppFormUids`.
 *
 * Every form under a module gets that module's uid. Modules whose
 * `unique_id` is not 32- or 40-hex are skipped silently — their forms
 * simply keep `module_unique_id: null`, and the caller (app-hq-settings)
 * halts before setting menu display on a null uid. (CCHQ modules are
 * 40-hex SHA-1; forms are 32-hex.)
 *
 * Exported for unit tests.
 */
export function parseDraftAppModuleUids(draftJson: unknown): DraftModuleUidMap {
  const out: DraftModuleUidMap = new Map();
  const modules = (draftJson as { modules?: unknown[] } | null)?.modules;
  if (!Array.isArray(modules)) return out;
  for (let mi = 0; mi < modules.length; mi++) {
    const mod = modules[mi] as { unique_id?: unknown; forms?: unknown[] } | null;
    if (!mod) continue;
    const modUid = typeof mod.unique_id === 'string' ? mod.unique_id : null;
    // CCHQ emits module `unique_id`s as 40-hex SHA-1 digests, while form
    // `unique_id`s are 32-hex — accept either width. A 32-only gate here
    // silently dropped every real module uid, leaving module_unique_id
    // null and halting app-hq-settings (the RDT Deliver draft surfaced
    // this: 40-hex modules, 32-hex forms).
    if (!modUid || !/^[0-9a-f]{32}(?:[0-9a-f]{8})?$/.test(modUid)) continue;
    const forms = Array.isArray(mod.forms) ? mod.forms : [];
    // Map every form path under this module to the module uid. Fall back
    // to at least forms-0 so a module with a broken/empty forms[] array
    // still surfaces its uid on the module's first (index-0) form path,
    // matching how walkCcz enumerates modules-N/forms-M.xml.
    const formCount = Math.max(forms.length, 1);
    for (let fi = 0; fi < formCount; fi++) {
      out.set(`modules-${mi}/forms-${fi}.xml`, modUid);
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
 * If `draftMap` is empty, the input is returned with no changes to the
 * form uids or the source flag. An optional `moduleMap` overlays each
 * form's `module_unique_id` independently — it is applied whenever
 * present regardless of `draftMap`'s emptiness, so a caller can fill
 * module uids even if the form-uid overlay was skipped. The
 * `form_unique_id_source` flag reflects the FORM uid coverage only; a
 * form missing from `moduleMap` keeps `module_unique_id: null` without
 * downgrading the source flag (menu-display callers check the null
 * directly).
 *
 * Exported for unit tests.
 */
export function mergeDraftFormUids(
  walked: FormWalkOutput,
  draftMap: DraftFormUidMap,
  moduleMap?: DraftModuleUidMap,
): FormWalkOutput {
  if (draftMap.size === 0 && (!moduleMap || moduleMap.size === 0)) return walked;
  let allCovered = true;
  const forms = walked.forms.map((f) => {
    let next = f;
    const draft = draftMap.get(f.form_path);
    if (draft) {
      next = { ...next, form_unique_id: draft };
    } else if (draftMap.size > 0) {
      allCovered = false;
    }
    const modUid = moduleMap?.get(f.form_path);
    if (modUid) next = { ...next, module_unique_id: modUid };
    return next;
  });
  return {
    ...walked,
    // Only flip to draft_api when the form-uid overlay ran AND covered
    // every form. An empty draftMap (module-only overlay) leaves the
    // source flag untouched.
    form_unique_id_source:
      draftMap.size > 0 && allCovered ? 'draft_api' : walked.form_unique_id_source,
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
async function fetchDraftUidsViaApiKey(args: {
  domain: string;
  app_id: string;
  baseUrl: string;
}): Promise<{ formMap: DraftFormUidMap; moduleMap: DraftModuleUidMap }> {
  const empty = { formMap: new Map<string, string>(), moduleMap: new Map<string, string>() };
  const user = process.env.ACE_HQ_USERNAME;
  const key = process.env.ACE_HQ_API_KEY;
  if (!user || !key) {
    console.error(
      '[run-form-walk] ACE_HQ_USERNAME / ACE_HQ_API_KEY not set; falling back to suite.xml form_unique_ids ' +
        'and leaving module_unique_id null. These will be REJECTED by commcare_patch_xform / ' +
        'commcare_set_menu_display — see issue #108.',
    );
    return empty;
  }
  const url = `${args.baseUrl}/a/${args.domain}/api/v0.5/application/${args.app_id}/`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `ApiKey ${user}:${key}` } });
  } catch (e) {
    console.error(`[run-form-walk] draft-app API fetch failed: ${(e as Error).message}`);
    return empty;
  }
  if (!res.ok) {
    console.error(`[run-form-walk] draft-app API returned ${res.status}; falling back to suite.xml`);
    return empty;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    console.error(`[run-form-walk] draft-app API JSON parse failed: ${(e as Error).message}`);
    return empty;
  }
  return {
    formMap: parseDraftAppFormUids(body),
    moduleMap: parseDraftAppModuleUids(body),
  };
}

// ── CLI entrypoint ────────────────────────────────────────────────

interface CliArgs {
  domain: string;
  app_id: string;
  build_id?: string;
  out?: string;
  /**
   * Derive the output path instead of taking one: an unpredictable
   * per-user, per-process scratch file (ace#1046). Prints the resolved
   * path — and nothing else — on stdout so the caller can `jq` it.
   */
  out_scratch?: boolean;
  /** Resolve uids from the draft-app API ONLY — no CCZ, no Playwright.
   * See `--draft-only` handling in `main()` for why this mode exists. */
  draft_only?: boolean;
  /**
   * `--with-fields`: in draft-only mode, ALSO emit the per-form field
   * inventory by pulling each form's source from the draft (ace#994).
   * Costs a Playwright session, which plain `--draft-only` deliberately
   * avoids — so it is opt-in, and the callers that need `kind: image` ask
   * for it explicitly.
   */
  with_fields?: boolean;
}

function parseCliArgs(argv: string[]): CliArgs | null {
  const out: Partial<CliArgs> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--build-id') {
      out.build_id = argv[++i];
    } else if (a === '--with-fields') {
      out.with_fields = true;
    } else if (a === '--draft-only') {
      out.draft_only = true;
    } else if (a === '--out') {
      out.out = argv[++i];
    } else if (a === '--out-scratch') {
      out.out_scratch = true;
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

/**
 * Emit the walk result, identity-verified (ace#1046).
 *
 * Every file write goes through `writeVerifiedJson`, which reads the file
 * back and asserts `{domain, app_id}` round-trip before returning. That is
 * the half that closes the near-miss: a write that fails `EACCES` on a
 * predictable shared `/tmp` path while a DIFFERENT session's stale file
 * survives can no longer be handed to the caller as if it were ours. The
 * payload already stamps `domain` + `app_id`, so the guard costs nothing.
 *
 * `--out-scratch` derives an unpredictable per-user path and prints ONLY
 * that path on stdout; `--out <path>` honours an explicit path; neither
 * flag keeps the original stdout-JSON behaviour.
 */
function emitResult(
  args: CliArgs,
  result: { domain: string; app_id: string; forms: unknown[] },
  label: string,
): void {
  const text = JSON.stringify(result, null, 2);
  const identity = { domain: args.domain, app_id: args.app_id };
  const target = args.out ?? (args.out_scratch ? scratchPath(`run-form-walk-${args.app_id}.json`) : null);
  if (!target) {
    process.stdout.write(text + '\n');
    return;
  }
  writeVerifiedJson({ filePath: target, payload: result, identity });
  console.error(`Wrote ${result.forms.length} forms${label} to ${target}`);
  // In `--out-scratch` mode stdout is the path channel, so the caller can
  // do: OUT="$(... --out-scratch)" && jq . "$OUT"
  if (!args.out) process.stdout.write(target + '\n');
}

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args) {
    console.error(
      'Usage: npx tsx scripts/run-form-walk.ts <domain> <app_id> [--build-id <hex>] [--draft-only [--with-fields]] [--out <path> | --out-scratch]',
    );
    return 1;
  }

  // `--draft-only`: resolve module/form uids from the draft-app API and
  // skip BOTH the CCZ download and the Playwright bring-up (this path
  // authenticates with ACE_HQ_API_KEY over plain fetch, no session).
  //
  // Why this mode exists (ace#971). `app-hq-settings` runs at Phase 3
  // Step 2.65 — between `app-deploy` and `app-release` — because it
  // mutates the CCHQ *draft*, so it MUST land before the build is cut.
  // But on a fresh run the draft has never been built, so `download_ccz`
  // 404s and the step can't resolve the uids it needs at the only
  // position in the pipeline where it's allowed to run. The step is
  // fail-soft, so it degraded silently to "camera-only and grid display
  // never applied" on every first-time run rather than failing loudly.
  //
  // The uids never needed the CCZ: the draft-app API is the canonical
  // source for them (it's already the overlay the full walk applies on
  // top of suite.xml — see `fetchDraftUidsViaApiKey`). This mode just
  // stops pretending a build has to exist first.
  if (args.draft_only) {
    const cchqBaseUrl = process.env.ACE_HQ_BASE_URL ?? 'https://www.commcarehq.org';
    const { formMap, moduleMap } = await fetchDraftUidsViaApiKey({
      domain: args.domain,
      app_id: args.app_id,
      baseUrl: cchqBaseUrl,
    });
    // No suite.xml fallback here by design: in draft-only mode the API IS
    // the source, so an empty map is a hard failure, not a soft degrade.
    // Silently emitting zero forms is exactly the failure #971 is about.
    if (formMap.size === 0) {
      console.error(
        '[run-form-walk] --draft-only resolved 0 forms. The draft-app API is the only source in ' +
          'this mode, so this is fatal rather than a fallback. Check ACE_HQ_USERNAME / ' +
          'ACE_HQ_API_KEY are set and that the app_id is a DRAFT app in this domain.',
      );
      return 2;
    }
    // Per-form field inventory (ace#994). `--draft-only` alone emits uids
    // only — no `fields`, no `form_path` — but `app-hq-settings § Step 3`
    // (camera-only) triggers on forms carrying >= 1 field with `kind: image`.
    // A literal reading therefore found ZERO image-bearing forms on a
    // never-built draft and silently skipped the acquire patch: the same
    // fail-soft class #971 set out to close, moved one step downstream.
    //
    // Halting instead would be worse — Step 3 would then halt on EVERY
    // first-time run, which is the ace#1026 trap (a blocker that always fires
    // trains agents to route around it). So the inventory is made available
    // on a draft instead, via the same `/apps/browse/<app>/<form>/source/`
    // path `commcare_patch_xform` already uses against drafts in this very
    // skill. `fields_available` lets the consumer tell "no image fields" from
    // "no inventory was collected" — the distinction whose absence is the bug.
    const draftForms: Array<{
      form_key: string;
      form_unique_id: string;
      fields?: WalkedField[];
    }> = [...formMap].map(([form_key, form_unique_id]) => ({ form_key, form_unique_id }));

    if (args.with_fields) {
      const { CommCareBackend: CB } = await import('../mcp/connect/backends/commcare.js');
      const { PlaywrightSession: PS } = await import('../mcp/connect/auth/playwright-session.js');
      const dsession = new PS({
        baseUrl: process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com',
        cchqBaseUrl,
        hqUsername: process.env.ACE_HQ_USERNAME,
        hqPassword: process.env.ACE_HQ_PASSWORD,
      });
      await dsession.getContext();
      const dc = new CB({ baseUrl: cchqBaseUrl, session: dsession });
      for (const f of draftForms) {
        const src = await dc.getFormSource({
          domain: args.domain,
          app_id: args.app_id,
          form_unique_id: f.form_unique_id,
        });
        f.fields = walkFormFields(src.xform_xml);
      }
    }

    const result = {
      domain: args.domain,
      app_id: args.app_id,
      build_id: null,
      form_unique_id_source: 'draft_api' as const,
      /**
       * False on a plain `--draft-only` walk. A consumer that keys off
       * `kind: image` MUST NOT read "no image-bearing forms" from an absent
       * inventory — re-run with `--with-fields` (ace#994).
       */
      fields_available: args.with_fields === true,
      modules: [...moduleMap].map(([module_key, module_unique_id]) => ({
        module_key,
        module_unique_id,
      })),
      forms: draftForms,
    };
    emitResult(args, result, args.with_fields ? ' (draft_api + fields)' : ' (draft_api)');
    return 0;
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
  if (ccz.status !== 200 || !ccz.ccz_base64) {
    console.error(`download_ccz failed: status=${ccz.status} bytes=${ccz.size_bytes}`);
    return 2;
  }

  const cczBuf = Buffer.from(ccz.ccz_base64, 'base64');
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
  const { formMap, moduleMap } = await fetchDraftUidsViaApiKey({
    domain: args.domain,
    app_id: args.app_id,
    baseUrl: cchqBaseUrl,
  });
  const result = mergeDraftFormUids(walked, formMap, moduleMap);

  emitResult(args, result, '');
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
