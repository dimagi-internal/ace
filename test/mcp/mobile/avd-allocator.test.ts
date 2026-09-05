/**
 * ace#1047 fix 2 — allocate the AVD name, not just the ports.
 *
 * The observed failure: two local sessions get disjoint ports (#1030 works)
 * and still collide on the one shared AVD, because every session resolves the
 * same `ACE_AVD_NAME ?? 'ACE_Pixel_API_34'`. The emulator refuses outright,
 * and /ace:iterate's per-dispatch cold boot re-grabs it every cycle so the
 * other session is starved indefinitely.
 */
import { describe, it, expect } from 'vitest';
import {
  selectAvd,
  AvdPoolExhaustedError,
  type AvdPoolEntry,
} from '../../../mcp/mobile/avd-allocator';

/** Free AND proven — the only kind eligible as a fallback. */
const free = (name: string): AvdPoolEntry => ({ name, free: true, proven: true });
/** Free by disk images but never bootstrapped — ACE_Pixel_API_34_PS's real shape. */
const unproven = (name: string): AvdPoolEntry => ({ name, free: true, proven: false });
const held = (name: string, pid = 84948): AvdPoolEntry => ({
  name, free: false, reason: `held by live pid ${pid}`,
});
const broken = (name: string): AvdPoolEntry => ({
  name, free: false, reason: 'de-provisioned (zero *.img files)',
});

describe('selectAvd', () => {
  it('takes the requested AVD when it is free, and says nothing', () => {
    const s = selectAvd('ACE_Pixel_API_34', [free('ACE_Pixel_API_34'), free('ACE_Probe_API_34')]);
    expect(s).toEqual({ name: 'ACE_Pixel_API_34', switched: false, note: null });
  });

  it('falls back when the requested AVD is held by a live session', () => {
    const s = selectAvd('ACE_Pixel_API_34', [held('ACE_Pixel_API_34'), free('ACE_Probe_API_34')]);
    expect(s.name).toBe('ACE_Probe_API_34');
    expect(s.switched).toBe(true);
    expect(s.from).toBe('ACE_Pixel_API_34');
  });

  it('names the holder in the note, so the operator can see who has it', () => {
    const s = selectAvd('ACE_Pixel_API_34', [held('ACE_Pixel_API_34', 84948), free('B')]);
    expect(s.note).toContain('held by live pid 84948');
    expect(s.note).toContain('ace#1047');
  });

  it('never falls back onto a de-provisioned AVD', () => {
    // ACE_Pixel_API_34_PS is exactly this case: it exists, -list-avds reports
    // it, and it has no system images.
    expect(() => selectAvd('ACE_Pixel_API_34', [held('ACE_Pixel_API_34'), broken('ACE_Pixel_API_34_PS')]))
      .toThrow(AvdPoolExhaustedError);
  });

  it('falls back when the requested AVD is de-provisioned, not only when held', () => {
    const s = selectAvd('ACE_Pixel_API_34', [broken('ACE_Pixel_API_34'), free('ACE_Probe_API_34')]);
    expect(s.name).toBe('ACE_Probe_API_34');
    expect(s.note).toContain('de-provisioned');
  });

  it('handles a requested name absent from the pool entirely', () => {
    const s = selectAvd('ACE_Typo_API_34', [free('ACE_Pixel_API_34')]);
    expect(s.name).toBe('ACE_Pixel_API_34');
    expect(s.note).toContain('not in the pool');
  });
});

describe('exhaustion is actionable, not just a refusal', () => {
  const exhausted = () =>
    selectAvd('ACE_Pixel_API_34', [held('ACE_Pixel_API_34'), broken('ACE_Pixel_API_34_PS')]);

  it('lists every pool entry and why it is unavailable', () => {
    expect(exhausted).toThrow(/ACE_Pixel_API_34: held by live pid/);
    expect(exhausted).toThrow(/ACE_Pixel_API_34_PS: de-provisioned/);
  });

  it('gives the operator a way to widen the pool', () => {
    expect(exhausted).toThrow(/\/ace:mobile-bootstrap --pool 2/);
  });

  it('does not hard-code a system-image tag (ace#1821)', () => {
    // This assertion used to pin `google_apis`. Every AVD ACE actually runs on
    // is `google_apis_playstore`, and the registration recipe
    // (mcp/mobile/recipes/static/connect-register-to-otp.yaml) was verified
    // against a Play Store image — so the instruction, followed literally,
    // produced an AVD unlike the working one.
    //
    // The fix is NOT the other tag. Three repo sources say the choice is
    // immaterial: playbook/integrations/mobile-integration.md § Face-capture
    // ("the lever is runtime GMS toggle, not AVD image selection"),
    // commands/mobile-bootstrap.md ("Either image works"), and CHANGELOG's
    // auto-shutter finding (both images return SUCCESS from
    // isGooglePlayServicesAvailable; `pm disable-user` is the real lever).
    // So the message names neither and says both work.
    expect(exhausted).not.toThrow(/google_apis/);
    expect(exhausted).not.toThrow(/system-images/);
  });

  it('says the tuned config is carried over, since a stock clone boots differently', () => {
    // Still asserted, now satisfied by delegation: --pool copies the tuned
    // config from the proven member rather than the operator doing it by hand.
    expect(exhausted).toThrow(/copies the tuned config from the\s+proven member/);
  });

  it('is explicit when there are no AVDs at all', () => {
    expect(() => selectAvd('ACE_Pixel_API_34', [])).toThrow(/no AVDs found/);
  });
});

