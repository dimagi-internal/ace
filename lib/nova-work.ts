//
// Nova private work — the only way to change a Nova app since
// voidcraft-labs/commcare-nova#693 (deployed 2026-09-27).
//
// ## The contract, as observed live 2026-09-28
//
//   begin_work({request_id, app_id | new_app:{name, project_id?}}) → {work_id}
//   <mutation>({work_id, request_id, ...})  → {ok, saved:false, revision, diagnostics}
//   save_work({work_id, request_id, expected_revision}) → {saved:true, app_id, saved_revision}
//
// Every mutation is STAGED. It answers `ok: true, saved: false`, and the saved
// app — which is all `get_app`, `upload_app_to_hq` and `compile_app` ever read —
// does not change until `save_work` succeeds. An edit that is never saved is
// not an error anywhere: it is simply absent from what ships. That is the
// failure this module exists to make impossible.
//
// Four behaviours that are not guessable and that this module encodes:
//
//  1. **A refused save is DATA, not an error.** A save against a stale base
//     answers `{kind:'stale-base', saved:false, success:false}` with no
//     `isError`, so `novaCall` returns it normally. Checking "did it throw"
//     passes a save that never happened. `classifySaveResult` is the check.
//  2. **The revision is opaque and per-candidate.** Every staged mutation
//     returns the new `revision`; `save_work` must echo the LATEST one. A wrong
//     revision is refused ("Read the work and use its current revision").
//  3. **`request_id` is an idempotency key.** Replaying one with identical
//     input returns the original receipt; replaying it with different input is
//     refused ("already used with different input"). Mint a fresh id per call.
//  4. **Project data is NOT staged.** `create_lookup_table` (bind adopted after
//     voidcraft-labs/commcare-nova#545; and the other
//     lookup writers) take `work_id` for authority but commit to the Project at
//     call time: the table is visible through the saved app before any save,
//     adds nothing to `pending_changes`, and survives `discard_work`. Only the
//     BIND of a field to it is staged.
//
// Reads choose exactly one target: `app_id` reads saved state, `work_id` reads
// the candidate. A read-back that proves a write SHIPPED must use `app_id`
// after the save.
//
// See playbook/integrations/nova-integration.md § The private-work authoring
// contract.

import { randomUUID } from 'node:crypto';
import { novaCall, type NovaRpcOptions } from './nova-rpc.js';

/** A fresh idempotency key. Never reuse one for changed input. */
export function newRequestId(label = 'ace'): string {
  return `${label}-${randomUUID()}`;
}

export type SaveOutcome =
  | { kind: 'saved'; appId: string; savedRevision: number | null }
  | { kind: 'stale'; message: string }
  | { kind: 'refused'; message: string };

/**
 * Classify a `save_work` answer. Pure; the single definition of "the save
 * happened" shared by the helper, the probe and any skill that saves by hand.
 *
 * Only `saved === true` with an `app_id` counts. Everything else — including
 * the `success:false` shapes Nova returns WITHOUT `isError` — is a refusal.
 */
export function classifySaveResult(raw: unknown): SaveOutcome {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.saved === true && typeof r.app_id === 'string' && r.app_id) {
    return {
      kind: 'saved',
      appId: r.app_id,
      savedRevision: typeof r.saved_revision === 'number' ? r.saved_revision : null,
    };
  }
  const message =
    typeof r.message === 'string'
      ? r.message
      : typeof r.error === 'string'
        ? r.error
        : `save_work did not save: ${String(JSON.stringify(raw)).slice(0, 300)}`;
  if (r.kind === 'stale-base') return { kind: 'stale', message };
  return { kind: 'refused', message };
}

/**
 * Some Nova refusals also arrive as data rather than `isError` —
 * `remove_lookup_table` answers `{code:'referenced', error, blockingApps}`.
 * Returns the refusal message, or null when the result looks like success.
 */
