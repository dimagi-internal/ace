/**
 * Read a saved Nova app ONCE into a bundle that `lib/nova-app-lint.ts` can
 * check without touching the network again.
 *
 * ## Why one read, and why here
 *
 * Phase 3's build-quality signal used to come from two LLM evals
 * (`pdd-to-{learn,deliver}-app-eval`) that each re-read the blueprint
 * (`get_app`, every `get_form`, every bound lookup table) and then applied
 * rules that are fully deterministic — banned words, the app-name rule, lookup
 * value uniqueness. On `smallholder-seasonal/20261015-1402` the Deliver eval
 * took three passes (~42 min) to clear a banned word sitting in 7 lookup rows;
 * on `kaduna-graduation/20261015-1411` whitespace in a lookup value column was
 * first noticed by Nova's upload preflight (ace#2984). A bundle read once and
 * linted in milliseconds moves those findings to right after the build.
 *
 * ## What is read
 *
 * - `get_app` — modules, forms, record model, the app's `connect` type.
 * - `get_module` per module — case-list columns (id-mapping enums) and the
 *   module display condition.
 * - `get_form` per form — fields, options sources, connect blocks,
 *   answerWrites (which declare `preloadedAnswers`).
 * - `get_lookup_table_rows` for every table a field's `optionsSource` binds,
 *   PAGED TO THE END. Tables are project-wide in Nova (the Personal project
 *   carried ~50 on 2026-10-16), so the catalog is never walked — only bound
 *   tables, each once however many fields bind it.
 *
 * A read that fails is recorded in `readErrors` and the lint reports the
 * affected rule as `unable`, never as a pass (`lib/check-outcome.ts`).
 */

import type { LookupTableRow } from './option-register.js';

/** One Nova tool call. `novaCall` from `lib/nova-rpc.ts` in production. */
export type NovaCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export interface BoundTableColumn {
  id: string;
  wireName?: string;
  label?: string;
}

export interface BoundTable {
  tableId: string;
  name?: string;
  tag?: string;
  columns: BoundTableColumn[];
  rows: LookupTableRow[];
  /** True only when every page was read. A partial read is never a pass. */
  complete: boolean;
  error?: string;
}

/** Everything the lint needs, as Nova returned it. Shapes kept loose on purpose. */
export interface NovaAppBundle {
  appId: string;
  /** `get_app(...).app` */
  app: any;
  /** `get_module` responses, in app order. */
  modules: any[];
  /** `get_form` responses (`{moduleUuid, formUuid, form, answerWrites, ...}`), in app order. */
  forms: any[];
  /** Bound lookup tables keyed by table id. */
  tables: Record<string, BoundTable>;
  readErrors: string[];
}

/** Every `optionsSource.kind === 'lookup'` table id in a form's field tree. */
export function boundTableIds(forms: any[]): string[] {
  const ids = new Set<string>();
  const walk = (fields: any[] | undefined) => {
    for (const f of fields ?? []) {
      const src = f?.optionsSource;
      if (src?.kind === 'lookup' && typeof src.tableId === 'string') ids.add(src.tableId);
      walk(f?.children);
    }
  };
  for (const fr of forms) walk(fr?.form?.fields);
  return [...ids];
}

/** Max pages per table: 100 rows/page → 5000 rows, Nova's own table cap. */
const MAX_PAGES = 50;

/**
 * Read the saved app (or a `work_id`) into a bundle. Sequential on purpose:
 * Nova answers a burst of parallel reads with HTTP 429 (observed 2026-10-16
 * capturing this module's fixtures), and the whole read is ~20–60 calls.
 */
export async function fetchNovaAppBundle(
  appId: string,
  call: NovaCall,
  opts: { workId?: string } = {},
): Promise<NovaAppBundle> {
  const scope: Record<string, unknown> = opts.workId ? { work_id: opts.workId } : { app_id: appId };
  const readErrors: string[] = [];
  const appResp: any = await call('get_app', { app_id: appId });
  const app = appResp?.app ?? appResp;
  const modules: any[] = [];
  const forms: any[] = [];
  for (const m of app?.modules ?? []) {
    try {
      modules.push(await call('get_module', { ...scope, moduleUuid: m.uuid }));
    } catch (e) {
      readErrors.push(`get_module ${m.name ?? m.uuid}: ${(e as Error).message}`);
    }
    for (const f of m.forms ?? []) {
      try {
        forms.push(await call('get_form', { ...scope, moduleUuid: m.uuid, formUuid: f.uuid }));
      } catch (e) {
        readErrors.push(`get_form ${f.name ?? f.uuid}: ${(e as Error).message}`);
      }
    }
  }

  const tables: Record<string, BoundTable> = {};
  for (const tableId of boundTableIds(forms)) {
    const bt: BoundTable = { tableId, columns: [], rows: [], complete: false };
    try {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const p: any = await call('get_lookup_table_rows', { ...scope, tableId, ...(cursor ? { cursor } : {}) });
        if (p?.table) {
          bt.name = p.table.name;
          bt.tag = p.table.tag;
          bt.columns = (p.table.columns ?? []).map((c: BoundTableColumn) => ({
            id: c.id,
            wireName: c.wireName,
            label: c.label,
          }));
        }
        bt.rows.push(...(p?.rows ?? []));
        cursor = p?.nextCursor ?? undefined;
        if (p?.complete === true) {
          bt.complete = true;
          break;
        }
        if (!cursor) break;
      }
    } catch (e) {
      bt.error = (e as Error).message;
      readErrors.push(`get_lookup_table_rows ${tableId}: ${bt.error}`);
    }
    tables[tableId] = bt;
  }

  return { appId, app, modules, forms, tables, readErrors };
}
