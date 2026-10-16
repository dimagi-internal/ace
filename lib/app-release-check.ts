/**
 * `app-release-eval`, as code.
 *
 * Every dimension of that rubric reads a fact an artifact or API already
 * states — so it is graded by comparison, not by an LLM judge (see
 * `lib/deterministic-verdict.ts` for why, and `skills/app-release-eval/SKILL.md`
 * for the rubric this implements, which stays the spec):
 *
 * | dimension                 | weight | evidence |
 * |---------------------------|--------|----------|
 * | both_apps_released        | 0.35   | `3-commcare/app-release_summary.md` `apps.<kind>_app.is_released` + `build_id` (ace#1439) |
 * | ccz_marker_integrity      | 0.25   | `commcare_download_ccz` `?latest=release` → `connect_markers` + `projected_connect_state` |
 * | build_id_traceability     | 0.20   | the same summary — the SOLE source (ace#1010, ace#1636) |
 * | deliver_units_enumerable  | 0.20   | Deliver projection's `deliver_units` vs the PDD-payable slugs; Connect `connect_list_deliver_units` upgrades it |
 *
 * Owned-artifact precedence (ace#1567): only `app-release_summary.md` missing,
 * or carrying no `apps.*` block, makes the verdict `incomplete`. Absent
 * corroboration (no CCZ read, Phase 4 not run) is INFO-SKIPPED / partial, never
 * a deduction and never `incomplete`. `run_state.yaml` is never read (ace#1010).
 */
import type { AutoSurfaced, CheckRecord, Verdict } from './verdict-schema.js';
import { parseAppReleaseSummary, releaseRecordFor } from './app-release-record.js';
import { composeVerdict, incompleteVerdict, type ScoredDimension } from './deterministic-verdict.js';

export const APP_RELEASE_WEIGHTS = {
  both_apps_released: 0.35,
  ccz_marker_integrity: 0.25,
  build_id_traceability: 0.2,
  deliver_units_enumerable: 0.2,
} as const;

/** The parts of a `commcare_download_ccz` result this check reads. */
export interface CczRead {
  connect_markers?: { deliver?: number; module?: number; task?: number; assessment?: number };
  projected_connect_state?: {
    deliver_units?: Array<{ slug: string; name?: string; first_seen_in?: string }>;
    learn_modules?: Array<{ slug: string }>;
    assessments?: Array<{ slug: string }>;
    collision_count?: number;
    oversized_slugs?: Record<string, Array<{ slug: string }>>;
  };
}

export interface AppReleaseCheckInput {
  target: string;
  /** Text of `3-commcare/app-release_summary.md`, or null when absent. */
  releaseSummaryText: string | null;
  /** `?latest=release` CCZ reads, per app. `null` = the read was attempted and FAILED. Absent = not attempted. */
  ccz?: { learn?: CczRead | null; deliver?: CczRead | null };
  /**
   * Deliver-unit slugs the PDD declares PAYABLE (from app-connect-coverage's
   * role decisions). Absent → the payable comparison is INFO-SKIPPED and only
   * "at least one unit" is graded (ace#1331: never deduct units < forms).
   */
  payableDeliverSlugs?: string[];
  /** `connect_list_deliver_units` rows when Phase 4 has already run. `null` = probe failed. */
  connectDeliverUnits?: Array<{ slug?: string; name?: string }> | null;
  ranAt?: string;
}

const KINDS = ['learn', 'deliver'] as const;

