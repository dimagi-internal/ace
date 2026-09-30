//
// Output preview CAPTURE — the deterministic half of `skills/output-preview-capture`.
//
// Rule (ace-web `docs/specs/2026-09-29-output-previews-design.md`, addendum
// 2026-09-30): every output ace-web lists is either a file its in-page viewer
// draws, or has one or more GOOD screenshots. ace-web computes which outputs
// are neither — `GET /api/w/{ws}/opps/{slug}/runs/{run}/preview-gaps` — and
// this module turns one gap into a capture plan: which session opens it, which
// page(s) to photograph, what makes the frame good or bad, and where the frames
// go. The browser work lives in `scripts/output-preview-capture.ts`; the Drive
// writes and the final LOOK at every frame live in the skill.
//
// What this module never does: re-derive ace-web's product walk. A gap's
// `output_key` is exactly the key the index must name, and `phase` is the
// run_state phase that owns the output — both are used verbatim.
//
// Reuses `lib/output-previews.ts` for the contract itself (slug, folder, file
// name, index) — one writer of the rules, many callers.

import { normalizePhaseKey, phaseFolder, PHASE_DEFS, type Phase } from './artifact-manifest.js';
import { buildOcsPublicChatUrl } from './ocs-public-chat-url.js';
import { normalizeDriveExport } from './drive-export.js';
import {
  buildPreviewsIndex,
  previewFileName,
  previewsFolderPath,
  type PreviewFrameInput,
  type PreviewsIndex,
} from './output-previews.js';

/** `captured_by` on every index this skill writes. */
export const CAPTURED_BY = 'output-preview-capture';

export type PreviewAuth = 'connect' | 'labs' | 'hq' | 'ocs' | 'google' | 'public' | 'canopy';

export type GapReason = 'no-preview' | 'not-viewable-file';

export interface PreviewGap {
  id: string;
  /** run_state phase key that owns the output (`connect-setup`, …). */
  phase: string;
  /** Dotted key under `phases.<phase>.products` — the index names exactly this. */
  output_key: string;
  kind: string;
  title: string;
  url: string | null;
  file_id: string | null;
  reason: GapReason;
  auth: PreviewAuth;
}

export interface PreviewGapList {
  run_id: string | null;
  outputs: PreviewGap[];
  covered: number;
}

// ---------------------------------------------------------------------------
// The gap list
// ---------------------------------------------------------------------------

/** `GET` URL for a run's gap list. `base` is `ACE_WEB_BASE_URL` (…/ace). */
export function previewGapsUrl(base: string, workspace: string, opp: string, runId: string): string {
  for (const [name, v] of [['base', base], ['workspace', workspace], ['opp', opp], ['runId', runId]] as const) {
    if (!v || !String(v).trim()) throw new Error(`previewGapsUrl: ${name} is required`);
  }
  const enc = encodeURIComponent;
  return `${base.replace(/\/+$/, '')}/api/w/${enc(workspace)}/opps/${enc(opp)}/runs/${enc(runId)}/preview-gaps`;
}

/**
 * Validate ace-web's response. Throws on a shape this skill cannot act on —
 * a silent `[]` would read as "every output is covered".
 */
export function parsePreviewGaps(body: unknown): PreviewGapList {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('preview-gaps: response is not a JSON object');
  }
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.outputs)) throw new Error('preview-gaps: `outputs` is not a list');
  const outputs: PreviewGap[] = b.outputs.map((raw, i) => {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const phase = str(r.phase);
    const key = str(r.output_key);
    if (!phase || !key) throw new Error(`preview-gaps: outputs[${i}] lacks phase or output_key`);
    const url = str(r.url);
    return {
      id: str(r.id) || `${phase}:${key}`,
      phase,
      output_key: key,
      kind: str(r.kind) || 'link',
      title: str(r.title) || key,
      url: url || null,
      file_id: str(r.file_id) || null,
      reason: r.reason === 'not-viewable-file' ? 'not-viewable-file' : 'no-preview',
      auth: isAuth(r.auth) ? r.auth : authForUrl(url),
    };
  });
  return {
    run_id: str(b.run_id) || null,
    outputs,
    covered: typeof b.covered === 'number' ? b.covered : 0,
  };
}

/**
 * Which session opens `url` — the same host rules as ace-web's `auth_for`,
 * plus one it gets wrong today: canopy's pages under `labs…/canopy/` sit on
 * the labs HOST but sign in with canopy's own Google login, so a labs session
 * lands on accounts.google.com (observed 2026-09-29 on a DDD package URL).
 */
