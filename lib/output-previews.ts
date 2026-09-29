//
// Output previews — screenshots of an OUTPUT, filed with the phase that BUILT it.
//
// Contract (v1) — shared with ace-web, spec
// `docs/specs/2026-09-29-output-previews-design.md` in the ace-web repo:
//
//   <run>/<N>-<phase-folder>/previews/<output-slug>/_previews.yaml
//   <run>/<N>-<phase-folder>/previews/<output-slug>/<NN>-<step>.png
//
// A preview belongs to the output and lives in the folder of the phase that
// built the output, WHOEVER captured it. Phase 6 walks the Learn and Deliver
// apps on the emulator, but a reader meets those apps in Phase 3 — so the
// frames go to `3-commcare/previews/apps-learn/`, not two phases away under
// `6-qa-and-training/`. Phase 7's DDD render photographs the labs dashboards
// Phase 7 built, so those go to `7-synthetic/previews/<slug>/`.
//
// The rules the helpers below make structural rather than remembered:
//
//   * `<output-slug>` is the dotted key under `phases.<phase>.products` with
//     every run of non-[a-z0-9] characters replaced by `-` — `outputSlug`.
//     ace-web derives the SAME slug (`apps/opps/output_previews.py::output_slug`)
//     to match a folder to a product, so the two must never disagree.
//   * `_previews.yaml` is AUTHORITATIVE: a reader shows exactly `items`, in
//     order. Only frames from a passing journey go in; `duplicate_of` frames
//     never do — `buildPreviewsIndex`.
//   * It is stored as REAL YAML BYTES (`drive_upload_binary`, `text/yaml`),
//     never a Google Doc, whose export turns every `\n` into `\r\n\r\n\r\n`
//     (skills/_training-template.md § Machine-parsed artifacts). A writer reads
//     its own index back through `assertPreviewsIndexReadable` before calling
//     the write done.
//   * Nothing about previews goes under `phases.<phase>.products`: ace-web reads
//     any mapping there with a `file_id` as an OUTPUT, so a pointer to the index
//     would render as a bogus product.
//   * One writer per output folder, and a re-capture REPLACES — the writer trashes
//     the folder's previous contents before writing (skill prose; Drive I/O is
//     not this module's business).
//

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const PREVIEWS_SCHEMA_VERSION = 1 as const;
export const PREVIEWS_INDEX_NAME = '_previews.yaml';
export const PREVIEWS_INDEX_MIME = 'text/yaml';

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * `apps.learn` → `apps-learn`; `synthetic.workflows.programme_report` →
 * `synthetic-workflows-programme-report`. Lowercased, every run of characters
 * outside [a-z0-9] collapsed to one `-`, edges trimmed — byte-for-byte what
 * ace-web's `output_slug` does, because the folder name IS the join key when a
 * reader falls back to matching by slug.
 */
