/**
 * The DDD loop's write path into ACE's Labs report templates: edit the
 * template DRAFT, preview it on this run's page, publish only when the
 * re-judge does not regress — otherwise discard the draft.
 *
 * ## Why a draft cycle and not a straight publish
 *
 * A publish reaches EVERY live follower on its next load — every other ACE run
 * whose Phase 7 is still open follows the same template
 * (`lib/labs-report-templates.ts`). So an edit is proven on this run's page
 * first, through the draft preview (`&template_draft=1`, visible only to
 * template editors — the ACE identity the renders run as), and published only
 * when the affected cells did not get worse.
 *
 * ## Why the draft is a lease
 *
 * A template has ONE draft. Two runs editing it at once would each publish the
 * other's half-tested edits. So:
 *   - `beginDraft` refuses (`busy`) when the draft already differs from what is
 *     published and was touched recently — another run holds it;
 *   - the first `update_draft` passes the revision `beginDraft` read
 *     (`expected_revision`), so two runs that both saw a clean draft cannot
 *     both write: the second gets a revision conflict and treats it as busy;
 *   - `publish` passes the revision the edit produced, so a draft that moved
 *     after the preview is never published unseen.
 * A draft abandoned by a crashed run is reclaimed after `STALE_DRAFT_MS`.
 *
 * ## Why render-only
 *
 * `discardDraft` restores the draft from the published version's RENDER CODE
 * (`workflow_template_export`, the one read that returns published code to an
 * editor). Config defaults and the snapshot spec have no such read, so an edit
 * to them could not be cleanly undone — and a config default changes the page
 * of every follower that does not override it. The loop edits the render only;
 * a fix that needs config or a figure Labs does not compute is out of its scope.
 */
import type { LabsCall } from './labs-rpc.js';
import type { ReportTemplatesConfig } from './labs-report-templates.js';

/** A draft untouched this long is treated as abandoned and reclaimed. */
export const STALE_DRAFT_MS = 2 * 60 * 60 * 1000;

type Obj = Record<string, any>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

/** The template workflow id for a template type (`indicator_programme_report`, …) or an id passed through. */
export function templateIdFor(cfg: ReportTemplatesConfig, typeOrId: string | number): number {
  if (typeof typeOrId === 'number' || /^\d+$/.test(String(typeOrId))) {
    const id = Number(typeOrId);
    if (!Object.values(cfg.templates).some((t) => t.template_workflow_id === id)) {
      throw new Error(`template workflow ${id} is not one of ACE's (config/labs-report-templates.yaml)`);
    }
    return id;
  }
  const t = cfg.templates[String(typeOrId)];
  if (!t) throw new Error(`no ACE template for ${typeOrId}; known: ${Object.keys(cfg.templates).join(', ')}`);
  return t.template_workflow_id;
}

/**
 * The page with the template draft applied: the same URL plus
 * `template_draft=1` (labs `workflow_template_preview`'s `draft_preview_url`
 * adds exactly this; a saved run keeps its `run_id`). Idempotent.
 */
export function draftPreviewUrl(url: string): string {
  const hashAt = url.indexOf('#');
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  if (/[?&]template_draft=1(?:&|$)/.test(base)) return url;
  const cleaned = base.replace(/([?&])template_draft=[^&]*&?/, '$1').replace(/[?&]$/, '');
  return `${cleaned}${cleaned.includes('?') ? '&' : '?'}template_draft=1${hash}`;
}

export type BeginResult =
  | { status: 'ready'; template_workflow_id: number; revision: number; published_version: number | null; reclaimed?: boolean }
  | { status: 'busy'; template_workflow_id: number; revision: number; updated_by: string | null; updated_at: string | null };

async function readTemplate(call: LabsCall, cfg: ReportTemplatesConfig, id: number): Promise<Obj> {
  return obj(await call('workflow_template_get', { template_workflow_id: id, program_id: cfg.home.program_id }));
}

