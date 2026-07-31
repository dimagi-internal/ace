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

export function clearSpool(opts: SpoolOpts = {}): void {
  try {
    fs.rmSync(spoolDir(opts), { recursive: true, force: true });
  } catch (e) {
    logInfo(`clearSpool: failed: ${String(e)}`);
  }
}