export function authForUrl(url: string | null | undefined): PreviewAuth {
  let host = '';
  let path = '';
  try {
    const u = new URL(String(url ?? ''));
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    return 'public';
  }
  if (host === 'labs.connect.dimagi.com' && path.startsWith('/canopy/')) return 'canopy';
  if (host === 'connect.dimagi.com') return 'connect';
  if (host === 'labs.connect.dimagi.com') return 'labs';
  if (host.endsWith('commcarehq.org')) return 'hq';
  if (host.endsWith('openchatstudio.com')) return 'ocs';
  if (host === 'drive.google.com' || host === 'docs.google.com') return 'google';
  return 'public';
}

/** The session this skill actually uses for a gap (canopy override applied). */
export function effectiveAuth(gap: PreviewGap): PreviewAuth {
  if (gap.reason === 'not-viewable-file') return 'google';
  return authForUrl(gap.url) === 'canopy' ? 'canopy' : gap.auth;
}

// ---------------------------------------------------------------------------
// Which gaps this invocation handles
// ---------------------------------------------------------------------------

const APP_WALK_PHASE_ORDINAL = 6; // qa-and-training — the emulator walk is the primary app writer

function ordinalOf(phase: string): number | null {
  const key = normalizePhaseKey(phase);
  if (!key) return null;
  return PHASE_DEFS.find((p) => p.key === key)?.ordinal ?? null;
}

export interface GapSelection {
  capture: PreviewGap[];
  deferred: Array<{ gap: PreviewGap; why: string }>;
}

/**
 * Filter the list to what THIS invocation should photograph.
 *
 * - `phaseFilter` (a phase key in either key space) keeps only that phase's
 *   outputs; absent = all phases (the run-end sweep).
 * - A CommCare app is deferred until Phase 6 has had its turn: the emulator
 *   walk (`app-screenshot-capture`) is the app's primary preview writer and the
 *   HQ form summary is only the fallback when it left none. So at the end of
 *   Phase 3 the app gap is reported as deferred, not captured. The run-end
 *   sweep (`runEnd: true`) never defers — whatever is still missing then is
 *   the fallback's to fill, including a run that halted before Phase 6.
 * - `capturedPhase` is a run_state phase key: the phase the capture runs in
 *   (at run end, the last phase that ran). It becomes the index's
 *   `captured_phase`, which is when ace-web's replay reveals the frames.
 */
