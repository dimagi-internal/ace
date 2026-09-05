/**
 * ace#1821 (visibility half) — the session lock carries the opp, and a second
 * session on the same opp is NAMED rather than blocked.
 *
 * The load-bearing case in this file is the one that asserts the message says
 * it is not a block. The operator's framing was explicit — "that's an error I
 * can live with since it would be my own fault" — so a future change that
 * turns this into a refusal would be a regression against a stated decision,
 * not a tightening. `MUST NOT REFUSE` below is what fails if someone does.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeOppCollision,
  detectOppCollisions,
  mergeSessionLockContext,
  resolveSessionOppContext,
  type SessionLockView,
} from '../../lib/session-opp-collision.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const lock = (over: Partial<SessionLockView> & { mcp_pid: number }): SessionLockView => ({
  started_at: '2026-09-05T10:00:00.000Z',
  ...over,
});

describe('resolveSessionOppContext', () => {
  it('is empty with neither an argument nor env — the feature is inert by default', () => {
    expect(resolveSessionOppContext(undefined, {})).toEqual({});
  });

  it('reads the env fallback', () => {
    expect(
      resolveSessionOppContext(undefined, { ACE_OPP_SLUG: 'bednet', ACE_RUN_ID: '20260905-0912' }),
    ).toEqual({ opp_slug: 'bednet', run_id: '20260905-0912' });
  });

  it('lets the call argument win — an .env write needs a Claude restart, a call argument does not', () => {
    expect(
      resolveSessionOppContext({ opp_slug: 'turmeric' }, { ACE_OPP_SLUG: 'bednet' }),
    ).toEqual({ opp_slug: 'turmeric' });
  });

  it('treats blank and whitespace as absent rather than as a slug', () => {
    expect(resolveSessionOppContext({ opp_slug: '   ' }, { ACE_OPP_SLUG: '' })).toEqual({});
  });

  it('trims — a trailing newline from a shell capture must not fork the identity', () => {
    expect(resolveSessionOppContext(undefined, { ACE_OPP_SLUG: 'bednet\n' })).toEqual({
      opp_slug: 'bednet',
    });
  });
});

describe('mergeSessionLockContext', () => {
  it('adds the context without disturbing the ports the reaper depends on', () => {
    const existing = { mcp_pid: 5784, adb_port: 5039, emulator_port: 5556 };
    const next = mergeSessionLockContext(existing, {
      opp_slug: 'bednet',
      run_id: '20260905-0912',
      avd_name: 'ACE_Pixel_API_34_b',
    });
    expect(next).toEqual({
      mcp_pid: 5784,
      adb_port: 5039,
      emulator_port: 5556,
      opp_slug: 'bednet',
      run_id: '20260905-0912',
      avd_name: 'ACE_Pixel_API_34_b',
    });
  });

  it('never mutates the input', () => {
    const existing = { mcp_pid: 1 };
    mergeSessionLockContext(existing, { opp_slug: 'x' });
    expect(existing).toEqual({ mcp_pid: 1 });
  });

  it('a blank patch value cannot ERASE a real one', () => {
    const existing = { mcp_pid: 1, opp_slug: 'bednet', avd_name: 'ACE_Pixel_API_34' };
    expect(mergeSessionLockContext(existing, { opp_slug: '  ', run_id: undefined })).toEqual(
      existing,
    );
  });
});

describe('detectOppCollisions', () => {
  const others = [
    lock({ mcp_pid: 5784, opp_slug: 'bednet', run_id: '20260905-0801', avd_name: 'ACE_Pixel_API_34' }),
    lock({ mcp_pid: 68171, opp_slug: 'turmeric' }),
    lock({ mcp_pid: 36135 }), // never told its opp
    lock({ mcp_pid: 4263, opp_slug: 'bednet', run_id: '20260905-0844' }),
  ];

  it('names every other live session on the same opp, pid-ordered', () => {
    const hits = detectOppCollisions({ mcp_pid: 75780, opp_slug: 'bednet' }, others);
    expect(hits.map((h) => h.mcp_pid)).toEqual([4263, 5784]);
  });

  it('does not collide with ITSELF', () => {
    const hits = detectOppCollisions({ mcp_pid: 5784, opp_slug: 'bednet' }, others);
    expect(hits.map((h) => h.mcp_pid)).toEqual([4263]);
  });

  it('a session that was never told its opp collides with nothing', () => {
    expect(detectOppCollisions({ mcp_pid: 1 }, others)).toEqual([]);
    expect(detectOppCollisions({ mcp_pid: 1, opp_slug: '  ' }, others)).toEqual([]);
  });

  it('matches exactly — no case-folding, no prefix match', () => {
    expect(detectOppCollisions({ mcp_pid: 1, opp_slug: 'BEDNET' }, others)).toEqual([]);
    expect(detectOppCollisions({ mcp_pid: 1, opp_slug: 'bed' }, others)).toEqual([]);
  });

  it('ignores locks with no opp — they are not evidence of anything', () => {
    const hits = detectOppCollisions({ mcp_pid: 1, opp_slug: 'bednet' }, [lock({ mcp_pid: 2 })]);
    expect(hits).toEqual([]);
  });
});

describe('describeOppCollision', () => {
  const collisions = [
    lock({
      mcp_pid: 5784,
      opp_slug: 'bednet',
      run_id: '20260905-0801',
      avd_name: 'ACE_Pixel_API_34',
      started_at: '2026-09-05T08:01:00.000Z',
    }),
  ];

  it('is silent when there is nothing to say', () => {
    expect(describeOppCollision('bednet', [])).toBeNull();
    expect(describeOppCollision(undefined, collisions)).toBeNull();
  });

  it('is ACTIONABLE — names the other pid, its run and its AVD', () => {
    const msg = describeOppCollision('bednet', collisions)!;
    expect(msg).toContain('pid 5784');
    expect(msg).toContain('run 20260905-0801');
    expect(msg).toContain('ACE_Pixel_API_34');
    expect(msg).toContain("opp 'bednet'");
  });

  it('MUST NOT REFUSE — it says outright that nothing was blocked', () => {
    const msg = describeOppCollision('bednet', collisions)!;
    expect(msg).toMatch(/warning, not a block/i);
    expect(msg).toMatch(/proceeding/i);
    // A future change that turns this into a gate would have to delete the
    // line above; these catch the vocabulary of one that only half-does it.
    expect(msg).not.toMatch(/\brefus(e|ing|ed)\b/i);
    expect(msg).not.toMatch(/\baborting\b/i);
  });

  it('states the cost so the operator can weigh it', () => {
    expect(describeOppCollision('bednet', collisions)!).toMatch(/Learn completion is one-way/i);
  });

  it('admits it can only see same-account sessions — absence is not evidence of absence', () => {
    expect(describeOppCollision('bednet', collisions)!).toMatch(/per-\$HOME|same-account/i);
  });

  it('pluralises', () => {
    const one = describeOppCollision('bednet', collisions)!;
    const two = describeOppCollision('bednet', [...collisions, lock({ mcp_pid: 9, opp_slug: 'bednet' })])!;
    expect(one).toContain('1 other live session on');
    expect(two).toContain('2 other live sessions on');
  });
});

describe('CONTROL: the wiring warns, it does not throw', () => {
  /**
   * A source assertion, deliberately. The decision is pure and covered above,
   * but the thing most likely to regress is the CALL SITE — someone reading
   * "two sessions on one opp corrupts Learn" and promoting the warn to a
   * throw. That would be wrong per the operator's stated decision, and no
   * unit test of the pure function would notice.
   */
  it('client.ts emits the collision message through console.warn, never a throw', () => {
    const src = readFileSync(join(REPO_ROOT, 'mcp/mobile/client.ts'), 'utf8');
    // `describeOppCollision(` — the CALL, not the import binding.
    const idx = src.indexOf('describeOppCollision(');
    expect(idx, 'client.ts must CALL describeOppCollision').toBeGreaterThan(-1);
    // The statement region around the call: the message must reach the
    // operator via console.warn, and nothing on this path may throw.
    const region = src.slice(idx, idx + 400);
    expect(region).toContain('console.warn');
    expect(region).not.toMatch(/\bthrow\b/);
  });
});