export function outputSlug(key: string): string {
  return String(key ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** `<phaseFolder>/previews/<slug>` — relative to the run folder. */
export function previewsFolderPath(phaseFolder: string, outputKey: string): string {
  const slug = outputSlug(outputKey);
  if (!slug) throw new Error(`output key ${JSON.stringify(outputKey)} has no slug`);
  return `${phaseFolder}/previews/${slug}`;
}

/**
 * `<NN>-<step>.png` — the frame's display position, then its step name. The
 * two-digit prefix keeps a name-ordered listing (ace-web's no-index fallback)
 * in capture order; the index is still what orders a reader.
 */
export function previewFileName(ordinal: number, step: string, ext = 'png'): string {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new Error(`preview ordinal must be a positive integer, got ${ordinal}`);
  }
  const safe = String(step ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!safe) throw new Error(`step ${JSON.stringify(step)} has no usable file name`);
  return `${String(ordinal).padStart(2, '0')}-${safe}.${ext}`;
}

// ---------------------------------------------------------------------------
// Which output key does THIS run use for an app?
// ---------------------------------------------------------------------------

export type AppKind = 'learn' | 'deliver';

export interface AppOutputKey {
  /** Dotted key under `phases.commcare-setup.products`, exactly as written. */
  key: string;
  /**
   * True when `key` was found in the run's products; false when the block had
   * no recognisable entry for this app and the DECLARED shape was returned.
   */
  present: boolean;
}

/**
 * The key `phases.commcare-setup.products` records an app under, read from
 * the run rather than assumed.
 *
 * The declared shape (`lib/phase-products-schema.ts` / `products-apps-schema.ts`,
 * sole writer `app-deploy`) is `apps.learn` / `apps.deliver`. Runs have also
 * been seen carrying `apps.learn_app` (app-release's summary vocabulary leaking
 * into run_state) and a flat `learn_app`; ace-web absorbs all three
 * (`apps/opps/run_products.py`). An index must name the key the run ACTUALLY
 * has, or the reader's `phase + output_key` match misses and the frames fall to
 * slug matching or nowhere. Preference order: declared shape first.
 */
export function resolveAppOutputKey(commcareProducts: unknown, app: AppKind): AppOutputKey {
  const root = asRecord(commcareProducts);
  const apps = asRecord(root.apps);
  const candidates: Array<[string, unknown]> = [
    [`apps.${app}`, apps[app]],
    [`apps.${app}_app`, apps[`${app}_app`]],
    [`${app}_app`, root[`${app}_app`]],
    [app, root[app]],
  ];
  for (const [key, value] of candidates) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { key, present: true };
    }
  }
  return { key: `apps.${app}`, present: false };
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

export interface PreviewItem {
  file_id: string;
  name: string;
  caption?: string;
}

export interface PreviewsIndex {
  schema_version: typeof PREVIEWS_SCHEMA_VERSION;
  /** run_state phase key that OWNS the output (e.g. `commcare-setup`). */
  phase: string;
  /** Dotted key under `phases.<phase>.products`, exactly as written in run_state. */
  output_key: string;
  /** The skill/step that took the frames — replay reveals them at that beat. */
  captured_by: string;
  /** run_state phase key the capture ran in (e.g. `qa-and-training`). */
  captured_phase: string;
  /** ISO-8601. */
  captured_at: string;
  items: PreviewItem[];
}

/** A frame as a producer holds it — a capture-manifest row, or a render scene. */
export interface PreviewFrameInput {
  file_id?: unknown;
  /** Uploaded file name; falls back to `<step>.png`. */
  name?: unknown;
  step?: unknown;
  step_name?: unknown;
  /** Explicit caption; wins over `shows`. */
  caption?: unknown;
  /** app-screenshot-capture § Step 5.6 — what is actually on the frame. */
  shows?: unknown;
  /** Present on a byte-identical alias frame — never a distinct preview. */
  duplicate_of?: unknown;
}

export interface BuildPreviewsIndexInput {
  phase: string;
  outputKey: string;
  capturedBy: string;
  capturedPhase: string;
  capturedAt: string;
  /** In display order. */
  frames: readonly PreviewFrameInput[];
}

/**
 * The authoritative index for one output folder.
 *
 * Drops `duplicate_of` aliases (the same moment twice is one preview) and rows
 * without a file id (nothing to show), and keeps the first of any repeated file
 * id. Order is the caller's. The CALLER decides which frames are eligible —
 * only a passing journey's frames, only frames whose anonymous readback
 * passed — and passes those.
 */
