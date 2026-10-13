/**
 * MCP progress for long `mobile_run_recipe` dispatches (dimagi-internal/ace#2877).
 *
 * ## Why this exists
 *
 * Claude Code aborts any stdio MCP tool call that sends "no response or
 * progress" for `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (default 1800s for stdio).
 * A 25-form Learn walk on `smallholder-seasonal/20261012-1549` Phase 6 was
 * healthy — a screenshot every ~20s — when that abort fired, and the whole
 * tool result (screenshots[], videos[], status) was lost to the caller.
 *
 * Verified against the client, not assumed (Claude Code 2.1.296, the binary
 * this repo's sessions run): the tool-call path passes an `onprogress`
 * callback to the SDK's `callTool` — which is what makes the SDK attach
 * `_meta.progressToken` to the request — and that callback resets the idle
 * clock the watchdog reads:
 *
 *     onprogress:(N)=>{ if(ce.armedAt=0, ke=Date.now(), ...) }
 *     ... if (Y>0 && Date.now()-ke>Y) { ... "sent no response or progress for" ... }
 *
 * The per-server hard `timeout` / `MCP_TOOL_TIMEOUT` is a SEPARATE wall-clock
 * limit that progress does not extend ("Hard wall-clock limit per call;
 * progress notifications do not extend it" — Claude Code's own setting doc).
 *
 * ## What it sends
 *
 * - A REAL event at dispatch start and at every chunk start / finish — the
 *   recipe splitter's boundaries (`recipe-splitter.ts`) are the natural tick.
 * - A HEARTBEAT every `intervalMs` (30s) while the dispatch runs, because one
 *   chunk can legitimately run up to the per-chunk ceiling
 *   (`lib/maestro-chunk-timeout.ts`, 45 min) — longer than the idle window —
 *   with no boundary inside it.
 *
 * ## Why the heartbeat cannot hide a hang
 *
 * The heartbeat is BOUNDED: it stops once no real event has arrived for
 * `maxSilenceMs` (default: the per-chunk ceiling + 5 min). Every `maestro
 * test` invocation is already killed server-side at that ceiling
 * (ace#1164's watchdog, which stays the stall guard), so a silence longer
 * than it means the dispatch is stuck somewhere the watchdog does not cover —
 * and then the heartbeat goes quiet and Claude Code's idle timeout reclaims
 * the call exactly as it did before this change.
 *
 * MCP requires `progress` to increase on every notification, so it is a
 * monotonic counter; the human-readable state is in `message`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveChunkTimeout } from '../../lib/maestro-chunk-timeout.js';

/** A real progress event from the recipe runner. */
export type RecipeProgressEvent =
  | { kind: 'dispatch-start'; recipeId: string; screenshotsDir: string }
  | { kind: 'chunk-start'; chunkIndex: number; chunksTotal: number; screenshotName: string | null }
  | {
      kind: 'chunk-done';
      chunkIndex: number;
      chunksTotal: number;
      screenshotName: string | null;
      exitCode: number;
    };

export type RecipeProgressListener = (ev: RecipeProgressEvent) => void;

/** One-line, human-readable rendering of an event (the notification `message`). */
export function describeProgressEvent(ev: RecipeProgressEvent): string {
  switch (ev.kind) {
    case 'dispatch-start':
      return `recipe ${ev.recipeId} started; artifacts land in ${ev.screenshotsDir}`;
    case 'chunk-start':
      return (
        `chunk ${ev.chunkIndex}/${ev.chunksTotal} running` +
        (ev.screenshotName ? ` (ends at screenshot "${ev.screenshotName}")` : '')
      );
    case 'chunk-done':
      return (
        `chunk ${ev.chunkIndex}/${ev.chunksTotal} ${ev.exitCode === 0 ? 'passed' : `failed (exit ${ev.exitCode})`}` +
        (ev.screenshotName ? ` at screenshot "${ev.screenshotName}"` : '')
      );
  }
}

/** Call a listener without ever letting it break the walk. */
export function emitProgress(listener: RecipeProgressListener | undefined, ev: RecipeProgressEvent): void {
  if (!listener) return;
  try {
    listener(ev);
  } catch {
    /* progress is advisory — never let it change a recipe verdict */
  }
}

export interface ProgressPayload {
  progress: number;
  message: string;
}

