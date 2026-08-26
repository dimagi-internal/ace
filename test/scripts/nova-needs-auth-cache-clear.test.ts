import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { clearNovaNeedsAuthEntry } from '../../scripts/clear-nova-needs-auth-cache.mjs';

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1579. #582 taught the doctor to DETECT the stuck
// `plugin:nova:nova` needs-auth entry, but detection alone cannot converge:
// Claude Code rewrites the entry at every session startup without re-attempting
// auth (nova-plugin#11), so the halt repeats on every restart until the key is
// deleted. Measured on spark-facilitator/20260820-0817 — two restarts, zero
// progress, because nothing performed the remediation the doctor printed.
//
// The behavioural half of this file pins the clear itself; the wiring half pins
// that BOTH doctor surfaces actually call it, since a helper nobody invokes is
// exactly the failure mode being fixed.
// ---------------------------------------------------------------------------

const DOCTOR = readFileSync(fileURLToPath(new URL('../../bin/ace-doctor', import.meta.url)), 'utf8');

const OTHER = {
  'plugin:canopy:canopy-gws': { timestamp: 1787532637754, id: 'a773fde322173025' },
  atlassian: { timestamp: 1787250011207 },
};

describe('clearNovaNeedsAuthEntry', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ace-nova-cache-'));
    file = join(dir, 'mcp-needs-auth-cache.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(obj: unknown) {
    writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
  }
  function read(): Record<string, unknown> {
    return JSON.parse(readFileSync(file, 'utf8'));
  }

  it('removes the plugin:nova:nova entry and reports "cleared"', () => {
    write({ ...OTHER, 'plugin:nova:nova': { timestamp: 1787532638081 } });

    expect(clearNovaNeedsAuthEntry(file)).toBe('cleared');
    expect('plugin:nova:nova' in read()).toBe(false);
  });

  it('leaves every OTHER agent\'s cached entry untouched', () => {
    // The blast radius matters: this file is shared with canopy/atlassian, and
    // clearing a sibling's entry would break a different plugin's auth.
    write({ ...OTHER, 'plugin:nova:nova': { timestamp: 1787532638081 } });

    clearNovaNeedsAuthEntry(file);

    expect(read()).toEqual(OTHER);
  });

  it('is idempotent — a second call is "absent", not an error', () => {
    write({ ...OTHER, 'plugin:nova:nova': { timestamp: 1 } });

    expect(clearNovaNeedsAuthEntry(file)).toBe('cleared');
    expect(clearNovaNeedsAuthEntry(file)).toBe('absent');
    expect(read()).toEqual(OTHER);
  });

  it('reports "absent" for a missing file without creating one', () => {
    expect(clearNovaNeedsAuthEntry(join(dir, 'nope.json'))).toBe('absent');
    expect(existsSync(join(dir, 'nope.json'))).toBe(false);
  });

  it('refuses to rewrite an unparseable cache', () => {
    // Truncating Claude Code's own state would be a worse failure than the one
    // we came to fix, so a corrupt file is reported, never overwritten.
    writeFileSync(file, '{ not json');

    expect(clearNovaNeedsAuthEntry(file)).toBe('unparseable');
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
  });

  it('treats a non-object JSON cache as unparseable rather than crashing', () => {
    writeFileSync(file, '[]');
    expect(clearNovaNeedsAuthEntry(file)).toBe('unparseable');
  });
});

describe('bin/ace-doctor wires the auto-clear', () => {
  it('invokes the helper from BOTH the preflight and the human surface', () => {
    const hits = DOCTOR.match(/scripts\/clear-nova-needs-auth-cache\.mjs/g) ?? [];
    // 2 existence guards + 2 invocations, one pair per surface.
    expect(hits.length).toBeGreaterThanOrEqual(4);
  });

  it('emits `cleared` in the preflight YAML so the orchestrator can report it', () => {
    expect(DOCTOR).toContain('cleared: ${PF_NOVA_CACHE_CLEARED}');
  });

  it('still reports `fail` after clearing — the restart stays mandatory', () => {
    // The MCP subprocess cannot be respawned in-session, so auto-clearing must
    // NOT downgrade the halt; it only makes ONE restart sufficient.
    expect(DOCTOR).toContain('PF_NOVA_CACHE_STATUS=fail');
    const cleared = DOCTOR.indexOf('PF_NOVA_CACHE_CLEARED=true');
    expect(cleared).toBeGreaterThan(-1);
    expect(DOCTOR).not.toMatch(/PF_NOVA_CACHE_CLEARED=true[\s\S]{0,400}PF_NOVA_CACHE_STATUS=(pass|warn)/);
  });

  it('only clears when NOVA_API_KEY is present — a keyless entry may be correct', () => {
    const guard = DOCTOR.indexOf('if [ "$PF_NOVA_KEY_PRESENT" = "true" ]; then');
    const clear = DOCTOR.indexOf('clear-nova-needs-auth-cache.mjs');
    expect(guard).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(guard);
  });
});
