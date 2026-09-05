/**
 * Is the AVD pool still a POOL, or has it decayed to a singleton? (ace#1821)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * ACE has full per-session AVD allocation. `selectAvd`
 * (`mcp/mobile/avd-allocator.ts`) prefers the requested AVD, falls back to any
 * other free PROVEN one, and throws `AvdPoolExhaustedError` when there is
 * none. `lib/mobile-contention.ts` can see holders across macOS accounts.
 * `registerTestUser` self-writes the provisioning marker that makes an AVD
 * eligible as a fallback. Every piece works.
 *
 * All of it is inert when the pool has one member.
 *
 * That is not a hypothetical. Measured on the affected host 2026-09-05:
 *
 *     $ emulator -list-avds
 *     ACE_Pixel_API_34
 *     ACE_Pixel_API_34_b
 *
 *     $ ls ~/.android/avd/ACE_Pixel_API_34_b.avd/
 *     config.ini  userdata.img          # no .ace-provisioned.json
 *
 * Two AVDs by name; ONE that `selectAvd` may fall back to. `_b` has a disk
 * image, so `checkAvdProvisioned` calls it provisioned — and it still cannot
 * be chosen, because a fallback additionally requires a marker and `_b` has
 * never completed a bootstrap. Meanwhile
 * `mcp/mobile/recipes/static/connect-register-to-otp.yaml` records that its
 * steps were verified against `ACE_Pixel_API_34_PS`, a THIRD AVD that no
 * longer exists on this host at all.
 *
 * So the pool decayed by attrition and nothing noticed, because with one
 * eligible member the fallback branch in `selectAvd` can never execute. **A
 * working allocator over a pool of one is indistinguishable from no
 * allocator** — same selection, same failures, no signal. There is no error to
 * read, no test that goes red, and every per-session number stays correct.
 * This module is the missing signal: it counts what is actually ELIGIBLE and
 * says so out loud, before a Phase 6 run discovers it the expensive way.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PREDICATE IS BORROWED, NEVER RE-DERIVED
 *
 * `provisionedAndProven` here must mean exactly what `mcp/mobile/backends/avd.ts`
 * means by it at the point it builds the pool (`:743` and `:796`):
 *
 *     checkAvdProvisioned(home, name).provisioned !== false
 *     && markerProvesFor(readProvisionedMarker(home, name), env.ACE_SELECTOR_MAP)
 *
 * The caller performs those reads and hands the results in. A probe that
 * computed its own idea of "usable" would be a SECOND opinion about the pool,
 * and two detectors that disagree are worse than one dead one — the reasoning
 * `lib/mobile-contention.ts` already states for holders, applied to
 * eligibility. Holders come from `parseAvdHolders` in that same module for the
 * same reason; nothing here re-implements contention detection.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE THRESHOLD IS 2
 *
 * Not an SLO — the arity at which the allocator's fallback branch becomes
 * reachable at all. At 1 the machinery is dead code; at 2 a session whose AVD
 * is held has somewhere to go. Raising the bar higher would be a capacity
 * opinion this probe has no basis for; leaving it at 1 measures nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CLASSIFICATION: unit-testable logic, NOT device-truth.
 *
 * Per CLAUDE.md — "does this change alter what is SENT TO, or MATCHED AGAINST,
 * the device?" No. The inputs are a directory listing, a JSON marker file and
 * the host process table; nothing is sent to an emulator and no selector,
 * coordinate or recipe step is matched against a device response. Same class
 * as ace#1235 (set logic, fixed and proven device-free) and as
 * `lib/mobile-contention.ts` itself. Fixtures are the better authority here
 * than a device run: they say what the pool always looks like in a given
 * state, where one live host says only what it looked like once.
 *
 * Pure and synchronous. The collector that shells out lives in
 * `scripts/doctor-avd-pool.ts`.
 */

import type { AvdHolder } from './mobile-contention.js';

/**
 * The pool arity at which `selectAvd`'s fallback branch becomes reachable.
 * Below this the allocator is present but cannot ever act.
 */
