/**
 * ace#1047 fix 2 — "this AVD completed an ACE bootstrap", recorded as evidence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readProvisionedMarker,
  writeProvisionedMarker,
  markerProvesFor,
  markerPath,
} from '../../../mcp/mobile/avd-provisioned-marker';
import {
  resolveActiveSelectorMapId,
  newestSelectorMapVersion,
} from '../../../mcp/mobile/recipe-resolver';
import { fileURLToPath } from 'node:url';

let home: string;
const AVD = 'ACE_Pixel_API_34';

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'ace-avdhome-'));
  mkdirSync(path.join(home, `${AVD}.avd`), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('round-trip', () => {
  it('writes then reads back', () => {
    expect(writeProvisionedMarker(home, AVD, {
      marked_at: '2026-08-14T10:00:00Z', selector_map: 'connect-2.63.2',
    })).toBe(true);
    expect(readProvisionedMarker(home, AVD)).toMatchObject({
      marked_at: '2026-08-14T10:00:00Z', selector_map: 'connect-2.63.2',
    });
  });

  it('lands inside the AVD directory, so it travels with the AVD', () => {
    expect(markerPath(home, AVD)).toBe(path.join(home, `${AVD}.avd`, '.ace-provisioned.json'));
  });
});

describe('absent or unusable reads as NOT proven, never as an error', () => {
  it('returns null when no marker exists', () => {
    expect(readProvisionedMarker(home, AVD)).toBeNull();
  });

  it('returns null for a nonexistent AVD', () => {
    expect(readProvisionedMarker(home, 'ACE_Nope')).toBeNull();
  });

  it('returns null for corrupt JSON rather than throwing', () => {
    writeFileSync(markerPath(home, AVD), '{not json');
    expect(readProvisionedMarker(home, AVD)).toBeNull();
  });

  it('returns null for JSON missing marked_at', () => {
    writeFileSync(markerPath(home, AVD), JSON.stringify({ selector_map: 'x' }));
    expect(readProvisionedMarker(home, AVD)).toBeNull();
  });
});

describe('writing never breaks the bootstrap that just succeeded', () => {
  it('returns false instead of throwing when the directory is unwritable', () => {
    const dir = path.join(home, `${AVD}.avd`);
    chmodSync(dir, 0o500);
    try {
      expect(writeProvisionedMarker(home, AVD, { marked_at: 'now' })).toBe(false);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('returns false for an AVD directory that does not exist', () => {
    expect(writeProvisionedMarker(home, 'ACE_Missing', { marked_at: 'now' })).toBe(false);
  });
});

/**
 * ace#1993 — the drift guard was dead code, and the header promised the
 * opposite of what the code did.
 *
 * `markerProvesFor` returned `true` whenever the caller passed no map, and all
 * three call sites passed `process.env.ACE_SELECTOR_MAP` — a variable set
 * nowhere in the repo, absent from `.env.tpl`, and absent from the installed
 * `.env`. Measured on this host before the fix:
 *
 *     marker read          : {"marked_at":"2026-09-01T14:00:21.449Z"}
 *     ACE_SELECTOR_MAP env : (unset)
 *     markerProvesFor      -> true
 *
 * So every marker on every host was unknown-map, and every one was assumed
 * good — while the module header told the reader that unknown was treated as
 * not-proven. Latent only because `proven` gates the FALLBACK branch of
 * `selectAvd`, unreachable with a pool of one; PR #1989 shipped
 * `/ace:mobile-bootstrap --pool N`, which makes it reachable.
 *
 * The tests below are behavioural (the four ways to answer) plus a source
 * ratchet on the call sites, because the unit tests were ALREADY green before
 * this fix: they passed an explicit `selectorMap`, which production never did.
 * Testing the predicate could not catch a defect that lived in what was handed
 * to it.
 */
describe('markerProvesFor fails closed in every direction (ace#1993)', () => {
  const m = (selector_map?: string) => ({ marked_at: 'now', selector_map });
  const MAP_A = 'connect-2.63.2@a1b2c3d4e5f6';
  const MAP_B = 'connect-2.62.0@0f9e8d7c6b5a';

  it('proves only when both sides are known AND equal', () => {
    expect(markerProvesFor(m(MAP_A), MAP_A)).toBe(true);
  });

  it('does NOT prove across a map change — the #591/#593 drift trap', () => {
    expect(markerProvesFor(m(MAP_B), MAP_A)).toBe(false);
  });

  // POSITIVE CONTROL. This is the case that returned `true` on every ACE
  // workstation, for every marker, every time.
  it('does NOT prove from a marker with no recorded map', () => {
    expect(markerProvesFor(m(undefined), MAP_A)).toBe(false);
  });

  // POSITIVE CONTROL. The old code took this branch unconditionally, because
  // the only value ever passed was `undefined`.
  it('does NOT prove when the active map cannot be determined', () => {
    expect(markerProvesFor(m(MAP_A), undefined)).toBe(false);
    expect(markerProvesFor(m(undefined), undefined)).toBe(false);
  });

  it('never proves from a missing marker', () => {
    expect(markerProvesFor(null, MAP_A)).toBe(false);
    expect(markerProvesFor(null, undefined)).toBe(false);
  });

  // Non-inertness: the predicate is not a constant `false`.
  it('is not inert — a matching pair still proves', () => {
    const answers = [
      markerProvesFor(m(MAP_A), MAP_A),
      markerProvesFor(m(MAP_B), MAP_B),
    ];
    expect(answers).toEqual([true, true]);
  });

  // The SHA half is what makes an EDIT to a map count as drift. A
  // version-only identity would call these two the same map.
  it('distinguishes two revisions of the SAME apk version', () => {
    expect(markerProvesFor(m('connect-2.63.2@aaaaaaaaaaaa'), 'connect-2.63.2@bbbbbbbbbbbb')).toBe(false);
  });
});