export interface ProgressHeartbeatOptions {
  send: (p: ProgressPayload) => unknown;
  /** Heartbeat period. Default 30s — well inside the 1800s idle window. */
  intervalMs?: number;
  /** Stop heartbeating after this long without a real event. */
  maxSilenceMs?: number;
  now?: () => number;
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * The longest a healthy dispatch can go without a real event: one chunk at
 * its wall-clock ceiling (or the operator's `ACE_MOBILE_CHUNK_TIMEOUT_MS`),
 * plus 5 min for the between-chunk work (ui-dump, recorder, a cold-boot heal).
 */
export function defaultMaxSilenceMs(env: Record<string, string | undefined> = process.env): number {
  return resolveChunkTimeout({ stepCount: Number.MAX_SAFE_INTEGER, env }).timeoutMs + 5 * 60_000;
}

export interface ProgressHeartbeat {
  /** Report a real event: sent immediately, and it re-arms the heartbeat. */
  event(message: string): void;
  stop(): void;
  /** Notifications sent so far (tests / logging). */
  readonly sent: number;
}

export function createProgressHeartbeat(opts: ProgressHeartbeatOptions): ProgressHeartbeat {
  const now = opts.now ?? Date.now;
  const intervalMs = opts.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const maxSilenceMs = opts.maxSilenceMs ?? defaultMaxSilenceMs();
  const startedAt = now();
  let lastEventAt = startedAt;
  let lastMessage = 'recipe dispatch running';
  let counter = 0;
  let stopped = false;

  const send = (message: string) => {
    if (stopped) return;
    counter += 1;
    try {
      const r = opts.send({ progress: counter, message });
      if (r && typeof (r as Promise<unknown>).catch === 'function') {
        (r as Promise<unknown>).catch(() => {
          /* a closed transport must not crash the walk */
        });
      }
    } catch {
      /* same */
    }
  };

  const timer = setInterval(() => {
    const t = now();
    if (t - lastEventAt > maxSilenceMs) return; // bounded: see module doc
    send(`${lastMessage} — still running, ${Math.round((t - startedAt) / 1000)}s elapsed`);
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();

  return {
    event(message: string) {
      lastEventAt = now();
      lastMessage = message;
      send(message);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    get sent() {
      return counter;
    },
  };
}

/** The slice of the SDK's `RequestHandlerExtra` this needs. */
export interface ProgressCapableExtra {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: {
    method: 'notifications/progress';
    params: { progressToken: string | number; progress: number; message?: string };
  }) => Promise<void>;
}

/**
 * Run `fn` with a progress listener wired to MCP `notifications/progress`.
 *
 * When the request carries no `progressToken`, `fn` gets `undefined` and
 * nothing is sent — the spec forbids progress for a token the client did not
 * ask for.
 */
export async function withRecipeProgress<T>(
  extra: ProgressCapableExtra | undefined,
  fn: (onProgress: RecipeProgressListener | undefined) => Promise<T>,
  opts: Omit<ProgressHeartbeatOptions, 'send'> = {},
): Promise<T> {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra) return fn(undefined);
  const hb = createProgressHeartbeat({
    ...opts,
    send: ({ progress, message }) =>
      extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress, message },
      }),
  });
  try {
    return await fn((ev) => hb.event(describeProgressEvent(ev)));
  } finally {
    hb.stop();
  }
}

// ---------------------------------------------------------------------------
// On-disk progress record
// ---------------------------------------------------------------------------

/**
 * Written into the dispatch's own output dir and rewritten at every chunk
 * boundary, so a caller whose tool call was aborted client-side (the result
 * is then lost — ace#2877) can still read how far the walk got, alongside the
 * screenshots that are already on disk.
 */
export const DISPATCH_PROGRESS_FILE = 'dispatch-progress.json';

export interface DispatchProgressRecord {
  recipeId: string;
  dispatchId: string;
  screenshotsDir: string;
  state: 'running' | 'pass' | 'fail' | 'error';
  startedAt: string;
  updatedAt: string;
  chunksTotal: number | null;
  chunksCompleted: number;
  lastCompletedScreenshot: string | null;
  lastEvent: string;
}

/**
 * Tracks the record for one dispatch and writes it best-effort. Never throws:
 * a full disk must not change a recipe verdict.
 */
export function createDispatchProgressRecorder(init: {
  recipeId: string;
  dispatchId: string;
  screenshotsDir: string;
  now?: () => Date;
}) {
  const now = init.now ?? (() => new Date());
  const rec: DispatchProgressRecord = {
    recipeId: init.recipeId,
    dispatchId: init.dispatchId,
    screenshotsDir: init.screenshotsDir,
    state: 'running',
    startedAt: now().toISOString(),
    updatedAt: now().toISOString(),
    chunksTotal: null,
    chunksCompleted: 0,
    lastCompletedScreenshot: null,
    lastEvent: 'dispatch created',
  };
  const file = path.join(init.screenshotsDir, DISPATCH_PROGRESS_FILE);
  const write = () => {
    rec.updatedAt = now().toISOString();
    try {
      fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n', 'utf8');
    } catch {
      /* best-effort */
    }
  };
  return {
    file,
    record: rec,
    observe(ev: RecipeProgressEvent) {
      if (ev.kind === 'chunk-start' || ev.kind === 'chunk-done') rec.chunksTotal = ev.chunksTotal;
      if (ev.kind === 'chunk-done' && ev.exitCode === 0) {
        rec.chunksCompleted = ev.chunkIndex;
        if (ev.screenshotName) rec.lastCompletedScreenshot = ev.screenshotName;
      }
      rec.lastEvent = describeProgressEvent(ev);
      write();
    },
    finish(state: DispatchProgressRecord['state']) {
      rec.state = state;
      rec.lastEvent = `dispatch finished: ${state}`;
      write();
    },
  };
}
