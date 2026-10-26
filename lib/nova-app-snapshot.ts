/**
 * The Phase 3 Nova app snapshot: one `fetchNovaAppBundle` read, shared by every
 * checker in the pass instead of each re-walking Nova (ace#3132, P12).
 *
 * ## Why
 *
 * Over the 120 days to 2026-10-18, 953 of 1,254 `mcp__nova__get_form` calls
 * came from Phase 3's checkers (`pdd-to-{learn,deliver}-app-eval`,
 * `app-connect-coverage`, `app-media-coverage`, the repair rounds), each
 * walking every form of the same saved app independently — 13.2M characters
 * of tool result, mostly teaching labels the checkers never used. Step 1.4's
 * `nova-app-lint` already reads the whole app once, server-side; this module
 * makes that read the snapshot the rest of the pass reads from.
 *
 * ## Freshness — the snapshot is a hypothesis, re-checked in one call
 *
 * Nova's saved-state reads carry no revision (`get_app` / `get_form` responses
 * have none; only private work does, and it dies at `save_work`). What does
 * move is the app's `updated_at`, returned per app by `search_apps` (observed
 * 2026-10-23 on `f0952d84-…`). The snapshot records it at read time; a checker
 * re-reads it (ONE call) before trusting the snapshot, and a moved or missing
 * value means re-read — never "probably fine". Procedurally the snapshot is
 * also invalidated by every write: Phase 3 re-runs the lint after every edit,
 * and the lint rewrites the snapshot.
 *
 * ## Reads that must stay LIVE
 *
 * A read-back that VERIFIES a write the checker just made cannot come from a
 * snapshot taken before it. `LIVE_READS` names each one; `test/lib/
 * nova-app-snapshot.test.ts` pins that every named skill still says so.
 */
import type { NovaAppBundle, NovaCall } from './nova-app-bundle.js';

/** Snapshot metadata, written onto the bundle by `stampSnapshot`. */
export interface SnapshotMeta {
  /** ISO time the bundle was read. */
  fetchedAt: string;
  /** The app's `updated_at` per `search_apps` when the read began; null if it could not be found. */
  updatedAt: string | null;
  /** `saved` for an `app_id` read; `work` for a private-work candidate (never shared). */
  scope: 'saved' | 'work';
}

export type SnapshotBundle = NovaAppBundle & { snapshot?: SnapshotMeta };

/**
 * The app's `updated_at` as Nova reports it, or null. `search_apps` is a name
 * search, so match on `app_id` — two apps can share a name (every Smallholder
 * Learn rebuild does).
 */
export async function readAppUpdatedAt(appId: string, appName: string | undefined, call: NovaCall): Promise<string | null> {
  if (!appName) return null;
  try {
    const r: any = await call('search_apps', { query: appName });
    const hit = (r?.apps ?? []).find((a: any) => a?.app_id === appId);
    return typeof hit?.updated_at === 'string' ? hit.updated_at : null;
  } catch {
    return null;
  }
}

export function stampSnapshot(bundle: NovaAppBundle, meta: SnapshotMeta): SnapshotBundle {
  return { ...bundle, snapshot: meta };
}

export type Freshness =
  | { state: 'fresh' }
  | { state: 'stale'; reason: string }
  | { state: 'unknown'; reason: string };

/** Pure. Can this snapshot stand in for a live read of the saved app right now? */
export function snapshotFreshness(bundle: SnapshotBundle, appId: string, liveUpdatedAt: string | null): Freshness {
  const s = bundle.snapshot;
  if (!s) return { state: 'unknown', reason: 'bundle carries no snapshot metadata (written by an older nova-app-lint)' };
  if (bundle.appId !== appId) return { state: 'stale', reason: `snapshot is of app ${bundle.appId}, not ${appId}` };
  if (s.scope !== 'saved') return { state: 'stale', reason: 'snapshot is of private work, not the saved app' };
  if (bundle.readErrors.length) return { state: 'stale', reason: `snapshot read was partial: ${bundle.readErrors[0]}` };
  if (!s.updatedAt) return { state: 'unknown', reason: 'snapshot recorded no updated_at' };
  if (!liveUpdatedAt) return { state: 'unknown', reason: 'could not read the app’s current updated_at' };
  if (liveUpdatedAt !== s.updatedAt) {
    return { state: 'stale', reason: `app updated ${liveUpdatedAt}, snapshot taken at ${s.updatedAt}` };
  }
  return { state: 'fresh' };
}