export function buildPreviewsIndex(input: BuildPreviewsIndexInput): PreviewsIndex {
  for (const [field, value] of [
    ['phase', input.phase],
    ['outputKey', input.outputKey],
    ['capturedBy', input.capturedBy],
    ['capturedPhase', input.capturedPhase],
    ['capturedAt', input.capturedAt],
  ] as const) {
    if (!nonEmpty(value)) throw new Error(`buildPreviewsIndex: ${field} is required`);
  }
  const seen = new Set<string>();
  const items: PreviewItem[] = [];
  for (const f of input.frames) {
    if (nonEmpty(f.duplicate_of)) continue;
    const fileId = nonEmpty(f.file_id) ? String(f.file_id).trim() : '';
    if (!fileId || seen.has(fileId)) continue;
    seen.add(fileId);
    const step = nonEmpty(f.step) ? String(f.step) : nonEmpty(f.step_name) ? String(f.step_name) : '';
    const name = nonEmpty(f.name) ? String(f.name).trim() : step ? `${step}.png` : `${fileId}.png`;
    const captionRaw = nonEmpty(f.caption) ? f.caption : nonEmpty(f.shows) ? f.shows : undefined;
    items.push(captionRaw === undefined ? { file_id: fileId, name } : { file_id: fileId, name, caption: String(captionRaw).trim() });
  }
  return {
    schema_version: PREVIEWS_SCHEMA_VERSION,
    phase: input.phase,
    output_key: input.outputKey,
    captured_by: input.capturedBy,
    captured_phase: input.capturedPhase,
    captured_at: input.capturedAt,
    items,
  };
}

/** YAML text for `_previews.yaml` — write it to a local file, then `drive_upload_binary`. */
export function serializePreviewsIndex(index: PreviewsIndex): string {
  return stringifyYaml(index, { lineWidth: 0 });
}

export type PreviewsIndexFindingReason =
  | 'not-real-bytes'
  | 'not-yaml'
  | 'bad-field'
  | 'bad-item'
  | 'duplicate-file-id'
  | 'products-pointer'
  | 'slug-mismatch'
  | 'key-mismatch'
  | 'count-mismatch';

export interface PreviewsIndexFinding {
  reason: PreviewsIndexFindingReason;
  detail: string;
}

export interface PreviewsIndexReadback {
  ok: boolean;
  index?: PreviewsIndex;
  findings: PreviewsIndexFinding[];
}

export interface PreviewsIndexExpectations {
  /** The folder the index sits in (`apps-learn`) — must equal `outputSlug(output_key)`. */
  folderSlug?: string;
  phase?: string;
  outputKey?: string;
  capturedBy?: string;
  /** Frames the writer meant to list. */
  expectedCount?: number;
}

/**
 * Does the `_previews.yaml` a writer just wrote read back as the contract says?
 *
 * Run it over the TEXT read back from Drive (`drive_read_file` on the uploaded
 * id), not the object in hand: the failure this exists for — a Google Doc
 * export whose newlines came back as `\r\n\r\n\r\n` — is only visible in the
 * bytes. `ok: false` is a halt for that output's previews, never a silent pass:
 * an index a reader cannot parse is an output with no pictures, and nothing
 * downstream reports that.
 */
