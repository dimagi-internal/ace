/**
 * ace#1821 — the AVD pool decayed to a singleton and nothing noticed.
 *
 * The control that matters is stated at the top of the file: the SAME assertion
 * must go red on a one-eligible pool and green on a two-eligible one. A test
 * that passes both ways would be inert, so `pass` and `warn` are pinned in both
 * directions rather than only asserting the warn.
 *
 * Classification: unit-test truth, not device-truth. Every input here is a
 * directory listing, a marker file or a `ps` row — nothing is sent to a device
 * and nothing is matched against one.
 */
import { describe, it, expect } from 'vitest';

import {
  classifyAvdPool,
  poolRemediation,
  MIN_ELIGIBLE_POOL,
  type AvdPoolFacts,
} from '../../lib/avd-pool-report.js';
import type { AvdHolder } from '../../lib/mobile-contention.js';

function holder(pid: number): AvdHolder {
  return {
    pid,
    ppid: 1,
    user: 'acedimagi',
    readOnly: true,
    consolePort: 5554,
    avdName: 'ACE_Pixel_API_34',
    startedMs: 0,
  };
}

/** Provisioned + marker recorded + marker valid for the map in force. */
function eligible(name: string, holders: AvdHolder[] = []): AvdPoolFacts {
  return { name, provisioned: true, proven: true, markerPresent: true, holders };
}

/** Exists, has disk images, never completed a bootstrap — `_b`'s real shape. */
function unproven(name: string): AvdPoolFacts {
  return { name, provisioned: true, proven: false, markerPresent: false, holders: [] };
}

/** Marker exists but was recorded under a different selector map (#591/#593). */
function driftedMarker(name: string): AvdPoolFacts {
  return { name, provisioned: true, proven: false, markerPresent: true, holders: [] };
}

function deprovisioned(name: string): AvdPoolFacts {
  return { name, provisioned: false, proven: false, markerPresent: false, holders: [] };
}

const OPTS = { listed: true, requested: 'ACE_Pixel_API_34' };

describe('classifyAvdPool — the both-directions control', () => {
  // ─── THE CONTROL ──────────────────────────────────────────────────────────
  // Same assertion shape, opposite verdicts. If the threshold were inverted or
  // dropped, exactly one of these two would fail — which is what makes the
  // pair a control rather than a pair of restatements.

  it('WARNs on a one-eligible pool (the measured pre-fix state)', () => {
    const r = classifyAvdPool([eligible('ACE_Pixel_API_34'), unproven('ACE_Pixel_API_34_b')], OPTS);
    expect(r.verdict).toBe('warn');
    expect(r.eligibleCount).toBe(1);
  });

  it('PASSes on a two-eligible pool', () => {
    const r = classifyAvdPool([eligible('ACE_Pixel_API_34'), eligible('ACE_Pixel_API_34_b')], OPTS);
    expect(r.verdict).toBe('pass');
    expect(r.eligibleCount).toBe(2);
  });
  // ──────────────────────────────────────────────────────────────────────────

  it('the threshold is the arity at which the fallback branch becomes reachable', () => {
    expect(MIN_ELIGIBLE_POOL).toBe(2);
  });
});