export interface OutlineForm {
  module: string;
  moduleUuid: string;
  form: string;
  formUuid: string;
  fields: number;
  connect: string[];
}

/** Count of leaf + group nodes in a field tree. */
function countFields(fields: any[] | undefined): number {
  let n = 0;
  for (const f of fields ?? []) n += 1 + countFields(f?.children);
  return n;
}

/** Pure. The `(module, form) -> uuids` map every checker builds first, plus marker presence. */
export function snapshotOutline(bundle: NovaAppBundle): OutlineForm[] {
  const out: OutlineForm[] = [];
  for (const m of bundle.app?.modules ?? []) {
    for (const f of m.forms ?? []) {
      const fr = bundle.forms.find((x: any) => x?.formUuid === f.uuid);
      const connect = fr?.form?.connect ? Object.keys(fr.form.connect).filter((k) => fr.form.connect[k] != null) : [];
      out.push({
        module: m.name,
        moduleUuid: m.uuid,
        form: f.name,
        formUuid: f.uuid,
        fields: countFields(fr?.form?.fields),
        connect,
      });
    }
  }
  return out;
}

/**
 * Pure. One form's `get_form` response exactly as Nova returned it, selected
 * by form uuid or (case-insensitive) form name. Ambiguous names throw — a
 * checker must never grade the wrong form of two with one name.
 */
export function snapshotForm(bundle: NovaAppBundle, selector: string): any {
  const byUuid = bundle.forms.find((x: any) => x?.formUuid === selector);
  if (byUuid) return byUuid;
  const want = selector.trim().toLowerCase();
  const names = new Map<string, string>();
  for (const m of bundle.app?.modules ?? []) for (const f of m.forms ?? []) names.set(f.uuid, String(f.name ?? ''));
  const hits = bundle.forms.filter((x: any) => (names.get(x?.formUuid) ?? x?.form?.name ?? '').toLowerCase() === want);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`form name "${selector}" is ambiguous (${hits.length} forms); pass the formUuid`);
  throw new Error(`no form "${selector}" in snapshot of ${bundle.appId}`);
}

/**
 * Reads that must stay LIVE even when a fresh snapshot exists: each verifies a
 * write made after the snapshot was taken. Adding a checker that reads after
 * its own write ⇒ add it here and say so in its SKILL.md. (The builders'
 * own read-backs — e.g. `pdd-to-deliver-app` Step 4f `verifyLookupBind` — run
 * before the snapshot exists and never consult it.)
 */
export const LIVE_READS: ReadonlyArray<{ skill: string; step: string; why: string }> = [
  {
    skill: 'app-connect-coverage',
    step: 'Step 4c',
    why: 'post-mutation re-fetch proves configure_connect / update_form landed (and that configure_connect did not clear an omitted form)',
  },
  {
    skill: 'app-media-coverage',
    step: 'step 9',
    why: 'saved-app read-back proves the attaches survived save_work',
  },
  {
    skill: 'pdd-to-learn-app',
    step: '4b',
    why: 'post-save get_app re-fetch proves configure_connect landed and cleared no form; 4c step 3 and Repair mode step 3 re-read their own save the same way',
  },
  {
    skill: 'pdd-to-deliver-app',
    step: '4e',
    why: 'post-save get_app re-fetch proves configure_connect landed and cleared no form',
  },
];