describe('two concurrent sessions do not both grab pool[0]', () => {
  const pool = [held('ACE_Pixel_API_34'), free('B'), free('C'), free('D')];

  it('staggers the first choice by pid', () => {
    const a = selectAvd('ACE_Pixel_API_34', pool, { selfPid: 84948 }); // 84948 % 3 = 0
    const b = selectAvd('ACE_Pixel_API_34', pool, { selfPid: 85316 }); // 85316 % 3 = 1
    expect(a.name).not.toBe(b.name);
  });

  it('is deterministic for a given pid and pool', () => {
    const once = selectAvd('ACE_Pixel_API_34', pool, { selfPid: 12345 });
    const twice = selectAvd('ACE_Pixel_API_34', pool, { selfPid: 12345 });
    expect(once.name).toBe(twice.name);
  });

  it('does not depend on the order the caller happened to probe in', () => {
    const shuffled = [pool[3], pool[0], pool[2], pool[1]];
    expect(selectAvd('ACE_Pixel_API_34', shuffled, { selfPid: 999 }).name)
      .toBe(selectAvd('ACE_Pixel_API_34', pool, { selfPid: 999 }).name);
  });

  it('stays in range for any pid', () => {
    for (const pid of [1, 2, 3, 99999, 2 ** 31 - 1]) {
      const s = selectAvd('ACE_Pixel_API_34', pool, { selfPid: pid });
      expect(['B', 'C', 'D']).toContain(s.name);
    }
  });
});


describe('a fallback must be PROVEN, not merely free (ace#1047)', () => {
  // ACE_Pixel_API_34_PS is the case this exists for: it has a complete image
  // set and boots, and #1047's closing note records that tier-2 auto-bootstrap
  // failed on it at register_test_user part B with commcare-not-installed.
  // Switching a run onto it would turn a precise AvdContendedError into a
  // confusing failure three steps later.
  it('never falls back onto a free-but-unproven AVD', () => {
    expect(() =>
      selectAvd('ACE_Pixel_API_34', [held('ACE_Pixel_API_34'), unproven('ACE_Pixel_API_34_PS')]),
    ).toThrow(AvdPoolExhaustedError);
  });

  it('says why it declined, rather than reporting it as unavailable', () => {
    expect(() =>
      selectAvd('ACE_Pixel_API_34', [held('ACE_Pixel_API_34'), unproven('ACE_Pixel_API_34_PS')]),
    ).toThrow(/never completed an ACE bootstrap/);
  });

  it('prefers a proven AVD over an unproven one', () => {
    const s = selectAvd('ACE_Pixel_API_34', [
      held('ACE_Pixel_API_34'),
      unproven('ACE_Pixel_API_34_PS'),
      free('ACE_Probe_API_34'),
    ]);
    expect(s.name).toBe('ACE_Probe_API_34');
  });

  it('does NOT require a marker on the AVD that was explicitly requested', () => {
    // Every existing machine has zero markers today. Requiring one for the
    // requested AVD would break every current setup.
    const s = selectAvd('ACE_Pixel_API_34', [unproven('ACE_Pixel_API_34')]);
    expect(s).toEqual({ name: 'ACE_Pixel_API_34', switched: false, note: null });
  });

  it('is a no-op on a machine that has never recorded a marker', () => {
    // Behaviour identical to pre-#1047: the contended case still throws, and
    // the caller surfaces its existing AvdContendedError.
    expect(() => selectAvd('A', [held('A'), unproven('B'), unproven('C')]))
      .toThrow(AvdPoolExhaustedError);
  });
});