export function selectGaps(
  gaps: readonly PreviewGap[],
  opts: { phaseFilter?: string; capturedPhase: string; runEnd?: boolean },
): GapSelection {
  const filterKey = opts.phaseFilter ? normalizePhaseKey(opts.phaseFilter) : undefined;
  if (opts.phaseFilter && !filterKey) throw new Error(`unknown phase filter ${opts.phaseFilter}`);
  const capOrdinal = opts.runEnd ? Infinity : ordinalOf(opts.capturedPhase) ?? Infinity;
  const out: GapSelection = { capture: [], deferred: [] };
  for (const gap of gaps) {
    if (filterKey && normalizePhaseKey(gap.phase) !== filterKey) continue;
    if (gap.kind === 'commcare_app' && capOrdinal < APP_WALK_PHASE_ORDINAL) {
      out.deferred.push({ gap, why: 'app previews come from the Phase 6 emulator walk; the HQ fallback runs after it' });
      continue;
    }
    out.capture.push(gap);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Where the frames go
// ---------------------------------------------------------------------------

/** `<N>-<phase>` for the phase that BUILT the output (from PHASE_DEFS). */
export function phaseFolderForGap(gap: Pick<PreviewGap, 'phase'>): string {
  const key = normalizePhaseKey(gap.phase);
  if (!key) throw new Error(`gap phase ${JSON.stringify(gap.phase)} is not a known phase`);
  return phaseFolder(key as Phase);
}

/** `<N>-<phase>/previews/<slug>` relative to the run folder. */
export function captureFolderPath(gap: PreviewGap): string {
  return previewsFolderPath(phaseFolderForGap(gap), gap.output_key);
}

// ---------------------------------------------------------------------------
// The product node, read from the run's own run_state
// ---------------------------------------------------------------------------

/**
 * `phases.<phase>.products.<output_key>` from a parsed run_state — for fields
 * the gap does not carry (a chatbot's `public_url`, a solicitation's
 * `labs_program_id`, a program's `name`). Numeric segments index lists.
 */
export function productNodeAt(runState: unknown, phase: string, outputKey: string): Record<string, unknown> | null {
  const phases = rec(rec(runState).phases);
  let node: unknown = rec(phases[phase]).products;
  for (const seg of outputKey.split('.')) {
    if (Array.isArray(node) && /^\d+$/.test(seg)) node = node[Number(seg)];
    else node = rec(node)[seg];
    if (node === undefined || node === null) return null;
  }
  return node && typeof node === 'object' && !Array.isArray(node) ? (node as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// The shot plan — what makes a GOOD screenshot for each kind
// ---------------------------------------------------------------------------

export type ShotMode =
  /** The top of the page at 1440×900 after the page settles. */
  | 'viewport'
  /** Scroll the first element containing `text` to the top, then the viewport. */
  | 'scroll-to-text'
  /** The smallest card that contains `text`, as an element screenshot. */
  | 'card';

export interface Shot {
  step: string;
  mode: ShotMode;
  text?: string;
  caption: string;
}

export type CaptureStrategy = 'page' | 'ocs-chat' | 'drive-file';

export interface CapturePlan {
  gap: PreviewGap;
  auth: PreviewAuth;
  strategy: CaptureStrategy;
  /** Page to open (null for drive-file). */
  url: string | null;
  shots: Shot[];
  /** ocs-chat only — the one real question to ask. */
  question?: string;
  /** Set when there is nothing that CAN be captured; the reason is reported. */
  skip?: string;
  folder: string;
}

export interface PlanContext {
  /** `productNodeAt(runState, gap.phase, gap.output_key)`. */
  product?: Record<string, unknown> | null;
  /** From `pickChatQuestion(test prompts)` — required for a chatbot. */
  chatQuestion?: string | null;
}

/**
 * The per-kind shot plan. Mirrors the spec's table:
 *
 * | Kind | Screenshot(s) |
 * |---|---|
 * | Connect program | its card on the org's Programs page (Connect has no program detail route — the recorded `/program/<uuid>/` 404s) |
 * | Connect opportunity | top of its page; then its Verification / payments section |
 * | Chatbot | the PUBLIC chat with one real Phase 2 question answered — never the admin page |
 * | Solicitation | its labs page, opened in the solicitation's own program context |
 * | Labs dashboard / report | the rendered report with data loaded (top of page) |
 * | Demo-walkthrough package | the canopy package page, at its walkthrough's first scene |
 * | CommCare app (fallback) | the HQ app's Form Summary |
 * | Drive file the viewer cannot draw | Drive's thumbnail, or a render of the file |
 */
export function planCapture(gap: PreviewGap, ctx: PlanContext = {}): CapturePlan {
  const folder = captureFolderPath(gap);
  const auth = effectiveAuth(gap);
  const product = ctx.product ?? null;
  const t = gap.title;
  const base = { gap, auth, folder };

  if (gap.reason === 'not-viewable-file' || auth === 'google') {
    const fileId = gap.file_id ?? driveFileId(gap.url);
    if (!fileId) return { ...base, strategy: 'drive-file', url: null, shots: [], skip: 'no Drive file id on the gap' };
    return {
      ...base,
      strategy: 'drive-file',
      url: null,
      shots: [{ step: 'first-page', mode: 'viewport', caption: `${t} — first page` }],
    };
  }

  if (!gap.url) return { ...base, strategy: 'page', url: null, shots: [], skip: 'the gap has no url' };

  switch (gap.kind) {
    case 'connect_program': {
      const listUrl = connectProgramListUrl(gap.url);
      const name = str(product?.name) || str(product?.title) || t;
      if (!listUrl) return { ...base, strategy: 'page', url: gap.url, shots: [], skip: `not a Connect program url: ${gap.url}` };
      return {
        ...base,
        strategy: 'page',
        url: listUrl,
        shots: [{ step: 'program-card', mode: 'card', text: name, caption: `Connect program "${name}" — its card on the Programs page: delivery type, dates, budget and invite funnel` }],
      };
    }
    case 'connect_opportunity':
      return {
        ...base,
        strategy: 'page',
        url: gap.url,
        shots: [
          { step: 'overview', mode: 'viewport', caption: `Connect opportunity "${t}" — apps, payment units, dates and budget` },
          { step: 'verification', mode: 'scroll-to-text', text: 'Verification', caption: `Connect opportunity "${t}" — verification and worker payments` },
        ],
      };
    case 'chatbot': {
      const publicUrl = ocsPublicUrl(product);
      if (!publicUrl) return { ...base, strategy: 'ocs-chat', url: null, shots: [], skip: 'no public chat url (products.ocs_chatbot.public_url, or team_slug + public_id)' };
      const q = (ctx.chatQuestion ?? '').trim();
      if (!q) return { ...base, strategy: 'ocs-chat', url: publicUrl, shots: [], skip: 'no Phase 2 test question to ask (2-scenarios/pdd-to-test-prompts.md)' };
      return {
        ...base,
        strategy: 'ocs-chat',
        url: publicUrl,
        question: q,
        shots: [{ step: 'answer', mode: 'viewport', caption: `Support chatbot answering: "${truncate(q, 120)}"` }],
      };
    }
    case 'solicitation':
      return {
        ...base,
        strategy: 'page',
        url: withLabsProgramContext(gap.url, product),
        shots: [{ step: 'solicitation', mode: 'viewport', caption: `Solicitation "${t}" as a candidate organisation sees it on labs` }],
      };
    case 'commcare_app': {
      const summary = hqFormSummaryUrl(gap.url);
      return {
        ...base,
        strategy: 'page',
        url: summary ?? gap.url,
        shots: [{ step: 'form-summary', mode: 'viewport', caption: `${t} — HQ form summary: modules and forms` }],
      };
    }
    case 'walkthrough':
      return {
        ...base,
        strategy: 'page',
        url: gap.url,
        // Not the top of the page: its hero is an H.264 video, which headless
        // Chromium cannot decode, so it paints as a white box (observed
        // 2026-09-29). The slideshow's first scene shows the narrative over the
        // live dashboard. Anchored on the section's own label — the sidebar
        // also says "Walkthrough slides".
        shots: [
          { step: 'first-scene', mode: 'scroll-to-text', text: 'canopy:walkthrough slideshow', caption: `${t} — the canopy demo package: the walkthrough's first scene over the live dashboard` },
        ],
      };
    default:
      // dashboard, a labs report recorded as a plain link, anything else with a url
      return {
        ...base,
        strategy: 'page',
        url: gap.url,
        shots: [{ step: auth === 'labs' ? 'report' : 'page', mode: 'viewport', caption: `${t} — ${auth === 'labs' ? 'the rendered report with its data' : 'top of the page'}` }],
      };
  }
}

/** File name for the Nth accepted frame of a plan. */
export function captureFileName(ordinal: number, shot: Pick<Shot, 'step'>): string {
  return previewFileName(ordinal, shot.step);
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/**
 * `…/a/<org>/program/<uuid>/` → `…/a/<org>/program/`. Connect serves no program
 * detail page (checked 2026-09-29: `/program/<uuid>/`, `/view/`, `/edit/` and
 * `/opportunity/` under it all 404 `Resolver404`), so the org's Programs list
 * — where each program is a card — is the page that shows it.
 */
export function connectProgramListUrl(url: string): string | null {
  const m = /^(https?:\/\/[^/]+\/a\/[^/]+\/program\/)/.exec(url);
  return m ? m[1] : null;
}

/** HQ app url → its Form Summary (`…/apps/view/<id>/summary/`). */
export function hqFormSummaryUrl(url: string): string | null {
  const m = /^(https?:\/\/[^/]*commcarehq\.org\/a\/[^/]+\/apps\/view\/[0-9a-f]+\/)/i.exec(url);
  return m ? `${m[1]}summary/` : null;
}

/**
 * Labs keeps a STICKY context (last program/opportunity viewed) and a
 * solicitation outside it reads "Solicitation not found" (404) for a user who
 * can see it — observed 2026-09-29, solicitation 22869 under a leftover
 * `opportunity_id=10065` context → 404; `?program_id=309` → 200. So a
 * solicitation is opened in its own program's context.
 */
export function withLabsProgramContext(url: string, product: Record<string, unknown> | null | undefined): string {
  const programId = str(product?.labs_program_id) || str(product?.program_id);
  if (!programId) return url;
  try {
    const u = new URL(url);
    if (u.searchParams.has('program_id') || u.searchParams.has('opportunity_id')) return url;
    u.searchParams.set('program_id', programId);
    return u.toString();
  } catch {
    return url;
  }
}

/** The anonymous chat URL: `public_url` when recorded, else built from team + public id. */
export function ocsPublicUrl(product: Record<string, unknown> | null | undefined): string | null {
  const recorded = str(product?.public_url);
  if (recorded) return recorded;
  const team = str(product?.team_slug);
  const publicId = str(product?.public_id);
  if (!team || !publicId) return null;
  return buildOcsPublicChatUrl({ teamSlug: team, publicId });
}

export function driveFileId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /\/d\/([A-Za-z0-9_-]{10,})/.exec(url) ?? /[?&]id=([A-Za-z0-9_-]{10,})/.exec(url);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// The chat question
// ---------------------------------------------------------------------------

const ADVERSARIAL = new Set([
  'should-refuse',
  'out-of-scope',
  'hallucination-probe',
  'leading-question',
  'negative-frame',
  'safety-critical',
  'ambiguous-intent',
]);

/**
 * One REAL question from Phase 2's `pdd-to-test-prompts.md` for the chatbot
 * picture: the first prompt that is not adversarial, expects no escalation and
 * is not the generic "what is this opportunity about" opener (a picture of the
 * bot answering a specific worker question says more). Falls back to the first
 * non-adversarial prompt. Tolerates a `text/markdown` export's escapes.
 */
export function pickChatQuestion(markdown: string): string | null {
  const doc = normalizeDriveExport(String(markdown ?? ''));
  const heads = [...doc.matchAll(/^##\s+Prompt\s+\d+[^\n]*$/gim)];
  const prompts = heads.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index ?? doc.length : doc.length;
    const body = doc.slice(start, end);
    const field = (name: string) => {
      const r = new RegExp(`\\*\\*${name}:?\\*\\*:?\\s*([^\\n]+)`, 'i').exec(body);
      return r ? r[1].trim() : '';
    };
    return { category: field('Category').toLowerCase(), question: field('Question'), escalation: field('Expected escalation').toLowerCase() };
  });
  const usable = prompts.filter((p) => p.question && !ADVERSARIAL.has(p.category));
  const specific = usable.find(
    (p) => (p.escalation === '' || p.escalation.startsWith('none')) && !/what is this (opportunity|programme|program) about/i.test(p.question),
  );
  return (specific ?? usable[0])?.question ?? null;
}

// ---------------------------------------------------------------------------
// Screening a captured page — the deterministic pre-check before the LOOK
// ---------------------------------------------------------------------------

export interface PageSignals {
  status: number;
  finalUrl: string;
  title: string;
  /** `document.body.innerText`, whitespace-collapsed. */
  text: string;
}

export interface ScreenResult {
  ok: boolean;
  reason?: 'login' | 'error' | 'not-found' | 'maintenance' | 'blank' | 'loading';
  detail?: string;
}

/**
 * Catch the frames that are certainly bad before anyone looks at them: a login
 * page, an HTTP error, a 404 body, OCS's maintenance page, a near-empty page, a
 * page still loading. Every frame that PASSES is still viewed by the skill —
 * this rejects the obvious, it does not certify the rest.
 */
export function screenPage(s: PageSignals): ScreenResult {
  const url = s.finalUrl.toLowerCase();
  const text = s.text.replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  if (
    /accounts\.google\.com|\/accounts\/login|\/labs\/login|\/oauth\/authorize|\/login\/?(\?|$)/.test(url) ||
    /^sign in\b|sign in - google accounts/i.test(s.title)
  ) {
    return { ok: false, reason: 'login', detail: `landed on a login page: ${s.finalUrl}` };
  }
  if (s.status === 503 || /temporarily unavailable|under maintenance/.test(lower)) {
    return { ok: false, reason: 'maintenance', detail: `maintenance / unavailable page (HTTP ${s.status})` };
  }
  if (s.status === 404 || /page not found|resolver404|solicitation not found|\bnot found\b.{0,20}$/i.test(text.slice(0, 400))) {
    return { ok: false, reason: 'not-found', detail: `not found (HTTP ${s.status})` };
  }
  if (s.status >= 400) return { ok: false, reason: 'error', detail: `HTTP ${s.status}` };
  if (/server error|traceback|something went wrong/.test(lower.slice(0, 600))) {
    return { ok: false, reason: 'error', detail: 'error text on the page' };
  }
  if (text.length < 80) return { ok: false, reason: 'blank', detail: `only ${text.length} characters of text` };
  if (text.length < 400 && /\bloading\b|please wait/.test(lower)) {
    return { ok: false, reason: 'loading', detail: 'the page is still loading' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

export interface AcceptedFrame {
  file_id: string;
  name: string;
  caption: string;
}

/** `_previews.yaml` for one gap, stamped `captured_by: output-preview-capture`. */
export function buildCaptureIndex(
  gap: PreviewGap,
  capturedPhase: string,
  capturedAt: string,
  frames: readonly AcceptedFrame[],
): PreviewsIndex {
  const inputs: PreviewFrameInput[] = frames.map((f) => ({ file_id: f.file_id, name: f.name, caption: f.caption }));
  return buildPreviewsIndex({
    phase: gap.phase,
    outputKey: gap.output_key,
    capturedBy: CAPTURED_BY,
    capturedPhase,
    capturedAt,
    frames: inputs,
  });
}

// ---------------------------------------------------------------------------

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function isAuth(v: unknown): v is PreviewAuth {
  return typeof v === 'string' && ['connect', 'labs', 'hq', 'ocs', 'google', 'public', 'canopy'].includes(v);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}