export function assertPreviewsIndexReadable(
  text: string,
  expect: PreviewsIndexExpectations = {},
): PreviewsIndexReadback {
  const findings: PreviewsIndexFinding[] = [];
  const add = (reason: PreviewsIndexFindingReason, detail: string) => findings.push({ reason, detail });

  if (typeof text !== 'string' || text.trim() === '') {
    add('not-yaml', 'index is empty');
    return { ok: false, findings };
  }
  if (text.includes('\r')) {
    add(
      'not-real-bytes',
      'index contains carriage returns — it was written as a Google Doc (drive_create_file). ' +
        'Re-write it with drive_upload_binary({mimeType: "text/yaml"}).',
    );
  }

  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    add('not-yaml', `index does not parse as YAML: ${(err as Error).message}`);
    return { ok: false, findings };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    add('not-yaml', 'index is not a YAML mapping');
    return { ok: false, findings };
  }
  const d = data as Record<string, unknown>;

  if (d.schema_version !== PREVIEWS_SCHEMA_VERSION) {
    add('bad-field', `schema_version must be ${PREVIEWS_SCHEMA_VERSION}, got ${JSON.stringify(d.schema_version)}`);
  }
  for (const field of ['phase', 'output_key', 'captured_by', 'captured_phase', 'captured_at'] as const) {
    if (!nonEmpty(d[field]) || typeof d[field] !== 'string') {
      add('bad-field', `${field} must be a non-empty string`);
    }
  }
  if (typeof d.captured_at === 'string' && Number.isNaN(Date.parse(d.captured_at))) {
    add('bad-field', `captured_at is not an ISO timestamp: ${d.captured_at}`);
  }
  if (typeof d.output_key === 'string' && /(^|\.)previews?(\.|$)/.test(d.output_key)) {
    add(
      'products-pointer',
      `output_key ${d.output_key} names a previews slot — previews are never recorded under products`,
    );
  }

  const items: PreviewItem[] = [];
  if (!Array.isArray(d.items)) {
    add('bad-field', 'items must be a list');
  } else {
    const seen = new Set<string>();
    d.items.forEach((raw, i) => {
      const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
      if (!r || !nonEmpty(r.file_id) || !nonEmpty(r.name)) {
        add('bad-item', `items[${i}] needs a non-empty file_id and name`);
        return;
      }
      if (r.caption !== undefined && r.caption !== null && typeof r.caption !== 'string') {
        add('bad-item', `items[${i}].caption must be a string when present`);
      }
      const fileId = String(r.file_id);
      if (seen.has(fileId)) add('duplicate-file-id', `items[${i}] repeats file_id ${fileId}`);
      seen.add(fileId);
      items.push({
        file_id: fileId,
        name: String(r.name),
        ...(typeof r.caption === 'string' ? { caption: r.caption } : {}),
      });
    });
  }

  if (expect.folderSlug !== undefined && typeof d.output_key === 'string') {
    const slug = outputSlug(d.output_key);
    if (slug !== expect.folderSlug) {
      add('slug-mismatch', `output_key ${d.output_key} slugs to ${slug}, but the index sits in previews/${expect.folderSlug}/`);
    }
  }
  if (expect.phase !== undefined && d.phase !== expect.phase) {
    add('key-mismatch', `phase is ${JSON.stringify(d.phase)}, expected ${expect.phase}`);
  }
  if (expect.outputKey !== undefined && d.output_key !== expect.outputKey) {
    add('key-mismatch', `output_key is ${JSON.stringify(d.output_key)}, expected ${expect.outputKey}`);
  }
  if (expect.capturedBy !== undefined && d.captured_by !== expect.capturedBy) {
    add('key-mismatch', `captured_by is ${JSON.stringify(d.captured_by)}, expected ${expect.capturedBy}`);
  }
  if (expect.expectedCount !== undefined && items.length !== expect.expectedCount) {
    add('count-mismatch', `index lists ${items.length} item(s), writer meant ${expect.expectedCount}`);
  }

  const ok = findings.length === 0;
  return ok
    ? {
        ok,
        index: {
          schema_version: PREVIEWS_SCHEMA_VERSION,
          phase: d.phase as string,
          output_key: d.output_key as string,
          captured_by: d.captured_by as string,
          captured_phase: d.captured_phase as string,
          captured_at: d.captured_at as string,
          items,
        },
        findings,
      }
    : { ok, findings };
}

// ---------------------------------------------------------------------------
// Phase 7 — which render scenes show which dashboard
// ---------------------------------------------------------------------------

export interface RenderScene {
  /** 1-based ORIGINAL spec index — the `N` in canopy's `snapshots/scene_<N>.png`. */
  scene_index: number;
  /** The scene's `url:` from the unified spec, `${var}`s unresolved or resolved. */
  url?: unknown;
  title?: unknown;
}

export interface WorkflowProduct {
  workflow_id?: unknown;
  run_url?: unknown;
  url?: unknown;
}