export const MIN_ELIGIBLE_POOL = 2;

/** Facts about one AVD, gathered by the caller from the existing helpers. */
export interface AvdPoolFacts {
  name: string;
  /** `checkAvdProvisioned(...).provisioned` — `'unknown'` when unreadable. */
  provisioned: boolean | 'unknown';
  /** `markerProvesFor(readProvisionedMarker(...), env.ACE_SELECTOR_MAP)`. */
  proven: boolean;
  /** True when a marker file exists at all — separates the two ways to fail `proven`. */
  markerPresent: boolean;
  /** `parseAvdHolders(rows, name)` — live emulators attached to this AVD. */
  holders: readonly AvdHolder[];
}

export interface AvdPoolMember {
  name: string;
  provisioned: boolean | 'unknown';
  proven: boolean;
  held: boolean;
  holderPids: number[];
  /**
   * Eligible as a `selectAvd` FALLBACK: provisioned (not definitively absent)
   * AND proven. Being held does NOT disqualify — `resolveAvdPoolFreedom`
   * decides sharing at dispatch time, and a held AVD is still pool capacity.
   */
  eligible: boolean;
  detail: string;
}

export interface AvdPoolReport {
  verdict: 'pass' | 'warn' | 'skip';
  members: AvdPoolMember[];
  eligibleCount: number;
  reason: string;
  /** Multi-line `avdmanager` remediation, or null when the pool is healthy. */
  remediation: string | null;
}

/**
 * How to widen the pool.
 *
 * This DELEGATES rather than instructing, and that is the whole point. Two
 * earlier versions of this text hand-rolled an `avdmanager create` line, and
 * both were wrong in the same way: one hard-coded
 * `-k "system-images;android-34;google_apis;arm64-v8a"` while every AVD ACE
 * runs on is `google_apis_playstore`; the replacement told the operator to
 * grep the tag out of `config.ini` themselves. The second is better advice and
 * still the wrong shape — `/ace:mobile-bootstrap --pool N` (ace#1989) already
 * plans the pool, DERIVES `-k` from the reference AVD's own `image.sysdir.1`
 * (`systemImagePackageFromSysdir`, `lib/avd-pool-plan.ts`), names members off
 * one shared alphabet (`poolMemberNames`), and copies the tuned config from
 * the proven member.
 *
 * Restating any of that here would be a second set of instructions that can
 * drift from the first — the same failure this module's header rejects for
 * eligibility, and `lib/mobile-contention.ts`'s for holders. One source.
 *
 * On the system image specifically, for anyone who lands here mid-debug: the
 * choice is immaterial. `playbook/integrations/mobile-integration.md`
 * § Face-capture — "the lever is runtime GMS toggle, not AVD image selection
 * (both `google_apis` and `google_apis_playstore` images ship with functional
 * GMS on macOS Apple Silicon)"; `commands/mobile-bootstrap.md` — "Either image
 * works". The face-capture bypass is `pm disable-user com.google.android.gms`
 * at the `registerTestUser` recipe-pair boundary, and is image-independent.
 * So no tag is named anywhere in ACE's remediation text any more.
 */
export function poolRemediation(base: string): string {
  return [
    `  /ace:mobile-bootstrap --pool ${MIN_ELIGIBLE_POOL}`,
    ``,
    `  It plans the pool, derives -k from ${base}'s own image.sysdir.1 (so the`,
    `  clone lands on the same system image), copies the tuned config from the`,
    `  proven member, and boots each new member to completion.`,
    ``,
    `  That last step is not optional: a pool member counts only once`,
    `  registerTestUser has written its provisioning marker. An AVD that was`,
    `  created but never booted still leaves the pool at its current size —`,
    `  which is exactly the state this check reports.`,
  ].join('\n');
}