describe('resolveActiveSelectorMapId reads the map ACE actually loads (ace#1993)', () => {
  it('returns connect-<apkVersion>@<sha12> for the pinned map', () => {
    const prev = process.env.ACE_CONNECT_APK_VERSION;
    process.env.ACE_CONNECT_APK_VERSION = '2.62.0';
    try {
      const id = resolveActiveSelectorMapId();
      expect(id).toMatch(/^connect-2\.62\.0@[0-9a-f]{12}$/);
    } finally {
      if (prev === undefined) delete process.env.ACE_CONNECT_APK_VERSION;
      else process.env.ACE_CONNECT_APK_VERSION = prev;
    }
  });

  it('two different maps in the tree yield two different ids', () => {
    const prev = process.env.ACE_CONNECT_APK_VERSION;
    try {
      process.env.ACE_CONNECT_APK_VERSION = '2.62.0';
      const a = resolveActiveSelectorMapId();
      process.env.ACE_CONNECT_APK_VERSION = '2.63.2';
      const b = resolveActiveSelectorMapId();
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a).not.toBe(b);
    } finally {
      if (prev === undefined) delete process.env.ACE_CONNECT_APK_VERSION;
      else process.env.ACE_CONNECT_APK_VERSION = prev;
    }
  });

  it('falls back to the newest map on disk when nothing is pinned', () => {
    const prev = process.env.ACE_CONNECT_APK_VERSION;
    delete process.env.ACE_CONNECT_APK_VERSION;
    try {
      const newest = newestSelectorMapVersion();
      expect(newest).toBeDefined();
      expect(resolveActiveSelectorMapId()).toMatch(
        new RegExp(`^connect-${newest!.replace(/\./g, '\\.')}@[0-9a-f]{12}$`),
      );
    } finally {
      if (prev !== undefined) process.env.ACE_CONNECT_APK_VERSION = prev;
    }
  });

  it('fails closed — an apk version with no map on disk yields undefined', () => {
    const prev = process.env.ACE_CONNECT_APK_VERSION;
    process.env.ACE_CONNECT_APK_VERSION = '9.99.9';
    try {
      expect(resolveActiveSelectorMapId()).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.ACE_CONNECT_APK_VERSION;
      else process.env.ACE_CONNECT_APK_VERSION = prev;
    }
  });
});

/**
 * The ratchet the behavioural tests structurally cannot provide.
 *
 * Before this fix, every assertion in this file passed while the guard was
 * inert in production — because the defect was in the ARGUMENT, not the
 * function. So pin the argument: a call site may only ask the repo what map is
 * in force, never an environment variable nobody populates.
 */
describe('markerProvesFor call sites resolve the map from the repo (ace#1993)', () => {
  const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
  const CALL_SITES = [
    'mcp/mobile/backends/avd.ts',
    'scripts/doctor-avd-pool.ts',
  ];

  it.each(CALL_SITES)('%s passes resolveActiveSelectorMapId()', (rel) => {
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    // Line-scoped rather than paren-balanced: these are single-line calls, and
    // a naive `[^)]*` stops at the inner `)` of the argument itself.
    const calls = src.split('\n').filter((l) => l.includes('markerProvesFor('));
    expect(calls.length, `no markerProvesFor call found in ${rel}`).toBeGreaterThan(0);
    for (const line of calls) {
      expect(line.trim(), `${rel}`).toContain('resolveActiveSelectorMapId()');
      expect(line).not.toContain('process.env');
    }
  });

  it('the marker WRITER records the same identity the readers compare against', () => {
    const src = readFileSync(path.join(ROOT, 'mcp/mobile/client.ts'), 'utf8');
    expect(src).toMatch(/selector_map:\s*resolveActiveSelectorMapId\(\)/);
  });

  it('no runtime code reads ACE_SELECTOR_MAP any more', () => {
    for (const rel of [...CALL_SITES, 'mcp/mobile/client.ts', 'mcp/mobile/avd-provisioned-marker.ts']) {
      const src = readFileSync(path.join(ROOT, rel), 'utf8')
        // Strip block comments: the marker module documents the retired var by
        // name, on purpose, so the next reader knows what changed.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      expect(src, `${rel} still reads ACE_SELECTOR_MAP`).not.toContain('ACE_SELECTOR_MAP');
    }
  });
});
