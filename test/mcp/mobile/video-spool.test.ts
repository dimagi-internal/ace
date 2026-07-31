import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  spoolDir, spoolVideo, listSpooled, clearSpool,
} from '../../../mcp/mobile/video-spool.js';
import type { VideoArtifact } from '../../../mcp/mobile/types.js';

let home: string;
let srcDir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-home-'));
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-src-'));
});

function artifact(name: string): VideoArtifact {
  const p = path.join(srcDir, `${name}.mp4`);
  fs.writeFileSync(p, 'VIDEO');
  return { path: p, bytes: 5, recipeId: name, dispatchId: 'abc', attempt: 1 };
}

describe('video-spool', () => {
  it('keys the spool dir by ppid under <home>/.ace/mobile-videos', () => {
    expect(spoolDir({ ppid: 4242, homeDir: home })).toBe(
      path.join(home, '.ace', 'mobile-videos', '4242'),
    );
  });

  it('copies the video in (source is left in place for the run dir)', () => {
    const a = artifact('journey-learn');
    const dest = spoolVideo(a, { ppid: 1, homeDir: home, nowMs: 1700000000000 });
    expect(dest).toBeDefined();
    expect(fs.existsSync(a.path)).toBe(true);
    expect(fs.readFileSync(dest!, 'utf8')).toBe('VIDEO');
    expect(path.basename(dest!)).toBe('1700000000000-journey-learn.mp4');
  });

  it('encodes attempt > 1 in the spooled name', () => {
    const a = { ...artifact('journey-learn'), attempt: 2 };
    const dest = spoolVideo(a, { ppid: 1, homeDir: home, nowMs: 1700000000000 });
    expect(path.basename(dest!)).toBe('1700000000000-journey-learn-attempt2.mp4');
  });

  it('lists spooled files sorted, then clears', () => {
    spoolVideo(artifact('a-recipe'), { ppid: 7, homeDir: home, nowMs: 1000 });
    spoolVideo(artifact('b-recipe'), { ppid: 7, homeDir: home, nowMs: 2000 });
    expect(listSpooled({ ppid: 7, homeDir: home }).map((p) => path.basename(p))).toEqual([
      '1000-a-recipe.mp4', '2000-b-recipe.mp4',
    ]);
    clearSpool({ ppid: 7, homeDir: home });
    expect(listSpooled({ ppid: 7, homeDir: home })).toEqual([]);
  });

  it('listSpooled on a never-used spool returns empty (not a throw)', () => {
    expect(listSpooled({ ppid: 999, homeDir: home })).toEqual([]);
  });

  it('spoolVideo returns undefined instead of throwing when the source is gone', () => {
    const a = artifact('gone');
    fs.rmSync(a.path);
    expect(spoolVideo(a, { ppid: 1, homeDir: home })).toBeUndefined();
  });
});