export function checkAppRelease(input: AppReleaseCheckInput): Verdict {
  const capturePath = '3-commcare/app-release_summary.md';
  const records = parseAppReleaseSummary(input.releaseSummaryText);
  if (!records || Object.keys(records).length === 0) {
    return incompleteVerdict({
      skill: 'app-release-eval',
      target: input.target,
      capturePath,
      ranAt: input.ranAt,
      dimensionWeights: { ...APP_RELEASE_WEIGHTS },
      reason:
        'app-release output missing — skill did not run or did not complete writing its artifact ' +
        '(3-commcare/app-release_summary.md absent or carrying no apps.* frontmatter)',
    });
  }

  const auto: AutoSurfaced[] = [];
  const checks: CheckRecord[] = [];
  let live = true;

  // ── both_apps_released ────────────────────────────────────────────────
  const released = KINDS.filter((k) => {
    const r = releaseRecordFor(records, k);
    return r?.is_released === true && r.build_id !== undefined && r.build_id !== null && r.build_id !== '';
  });
  const unreleased = KINDS.filter((k) => !released.includes(k));
  for (const k of unreleased) auto.push({ severity: 'BLOCKER', message: `${k} app is not recorded as released (apps.${k}_app.is_released: true + build_id) in app-release_summary.md — Connect reads only released builds` });
  const relScore = released.length === 2 ? 10 : released.length === 1 ? 6 : 2;
  const both: ScoredDimension = {
    score: relScore,
    weight: APP_RELEASE_WEIGHTS.both_apps_released,
    source: 'deterministic',
    note: released.length === 2 ? 'both apps is_released: true with a build_id' : `unreleased: ${unreleased.join(', ')}`,
  };
  checks.push({ name: 'release-summary-apps', status: 'checked' });

  // ── build_id_traceability ─────────────────────────────────────────────
  let trace = 10;
  const traceNotes: string[] = [];
  for (const k of KINDS) {
    const r = releaseRecordFor(records, k);
    if (!r?.build_id) {
      trace -= 4;
      traceNotes.push(`${k}: no build_id`);
    }
    if (r && (r.version === undefined || r.version === null || r.version === '')) {
      trace -= 1;
      traceNotes.push(`${k}: no version`);
    }
    if (r && Number(r.version) > 1) auto.push({ severity: 'INFO', message: `${k} app released at version ${String(r.version)} (re-release)` });
  }

  // ── ccz_marker_integrity + deliver_units_enumerable ───────────────────
  let marker = 10;
  const markerNotes: string[] = [];
  let enumerable = 10;
  const enumNotes: string[] = [];

  const learnCcz = input.ccz?.learn;
  const deliverCcz = input.ccz?.deliver;
  for (const [k, ccz] of [['learn', learnCcz], ['deliver', deliverCcz]] as const) {
    if (ccz === undefined) {
      checks.push({ name: `ccz-projection-${k}`, status: 'unable', reason: `no ?latest=release CCZ read was supplied for the ${k} app` });
      auto.push({ severity: 'INFO-SKIPPED', message: `${k} CCZ marker check skipped — no ?latest=release read supplied` });
      live = false;
      continue;
    }
    if (ccz === null) {
      checks.push({ name: `ccz-projection-${k}`, status: 'unable', reason: `commcare_download_ccz failed for the ${k} app at grading time` });
      auto.push({ severity: 'PLATFORM', message: `${k} released CCZ could not be downloaded at grading time; marker integrity unverified` });
      live = false;
      continue;
    }
    checks.push({ name: `ccz-projection-${k}`, status: 'checked' });
    const m = ccz.connect_markers ?? {};
    const p = ccz.projected_connect_state ?? {};
    if (k === 'learn') {
      const modules = p.learn_modules?.length ?? m.module ?? 0;
      const assessments = p.assessments?.length ?? m.assessment ?? 0;
      if (!modules) { marker -= 4; markerNotes.push('learn: no learn_module markers'); auto.push({ severity: 'BLOCKER', message: 'released Learn CCZ carries no connect learn_module marker — Connect will enumerate no LearnModules' }); }
      if (!assessments) { marker -= 4; markerNotes.push('learn: no assessment marker'); auto.push({ severity: 'BLOCKER', message: 'released Learn CCZ carries no connect assessment marker — the Learn gate cannot be scored' }); }
    } else {
      const units = p.deliver_units?.length ?? m.deliver ?? 0;
      if (!units) { marker -= 4; markerNotes.push('deliver: no deliver markers'); }
    }
    if ((p.collision_count ?? 0) > 0) {
      marker -= 2;
      markerNotes.push(`${k}: ${p.collision_count} slug collision group(s)`);
      auto.push({ severity: 'WARN', message: `${k} CCZ projection has ${p.collision_count} slug collision group(s) — Connect silently drops the duplicate forms' markers` });
    }
    const oversized = Object.values(p.oversized_slugs ?? {}).flat();
    if (oversized.length) {
      marker = Math.min(marker, 3);
      markerNotes.push(`${k}: ${oversized.length} slug(s) over Connect's 50-char limit`);
      auto.push({ severity: 'BLOCKER', message: `${k} CCZ has slug(s) over 50 chars (${oversized.map((o) => o.slug).join(', ')}) — Connect's sync 500s on them` });
    }
  }

  if (deliverCcz) {
    const slugs = (deliverCcz.projected_connect_state?.deliver_units ?? []).map((u) => u.slug);
    const count = slugs.length || deliverCcz.connect_markers?.deliver || 0;
    if (!count) {
      enumerable -= 4;
      enumNotes.push('zero deliver units exposed');
      auto.push({ severity: 'BLOCKER', message: 'released Deliver CCZ exposes ZERO deliver units — Sync Deliver Units will create none and no payment unit can be wired' });
    }
    if (input.payableDeliverSlugs && input.payableDeliverSlugs.length) {
      const missing = input.payableDeliverSlugs.filter((s) => !slugs.includes(s));
      const extra = slugs.filter((s) => !input.payableDeliverSlugs!.includes(s));
      if (missing.length && count) {
        enumerable -= 4 * missing.length;
        enumNotes.push(`payable form(s) with no unit: ${missing.join(', ')}`);
        auto.push({ severity: 'WARN', message: `PDD-payable deliver unit(s) absent from the released CCZ: ${missing.join(', ')}` });
      }
      for (const e of extra) auto.push({ severity: 'WARN', message: `deliver unit "${e}" sits on a form the PDD does not declare payable — Phase 4 could wire payment to an unpaid stage` });
      checks.push({ name: 'payable-deliver-units', status: 'checked' });
    } else {
      checks.push({ name: 'payable-deliver-units', status: 'unable', reason: 'no PDD-payable slug list supplied — graded only "at least one unit exists" (never units < forms, ace#1331)' });
      auto.push({ severity: 'INFO-SKIPPED', message: 'payable-vs-exposed deliver-unit comparison skipped: no payable slug list supplied' });
    }
    if (input.connectDeliverUnits === null) {
      auto.push({ severity: 'PLATFORM', message: 'connect_list_deliver_units failed at grading time; Connect-side enumeration unconfirmed' });
      live = false;
    } else if (input.connectDeliverUnits) {
      const connectSlugs = input.connectDeliverUnits.map((u) => u.slug).filter(Boolean) as string[];
      for (const s of slugs) if (connectSlugs.length && !connectSlugs.includes(s)) auto.push({ severity: 'DRIFT', message: `deliver unit "${s}" is in the released CCZ but not in Connect's deliver-unit list` });
      enumNotes.push(`Connect lists ${input.connectDeliverUnits.length} deliver unit(s)`);
      checks.push({ name: 'connect-deliver-units', status: 'checked' });
    }
    if (!enumNotes.length) enumNotes.push(`${count} deliver unit(s) exposed`);
  } else {
    enumNotes.push('Deliver CCZ not read — enumeration unverified');
  }

  const dims: Record<string, ScoredDimension> = {
    both_apps_released: both,
    ccz_marker_integrity: { score: Math.max(0, marker), weight: APP_RELEASE_WEIGHTS.ccz_marker_integrity, source: 'deterministic', note: markerNotes.join('; ') || 'canonical Connect markers present in every read CCZ' },
    build_id_traceability: { score: Math.max(0, trace), weight: APP_RELEASE_WEIGHTS.build_id_traceability, source: 'deterministic', note: traceNotes.join('; ') || 'build_id + version recorded for both apps' },
    deliver_units_enumerable: { score: Math.max(0, enumerable), weight: APP_RELEASE_WEIGHTS.deliver_units_enumerable, source: 'deterministic', note: enumNotes.join('; ') },
  };
  return composeVerdict({
    skill: 'app-release-eval',
    target: input.target,
    capturePath,
    ranAt: input.ranAt,
    dimensions: dims,
    autoSurfaced: auto,
    checks,
    liveStateVerified: live,
  });
}
