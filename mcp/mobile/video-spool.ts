// mcp/mobile/video-spool.ts
//
// Per-session spool for recorded recipe videos.
//
// The mobile MCP has no Drive credentials and no run context — SKILLS do
// the uploading. But heal, registration, and baseline recipes run from
// atoms whose callers aren't uploading skills, so their videos would be
// orphaned. The spool is the handoff: `MobileClient.runRecipe` drops every
// video here, and `app-screenshot-capture` (plus qa-deep and
// connect-baseline-screenshots) sweeps it at the end of the phase.
//
// Keyed by ppid, the same per-session key `backend-toggle.ts` uses: each
// Claude Code session is its own process, and its MCP server inherits a
// unique parent pid, so two sessions on one workstation never collide.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { logInfo } from './logging.js';
import type { VideoArtifact } from './types.js';

interface SpoolOpts {
  ppid?: number;
  /** Override for tests; production always resolves the real home dir. */
  homeDir?: string;
}

export function spoolDir(opts: SpoolOpts = {}): string {
  const home = opts.homeDir ?? os.homedir();
  const ppid = opts.ppid ?? process.ppid;
  return path.join(home, '.ace', 'mobile-videos', String(ppid));
}

/**
 * Copy (not move) a recorded video into the spool. The original stays in
 * the run's screenshotDir so the per-run artifact set remains complete
 * even after the spool is swept and cleared.
 */
export function spoolVideo(
  artifact: VideoArtifact,
  opts: SpoolOpts & { nowMs?: number } = {},
): string | undefined {
  try {
    const dir = spoolDir(opts);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = opts.nowMs ?? Date.now();
    const suffix = artifact.attempt > 1 ? `-attempt${artifact.attempt}` : '';
    const dest = path.join(dir, `${stamp}-${artifact.recipeId}${suffix}.mp4`);
    fs.copyFileSync(artifact.path, dest);
    // Carry the provenance sidecar too (dimagi-internal/ace#1084). The spool
    // is what `videos/_device/` is uploaded FROM, so a video spooled without
    // its `<video>.meta.json` arrives unstamped even though the original next
    // to it in the run's screenshotDir is stamped. Best-effort and separately
    // guarded: a missing or unreadable sidecar must never cost us the video.
    try {
      const srcMeta = `${artifact.path}.meta.json`;
      if (fs.existsSync(srcMeta)) fs.copyFileSync(srcMeta, `${dest}.meta.json`);
    } catch (me) {
      logInfo(`spoolVideo: failed to copy provenance sidecar for ${artifact.path}: ${String(me)}`);
    }
    return dest;
  } catch (e) {
    logInfo(`spoolVideo: failed for ${artifact.path}: ${String(e)}`);
    return undefined;
  }
}

export function listSpooled(opts: SpoolOpts = {}): string[] {
  const dir = spoolDir(opts);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.mp4'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * How many entries the wipe would actually remove.
 *
 * `listSpooled` filters to `.mp4` because callers want RECORDINGS; `clearSpool`
 * removes the directory recursively. Reporting `cleared` from the former
 * under-reports the moment anything else lands in the spool — which is now
 * always, since `spoolVideo` writes a `.meta.json` sidecar beside each video
 * (dimagi-internal/ace#1084).
 */
export function countSpooledEntries(opts: SpoolOpts = {}): number {
  try {
    return fs.readdirSync(spoolDir(opts)).length;
  } catch {
    return 0;
  }
}

export function clearSpool(opts: SpoolOpts = {}): void {
  try {
    fs.rmSync(spoolDir(opts), { recursive: true, force: true });
  } catch (e) {
    logInfo(`clearSpool: failed: ${String(e)}`);
  }
}
