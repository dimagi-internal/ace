/**
 * The LLO-facing deny list, as a reusable QA check (dimagi-internal/ace#3190).
 *
 * An opp may declare parties that must never be named to an LLO (a funder the
 * PDD names internally, for example) in `inputs/confidentiality.yaml`:
 *
 *   llo_facing_deny_list: [GiveDirectly, Give Directly, GD]
 *
 * The parser (`normalizeDenyList`) and the matcher (`findDenyListHits`) already
 * live in `lib/synthetic-responses.ts`, where the Phase 8 skills use them. This
 * module only adds the two things every OTHER LLO-facing QA needs on top: read
 * the file's text, and turn the hits into a `QACheckResult`. It reimplements
 * neither, so a matching fix lands once for every caller.
 *
 * Matching is whole folded words, case-insensitive: `GD` catches "GD's pilot"
 * but not "budget" or "GDP"; `Give Directly` also catches `GiveDirectly`.
 */
import { parse as parseYaml } from 'yaml';
import type { QACheckResult } from './qa-types';
import { findDenyListHits, normalizeDenyList } from './synthetic-responses';

/**
 * The deny list from the text of an opp's `inputs/confidentiality.yaml`.
 * Absent, empty, or no `llo_facing_deny_list` key → `[]`. A malformed list
 * throws: a confidentiality file nobody can read is not the same as no file.
 */
export function parseConfidentialityYaml(text: string | null | undefined): string[] {
  if (text == null || text.trim() === '') return [];
  // A Google Doc export can lead with a BOM; strip it before parsing.
  const doc = parseYaml(text.replace(/^﻿/, '')) as unknown;
  if (doc == null) return [];
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('confidentiality.yaml must be a mapping');
  }
  return normalizeDenyList((doc as Record<string, unknown>).llo_facing_deny_list);
}

/** Up to `max` lines of `text` that carry a hit for `term`, trimmed, for the failure detail. */
function linesNaming(text: string, term: string, max = 3): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => findDenyListHits(line, [term]).length > 0)
    .map((line) => line.trim().slice(0, 160))
    .slice(0, max);
}

/**
 * Pass iff `text` names no deny-listed party. `denyList === null` means no
 * confidentiality.yaml reached the check: a no-op pass that says so.
 */
export function checkTextAgainstDenyList(
  text: string,
  denyList: string[] | null,
  artifactLabel: string,
): QACheckResult {
  if (denyList === null) {
    return { pass: true, detail: 'not applicable: no inputs/confidentiality.yaml for this opp' };
  }
  if (denyList.length === 0) {
    return { pass: true, detail: 'confidentiality.yaml declares no llo_facing_deny_list entries' };
  }
  const hits = findDenyListHits(text, denyList);
  if (hits.length === 0) {
    return { pass: true, detail: `${artifactLabel} names none of ${denyList.length} deny-listed parties` };
  }
  const where = hits.map((h) => `"${h}" in: ${linesNaming(text, h).map((l) => `«${l}»`).join(' | ')}`);
  return {
    pass: false,
    detail: `${artifactLabel} is LLO-facing and names deny-listed parties: ${where.join('; ')}`,
    auto_fix_hint:
      `Rewrite every sentence that names ${hits.map((h) => `"${h}"`).join(', ')} so the party is ` +
      `not identified (describe the role, e.g. "the funder", or drop the clause), re-render, and ` +
      `re-run this QA. The deny list is the opp's inputs/confidentiality.yaml; never edit it to ` +
      `make the check pass.`,
  };
}