export function refusalOf(raw: unknown): string | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.saved === false && r.success === false) {
    return typeof r.message === 'string' ? r.message : 'refused';
  }
  if (typeof r.code === 'string' && typeof r.error === 'string') return `${r.code}: ${r.error}`;
  if (r.ok === false) return typeof r.message === 'string' ? r.message : 'refused';
  return null;
}

export type WorkTarget = { appId: string } | { newApp: { name: string; projectId?: string } };

type Call = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * One private-work session. Stage edits with `stage()`, then `save()` — which
 * throws unless Nova actually saved. Keeps the latest candidate revision so
 * callers never have to thread it by hand.
 */
export class NovaWork {
  /** Latest candidate revision; null when nothing is pending. */
  revision: string | null = null;
  /** The saved app id, once one exists (set on begin for an existing app). */
  appId: string | null;

  private constructor(
    readonly workId: string,
    appId: string | null,
    private readonly call: Call,
  ) {
    this.appId = appId;
  }

  static async begin(target: WorkTarget, opts: NovaRpcOptions & { call?: Call } = {}): Promise<NovaWork> {
    const call: Call = opts.call ?? ((n, a) => novaCall(n, a, opts));
    const args: Record<string, unknown> = { request_id: newRequestId('begin') };
    if ('appId' in target) args.app_id = target.appId;
    else {
      args.new_app = target.newApp.projectId
        ? { name: target.newApp.name, project_id: target.newApp.projectId }
        : { name: target.newApp.name };
    }
    const r = (await call('begin_work', args)) as { work_id?: string; app_id?: string | null };
    if (!r?.work_id) throw new Error(`begin_work returned no work_id: ${JSON.stringify(r).slice(0, 300)}`);
    return new NovaWork(r.work_id, r.app_id ?? null, call);
  }

  /** Stage one mutation. Adds work_id + a fresh request_id; tracks the revision. */
  async stage(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if ('app_id' in args) {
      throw new Error(`${tool}: staged mutations take work_id, not app_id (voidcraft-labs/commcare-nova#693)`);
    }
    const r = (await this.call(tool, {
      ...args,
      work_id: this.workId,
      request_id: newRequestId(tool),
    })) as Record<string, unknown>;
    const refusal = refusalOf(r);
    if (refusal) throw new Error(`Nova ${tool} refused: ${refusal}`);
    if (typeof r?.revision === 'string') this.revision = r.revision;
    return r;
  }

  /** Read the candidate (revision, pending_changes, stale, diagnostics). */
  async read(): Promise<Record<string, unknown>> {
    const r = (await this.call('get_work', { work_id: this.workId })) as Record<string, unknown>;
    this.revision = typeof r?.revision === 'string' ? r.revision : null;
    return r;
  }

  /**
   * Save the candidate. Throws unless Nova saved it. Re-reads the revision
   * first, so a stage() whose answer carried none (Project-data writers) cannot
   * leave a stale one behind. A no-op when nothing is pending.
   */
  async save(): Promise<Extract<SaveOutcome, { kind: 'saved' }> | { kind: 'nothing-pending' }> {
    const w = await this.read();
    if (!this.revision) {
      if (w.stale === true) throw new Error(`Nova work ${this.workId} is stale with nothing pending`);
      return { kind: 'nothing-pending' };
    }
    const outcome = classifySaveResult(
      await this.call('save_work', {
        work_id: this.workId,
        request_id: newRequestId('save'),
        expected_revision: this.revision,
      }),
    );
    if (outcome.kind !== 'saved') {
      throw new Error(`Nova save_work ${outcome.kind} for work ${this.workId}: ${outcome.message}`);
    }
    this.appId = outcome.appId;
    this.revision = null;
    return outcome;
  }

  /** Abandon pending changes (keeps the work id and earlier saves). */
  async discard(): Promise<void> {
    await this.read();
    if (!this.revision) return;
    await this.call('discard_work', {
      work_id: this.workId,
      request_id: newRequestId('discard'),
      expected_revision: this.revision,
    });
    this.revision = null;
  }
}