export interface PickDashboardScenesInput {
  /** The unified spec's scenes, in spec order. */
  scenes: readonly RenderScene[];
  /** `phases.synthetic-data-and-workflows.products.synthetic.workflows`. */
  workflows: Record<string, WorkflowProduct | undefined> | undefined | null;
  /** `7-synthetic/realized.json` — resolves `${var}` in a scene url. */
  vars?: Record<string, unknown>;
  /** Scene indices whose `scene_<N>.png` actually exists (skipped scenes have none). */
  available?: ReadonlySet<number> | readonly number[];
  /** Frames per dashboard. Default 2. */
  perOutput?: number;
}

/** `synthetic.workflows.<key>` — the dotted output key a dashboard's previews name. */
export function workflowOutputKey(workflowKey: string): string {
  return `synthetic.workflows.${workflowKey}`;
}

/** Replace `${name}` with `vars[name]`; unknown vars are left as written. */
export function resolveTemplate(template: string, vars: Record<string, unknown> = {}): string {
  return template.replace(/\$\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
    const v = vars[name];
    return typeof v === 'string' || typeof v === 'number' ? String(v) : whole;
  });
}

/** The labs workflow id in `…/labs/workflow/<id>/run/?run_id=…`, or null. */
export function labsWorkflowId(url: string): string | null {
  const m = /\/workflow\/(\d+)(?:\/|$|\?)/.exec(url);
  return m ? m[1] : null;
}

/**
 * For each dashboard in `products.synthetic.workflows`, the render scenes that
 * LAND on it — at most `perOutput`, in spec order.
 *
 * A scene is matched by its OPENING url (the spec's `url:`, resolved through
 * realized.json): the labs workflow id in it equals the dashboard's
 * `workflow_id` (or the id in its `run_url`), else the whole url equals the
 * `run_url`. Matching by workflow id rather than by the realized var's NAME is
 * deliberate — the cascade's programme report is `programme_par_url` in
 * realized.json but `programme_report` in `workflows`, so the names do not line
 * up and the ids do. A scene that navigates elsewhere mid-scene still counts for
 * the dashboard it opened on; its frame is whatever it ended on, so prefer the
 * FIRST scenes on a dashboard (usually the headline) — which spec order gives.
 *
 * Returns only dashboards with at least one scene. An empty result is a normal
 * outcome (no render, no snapshots) and the caller writes nothing.
 */
export function pickDashboardScenes(input: PickDashboardScenesInput): Record<string, number[]> {
  const perOutput = input.perOutput ?? 2;
  const available =
    input.available === undefined
      ? null
      : new Set(Array.isArray(input.available) ? input.available : [...(input.available as ReadonlySet<number>)]);
  const out: Record<string, number[]> = {};
  const workflows = input.workflows ?? {};

  for (const [key, wf] of Object.entries(workflows)) {
    if (!wf || typeof wf !== 'object') continue;
    const runUrl = firstString(wf.run_url, wf.url);
    const wfId = nonEmpty(wf.workflow_id) ? String(wf.workflow_id) : runUrl ? labsWorkflowId(runUrl) : null;
    if (!wfId && !runUrl) continue;

    const picked: number[] = [];
    for (const scene of input.scenes) {
      if (picked.length >= perOutput) break;
      if (!Number.isInteger(scene.scene_index) || scene.scene_index < 1) continue;
      if (available && !available.has(scene.scene_index)) continue;
      if (typeof scene.url !== 'string' || !scene.url) continue;
      const url = resolveTemplate(scene.url, input.vars);
      const sceneWf = labsWorkflowId(url);
      const hit = (wfId !== null && sceneWf === wfId) || (runUrl !== null && normUrl(url) === normUrl(runUrl));
      if (hit) picked.push(scene.scene_index);
    }
    if (picked.length) out[key] = picked;
  }
  return out;
}

// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function nonEmpty(v: unknown): boolean {
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'number') return Number.isFinite(v);
  return false;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return null;
}

function normUrl(u: string): string {
  return u.trim().replace(/\/+$/, '');
}
