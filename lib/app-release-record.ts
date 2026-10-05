/**
 * lib/app-release-record.ts
 *
 * The ONE reader of a run's released-build state. `skills/app-release` owns it:
 * `3-commcare/app-release_summary.md` frontmatter
 * `apps.<kind>_app.{hq_app_id, build_id, version, is_released, released_at}`
 * (skills/app-release/SKILL.md § Products, ace#1439). No skill is contracted to
 * write a release key into run_state `products.apps` (lib/phase-products-schema.ts
 * `AppEntry`), so a reader keyed on one there sees nothing on runs whose agent
 * wrote another shape — ace#2698 (release-readiness raised false "unreleased"
 * blockers) and ace#2702 (a clone kept the source's build ids in prose).
 *
 * Consumers: lib/release-readiness.ts `assessApps`, lib/clone-asset-refs.ts
 * `runAssetsFromRunState`. Run_state is a FALLBACK only, via `runStateRelease`,
 * which accepts the shapes producers have actually written.
 */

import { parse as parseYaml } from 'yaml';

/** app-release's summary — the SOLE owner of released build state. */
export const APP_RELEASE_SUMMARY = /(^|\/)app-release_summary\.md$/;

export type ReleaseRecord = {
  hq_app_id?: unknown;
  build_id?: unknown;
  version?: unknown;
  is_released?: unknown;
  released_at?: unknown;
};

/**
 * `apps` from app-release_summary.md frontmatter (keyed `learn_app` /
 * `deliver_app`), or null when the text or its frontmatter is unreadable.
 */
export function parseAppReleaseSummary(text: string | null | undefined): Record<string, ReleaseRecord> | null {
  const fm = text ? /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^﻿/, '')) : null;
  if (!fm) return null;
  try {
    const apps = (parseYaml(fm[1]) as { apps?: Record<string, ReleaseRecord> } | null)?.apps;
    return apps && typeof apps === 'object' ? apps : null;
  } catch {
    return null;
  }
}

/** The record for one app kind (`learn` / `deliver`), accepting `<kind>_app` or `<kind>`. */
export function releaseRecordFor(records: Record<string, ReleaseRecord> | null, kind: string): ReleaseRecord | undefined {
  return records ? (records[`${kind}_app`] ?? records[kind]) : undefined;
}

function str(v: unknown): string | undefined {
  return v === undefined || v === null || v === '' ? undefined : String(v);
}

export interface ReleasedBuild {
  build_id: string;
  version?: string;
}

/**
 * The released build for one app, from its contracted owner first.
 *
 * `summary` is the parsed app-release_summary.md; `app` is run_state
 * `products.apps.<kind>`. The summary record counts only when it is released
 * (`is_released: true` + a `build_id`) AND describes THIS run's app — a clone
 * copies the source's summary verbatim, and until it is re-recorded its
 * `hq_app_id` names the source app, which is not this run's release.
 *
 * Fallback, when the summary has no usable record: run_state
 * `released_build_id` (+ `released_version`), or `hq_build_id` with a
 * `released_at` (+ `build_version`) — the shape spark-facilitator/20261004-1706
 * wrote. A built-but-unreleased `hq_build_id` is not a release.
 */
export function releasedBuild(
  summary: Record<string, ReleaseRecord> | null,
  kind: string,
  app: Record<string, unknown> | undefined,
): ReleasedBuild | undefined {
  const r = releaseRecordFor(summary, kind);
  const appId = str(app?.hq_app_id);
  const recId = str(r?.hq_app_id);
  if (r && str(r.build_id) && r.is_released === true && !(appId && recId && appId !== recId)) {
    return { build_id: str(r.build_id)!, version: str(r.version) };
  }
  return runStateRelease(app);
}

/** The run_state fallback shapes alone. */
export function runStateRelease(app: Record<string, unknown> | undefined): ReleasedBuild | undefined {
  if (!app) return undefined;
  const legacy = str(app.released_build_id);
  if (legacy) return { build_id: legacy, version: str(app.released_version) };
  const built = str(app.hq_build_id);
  if (built && str(app.released_at)) return { build_id: built, version: str(app.build_version ?? app.released_version) };
  return undefined;
}