/** Take the draft lease (see header). `ready` carries the revision the first edit must pass. */
export async function beginDraft(
  call: LabsCall,
  cfg: ReportTemplatesConfig,
  typeOrId: string | number,
  now: () => Date = () => new Date(),
  staleMs = STALE_DRAFT_MS,
): Promise<BeginResult> {
  const id = templateIdFor(cfg, typeOrId);
  const t = await readTemplate(call, cfg, id);
  const d = obj(t.draft);
  const revision = int(d.revision);
  if (!revision) throw new Error(`template ${id}: no draft revision in workflow_template_get (are you an editor?)`);
  if (d.differs_from_published) {
    const at = typeof d.updated_at === 'string' ? Date.parse(d.updated_at) : NaN;
    const stale = Number.isFinite(at) && now().getTime() - at > staleMs;
    if (!stale) {
      return { status: 'busy', template_workflow_id: id, revision, updated_by: d.updated_by ?? null, updated_at: d.updated_at ?? null };
    }
    const r = await discardDraft(call, cfg, id);
    return { status: 'ready', template_workflow_id: id, revision: r.revision, published_version: int(t.published_version), reclaimed: true };
  }
  return { status: 'ready', template_workflow_id: id, revision, published_version: int(t.published_version) };
}

/**
 * Throw the draft away: reset its render to the published version's.
 * Returns the new draft revision. Verifies the draft no longer differs — if it
 * still does, something other than the render was edited, which the loop must
 * not do (header), and the caller is told rather than left with a dirty draft.
 */
export async function discardDraft(call: LabsCall, cfg: ReportTemplatesConfig, typeOrId: string | number): Promise<{ revision: number }> {
  const id = templateIdFor(cfg, typeOrId);
  const exp = obj(await call('workflow_template_export', { template_workflow_id: id, program_id: cfg.home.program_id, include_code: true, max_diff_lines: 0 }));
  const code = exp.code;
  if (typeof code !== 'string' || !code) throw new Error(`template ${id}: export returned no published code`);
  const t = await readTemplate(call, cfg, id);
  const rev = int(obj(t.draft).revision);
  if (!rev) throw new Error(`template ${id}: no draft revision`);
  if (!obj(t.draft).differs_from_published) return { revision: rev };
  await call('workflow_template_update_draft', { template_workflow_id: id, program_id: cfg.home.program_id, expected_revision: rev, render_code: code });
  const after = await readTemplate(call, cfg, id);
  const d = obj(after.draft);
  if (d.differs_from_published) {
    throw new Error(`template ${id}: draft still differs from published after restoring its render — config or snapshot_inputs were edited; restore them by hand (workflow_template_get include_code)`);
  }
  return { revision: int(d.revision) ?? rev };
}

/** One judged cell: `"<scene>::<dimension>"` → score (canopy's cell key). */
export type CellScores = Record<string, number>;

export interface PublishDecision {
  decision: 'publish' | 'discard';
  improved: string[];
  regressed: string[];
  unchanged: string[];
  reason: string;
}

/**
 * Publish iff no affected cell got worse. A cell missing from `after` was not
 * re-judged, so nothing is known about it: with no comparable cell at all the
 * answer is `discard` — an unproven edit never reaches the other followers.
 * "Doesn't regress" (all unchanged) still publishes: the edit fixed what the
 * finding named without moving a score the judge rounds to an integer, and the
 * finding itself is closed by the next full pass, not by this comparison.
 */
export function publishDecision(before: CellScores, after: CellScores): PublishDecision {
  const improved: string[] = [];
  const regressed: string[] = [];
  const unchanged: string[] = [];
  for (const [k, b] of Object.entries(before)) {
    const a = after[k];
    if (typeof a !== 'number' || typeof b !== 'number') continue;
    if (a > b) improved.push(k);
    else if (a < b) regressed.push(k);
    else unchanged.push(k);
  }
  const compared = improved.length + regressed.length + unchanged.length;
  if (!compared) return { decision: 'discard', improved, regressed, unchanged, reason: 'no affected cell was re-judged on the draft preview' };
  if (regressed.length) return { decision: 'discard', improved, regressed, unchanged, reason: `regressed: ${regressed.join(', ')}` };
  return {
    decision: 'publish',
    improved,
    regressed,
    unchanged,
    reason: improved.length ? `improved: ${improved.join(', ')}` : 'no affected cell regressed',
  };
}

/** Publish the draft this run edited, guarded by the revision its edit produced. */
export async function publishDraft(
  call: LabsCall,
  cfg: ReportTemplatesConfig,
  typeOrId: string | number,
  expectedRevision: number,
  note: string,
): Promise<{ published_version: number | null }> {
  const id = templateIdFor(cfg, typeOrId);
  if (!note.trim()) throw new Error('publish needs a note (what changed, which run/finding) for the version history');
  const r = obj(await call('workflow_template_publish', { template_workflow_id: id, program_id: cfg.home.program_id, expected_revision: expectedRevision, note }));
  return { published_version: int(r.published_version) ?? int(r.version) ?? null };
}