describe('classifyAvdPool — the exact state measured on the affected host', () => {
  /**
   * 2026-09-05, verbatim:
   *   emulator -list-avds  -> ACE_Pixel_API_34, ACE_Pixel_API_34_b
   *   ACE_Pixel_API_34.avd  -> 8 *.img + .ace-provisioned.json
   *   ACE_Pixel_API_34_b.avd -> config.ini + userdata.img, NO marker
   *
   * This is the case that makes the probe worth having: by NAME the pool
   * looks like two, and `checkAvdProvisioned` agrees `_b` is provisioned
   * (it has a `userdata.img`), so every cheaper check reads healthy. Only
   * the marker separates "exists" from "selectAvd may fall back to it".
   */
  const measured = classifyAvdPool(
    [eligible('ACE_Pixel_API_34'), unproven('ACE_Pixel_API_34_b')],
    OPTS,
  );

  it('counts two members but only one eligible', () => {
    expect(measured.members).toHaveLength(2);
    expect(measured.eligibleCount).toBe(1);
  });

  it('does not let a disk image alone pass for eligibility', () => {
    const b = measured.members.find((m) => m.name === 'ACE_Pixel_API_34_b')!;
    expect(b.provisioned).toBe(true);
    expect(b.eligible).toBe(false);
  });

  it('names the missing marker and the remedy, not just the count', () => {
    const b = measured.members.find((m) => m.name === 'ACE_Pixel_API_34_b')!;
    expect(b.detail).toMatch(/NO provisioning marker/);
    expect(b.detail).toMatch(/mobile-bootstrap/);
  });

  it('says WHY nothing caught this — the silent-degradation mechanism', () => {
    expect(measured.reason).toMatch(/indistinguishable from no allocator/);
    expect(measured.reason).toMatch(/ace#1821/);
  });

  it('distinguishes a drifted marker from an absent one', () => {
    const r = classifyAvdPool([eligible('a'), driftedMarker('b')], OPTS);
    const b = r.members.find((m) => m.name === 'b')!;
    expect(b.detail).toMatch(/DIFFERENT selector map/);
    expect(b.detail).not.toMatch(/NO provisioning marker/);
  });
});

describe('classifyAvdPool — edges', () => {
  it('warns hardest when nothing at all is eligible', () => {
    const r = classifyAvdPool([deprovisioned('a'), unproven('b')], OPTS);
    expect(r.verdict).toBe('warn');
    expect(r.eligibleCount).toBe(0);
    expect(r.reason).toMatch(/NO AVD on this host/);
    expect(r.reason).toMatch(/AvdPoolExhaustedError/);
  });

  it('an empty host warns rather than passing vacuously', () => {
    const r = classifyAvdPool([], OPTS);
    expect(r.verdict).toBe('warn');
    expect(r.eligibleCount).toBe(0);
  });

  it('SKIPs — never warns — when the AVD list could not be read', () => {
    const r = classifyAvdPool([], { listed: false, requested: 'X' });
    expect(r.verdict).toBe('skip');
    expect(r.remediation).toBeNull();
    // Warning on an unanswerable question is how a check becomes noise.
    expect(r.reason).toMatch(/not a claim that it is healthy/);
  });

  it("'unknown' provisioning follows the allocator's rule, not a stricter one", () => {
    // `mcp/mobile/backends/avd.ts:743` treats `provisioned !== false` as usable,
    // so an unreadable directory with a valid marker counts there — and must
    // count here. A probe that applied a stricter rule would be a SECOND
    // opinion about the pool, which is the failure mode this module's header
    // (and lib/mobile-contention.ts's) exists to avoid.
    const r = classifyAvdPool(
      [eligible('a'), { name: 'b', provisioned: 'unknown', proven: true, markerPresent: true, holders: [] }],
      OPTS,
    );
    expect(r.eligibleCount).toBe(2);
    expect(r.members.find((m) => m.name === 'b')!.detail).toMatch(/makes no claim about it/);
  });

  it("'unknown' without a marker still drops out — the realistic shape", () => {
    // If the directory cannot be read, readProvisionedMarker fails too.
    const r = classifyAvdPool(
      [eligible('a'), { name: 'b', provisioned: 'unknown', proven: false, markerPresent: false, holders: [] }],
      OPTS,
    );
    expect(r.verdict).toBe('warn');
    expect(r.eligibleCount).toBe(1);
  });

  it('being HELD does not reduce eligibility — a held AVD is still pool capacity', () => {
    // resolveAvdPoolFreedom decides sharing at dispatch time; this probe
    // measures capacity. Counting a held AVD as missing would report a
    // healthy 2-AVD host as degraded whenever a peer session is live.
    const r = classifyAvdPool(
      [eligible('a', [holder(29670)]), eligible('b', [holder(31000)])],
      OPTS,
    );
    expect(r.verdict).toBe('pass');
    expect(r.eligibleCount).toBe(2);
    expect(r.members[0].held).toBe(true);
    expect(r.members[0].detail).toMatch(/held by live pid 29670/);
  });

  it('reports every AVD by name in the warn line, so the pool is diffable', () => {
    const r = classifyAvdPool([eligible('a'), unproven('zz')], OPTS);
    expect(r.reason).toContain('a, zz');
  });
});

describe('remediation — delegates to one source, and names no system image', () => {
  it('points at /ace:mobile-bootstrap --pool N, not a hand-rolled avdmanager line', () => {
    // ace#1989 shipped the planner: it derives -k from the reference AVD's own
    // image.sysdir.1, names members off one shared alphabet, and copies the
    // tuned config. Restating any of that here would be a second set of
    // instructions free to drift from the first.
    const text = poolRemediation('ACE_Pixel_API_34');
    expect(text).toContain(`/ace:mobile-bootstrap --pool ${MIN_ELIGIBLE_POOL}`);
    expect(text).not.toMatch(/avdmanager create avd/);
  });

  it('names NO system-image tag anywhere', () => {
    // The original text hard-coded `google_apis` as though it were required,
    // while every AVD ACE runs on is `google_apis_playstore`. The fix is not
    // the other tag: mobile-integration.md § Face-capture, mobile-bootstrap.md
    // and CHANGELOG's auto-shutter finding all say the choice is immaterial —
    // the lever is a runtime `pm disable-user com.google.android.gms`.
    const text = poolRemediation('ACE_Pixel_API_34');
    expect(text).not.toMatch(/google_apis/);
    expect(text).not.toMatch(/system-images/);
  });

  it('says creating the AVD is not sufficient — it must be booted to be proven', () => {
    // The whole defect class: `_b` was created and left unbooted, so the pool
    // still had one eligible member while looking like two.
    const text = poolRemediation('ACE_Pixel_API_34');
    expect(text).toMatch(/registerTestUser has written its provisioning marker/);
    expect(text).toMatch(/never booted still leaves the pool at its current size/);
  });

  it('is what AvdPoolExhaustedError prints — one source, not two copies', async () => {
    const { AvdPoolExhaustedError } = await import('../../mcp/mobile/avd-allocator.js');
    const err = new AvdPoolExhaustedError('ACE_Pixel_API_34', [
      { name: 'ACE_Pixel_API_34', free: false, reason: 'held' },
    ]);
    expect(err.message).toContain(poolRemediation('ACE_Pixel_API_34'));
    expect(err.message).not.toMatch(/system-images;android-34;google_apis;/);
  });
});