function describe(m: Omit<AvdPoolMember, 'detail'>, markerPresent: boolean): string {
  const held = m.held ? ` — held by live pid ${m.holderPids.join(', ')}` : '';
  if (m.provisioned === 'unknown') {
    // Counted per the runtime's own rule (`provisioned !== false`), NOT a
    // stricter one of this probe's invention — see the header. In practice the
    // combination barely arises: if the directory is unreadable then
    // `readProvisionedMarker` fails too, so `proven` is false and the entry
    // drops out anyway. Reported honestly rather than silently rounded.
    return (
      `${m.name}: directory unreadable — this check makes no claim about it; counted as ` +
      `${m.eligible ? 'eligible' : 'ineligible'} by the same rule the allocator applies${held}`
    );
  }
  if (m.provisioned === false) {
    return `${m.name}: de-provisioned (no *.img) — re-provision via /ace:mobile-bootstrap${held}`;
  }
  if (!m.proven) {
    return markerPresent
      ? `${m.name}: has disk images and a provisioning marker, but the marker was recorded ` +
          `under a DIFFERENT selector map — not eligible as a fallback (the #591/#593 drift ` +
          `trap). Re-bootstrap it under the current map${held}`
      : `${m.name}: has disk images but NO provisioning marker — it has never completed an ACE ` +
          `bootstrap, so selectAvd will never fall back to it. Boot it once via ` +
          `/ace:mobile-bootstrap to prove it${held}`;
  }
  return `${m.name}: provisioned and proven — eligible${held}`;
}

/**
 * Classify the pool.
 *
 * `skip` (never `warn`) when the AVD list could not be read: warning on an
 * unanswerable question is how a check becomes noise and gets ignored — the
 * `lib/env-freshness.ts` and `classifyAvdContention` precedent.
 */
export function classifyAvdPool(
  facts: readonly AvdPoolFacts[],
  opts: { listed: boolean; requested: string },
): AvdPoolReport {
  if (!opts.listed) {
    return {
      verdict: 'skip',
      members: [],
      eligibleCount: 0,
      reason:
        'could not read `emulator -list-avds`, so the AVD pool was not assessed ' +
        '(not a claim that it is healthy)',
      remediation: null,
    };
  }

  const members: AvdPoolMember[] = facts.map((f) => {
    const holderPids = f.holders.map((h) => h.pid);
    const base = {
      name: f.name,
      provisioned: f.provisioned,
      proven: f.proven,
      held: holderPids.length > 0,
      holderPids,
      eligible: f.provisioned !== false && f.proven,
    };
    return { ...base, detail: describe(base, f.markerPresent) };
  });

  const eligible = members.filter((m) => m.eligible);
  const eligibleCount = eligible.length;
  const names = members.map((m) => m.name);

  if (eligibleCount >= MIN_ELIGIBLE_POOL) {
    return {
      verdict: 'pass',
      members,
      eligibleCount,
      reason:
        `${eligibleCount} of ${members.length} AVD(s) are provisioned and proven ` +
        `(${eligible.map((m) => m.name).join(', ')}) — selectAvd has somewhere to fall back to`,
      remediation: null,
    };
  }

  const shortfall =
    eligibleCount === 0
      ? 'NO AVD on this host is both provisioned and proven, so every Phase 6 dispatch fails at ' +
        'AvdPoolExhaustedError'
      : `only ${eligibleCount} AVD (${eligible[0].name}) is both provisioned and proven, so ` +
        "selectAvd's fallback branch can never execute — per-session AVD allocation is present " +
        'but inert, and concurrent Phase 6 sessions cold-boot the same device with -wipe-data ' +
        "and destroy each other's state";

  return {
    verdict: 'warn',
    members,
    eligibleCount,
    reason:
      `avd_pool: ${shortfall}. ${members.length} AVD(s) exist by name ` +
      `(${names.join(', ') || 'none'}); ${eligibleCount} eligible, ${MIN_ELIGIBLE_POOL} needed. ` +
      'A working allocator over a pool of one is indistinguishable from no allocator — ' +
      'nothing errors, which is why this decayed unnoticed. See ace#1821.',
    remediation: poolRemediation(opts.requested),
  };
}
