/**
 * Static QA checks for `pdd-to-app-journeys-qa`.
 *
 * Validates structural correctness of the `pdd-to-app-journeys.md`
 * artifact: persona block populated, archetype declared, ≥2 journey
 * sections, and each journey has the required Goal / Happy-path /
 * Edge-cases / Pass-criteria fields.
 *
 * Quality concerns (whether the persona is *specific*, whether the
 * narrative uses *user-outcome language* vs form mechanics, whether
 * edge cases describe *UX outcomes* vs error codes) live in the
 * companion `pdd-to-app-journeys-eval`.
 */

import type { QACheck, QACheckResult } from '../../lib/qa-types';

const VALID_ARCHETYPES = ['atomic-visit', 'focus-group', 'multi-stage'] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check 1: `## Persona` heading exists and the section body is non-empty
 * (more than 50 chars of substantive content, ignoring whitespace and
 * placeholder `{{...}}` tokens).
 */
export function checkPersonaBlockPresent(doc: string): QACheckResult {
  const body = extractSection(doc, 'Persona');
  if (body === null) {
    return {
      pass: false,
      detail: 'missing § Persona section',
      auto_fix_hint:
        'add a `## Persona` section pulling the Target FLW persona verbatim from the PDD',
    };
  }
  const stripped = body.replace(/\{\{[^}]*\}\}/g, '').trim();
  if (stripped.length < 50) {
    return {
      pass: false,
      detail: `Persona section is empty or placeholder-only (${stripped.length} chars after stripping)`,
      auto_fix_hint:
        'fill the Persona section with the Target FLW description verbatim from the PDD; do not leave template placeholders',
    };
  }
  return { pass: true, detail: `${stripped.length} chars` };
}

/**
 * Check 2: Archetype declared in the doc header (e.g. `Archetype: atomic-visit`)
 * and value is in the valid enum.
 */
export function checkArchetypeDeclared(doc: string): QACheckResult {
  const m = doc.match(/Archetype:\s*\*{0,2}\s*(atomic-visit|focus-group|multi-stage)\b/im);
  if (!m) {
    return {
      pass: false,
      detail: 'no archetype declared in journeys doc header',
      auto_fix_hint:
        'add `Archetype: <atomic-visit|focus-group|multi-stage>` near the top, mirroring the PDD',
    };
  }
  return { pass: true, detail: m[1] };
}

/**
 * Check 3: At least 2 (and at most 8) `## Journey N` sections present.
 *
 * Lower bound 2: archetype branches require ≥2 journeys per the skill's
 * coverage rules. Upper bound 8: more than that is a sign the producer
 * didn't filter — `app-ux-eval` graders won't read 10+ journeys carefully.
 */
export function checkJourneyCountInRange(doc: string): QACheckResult {
  const journeys = listJourneyHeadings(doc);
  if (journeys.length < 2) {
    return {
      pass: false,
      detail: `${journeys.length} journey(s) found, expected ≥2`,
      auto_fix_hint:
        'add additional journey sections per the archetype branch in skills/pdd-to-app-journeys/SKILL.md § Archetypes',
    };
  }
  if (journeys.length > 8) {
    return {
      pass: false,
      detail: `${journeys.length} journey(s) found, expected ≤8 (cap for app-ux-eval graders)`,
      auto_fix_hint: 'consolidate journeys; aim for 2-4 per archetype branch',
    };
  }
  return { pass: true, detail: `${journeys.length} journey(s)` };
}

/**
 * Check 4: Every journey section contains a `**Goal:**` field.
 */
export function checkEachJourneyHasGoal(doc: string): QACheckResult {
  const missing: string[] = [];
  for (const { name, body } of listJourneys(doc)) {
    if (!/\*\*Goal:?\*\*/i.test(body)) {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    return {
      pass: false,
      detail: `${missing.length} journey(s) missing **Goal:** field: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`,
      auto_fix_hint:
        'each journey section must include a `**Goal:**` line stating the user-outcome goal',
    };
  }
  return { pass: true };
}

/**
 * Check 5: Every journey section contains a `**Happy path narrative:**` field.
 */
export function checkEachJourneyHasHappyPath(doc: string): QACheckResult {
  const missing: string[] = [];
  for (const { name, body } of listJourneys(doc)) {
    if (!/\*\*Happy[- ]path[^*]*\*\*/i.test(body)) {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    return {
      pass: false,
      detail: `${missing.length} journey(s) missing **Happy path narrative** field: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`,
      auto_fix_hint:
        'each journey must include a `**Happy path narrative:**` block describing what the FLW does',
    };
  }
  return { pass: true };
}

/**
 * Check 6: Every journey has an Edge-cases block with ≥2 bullet items.
 */
export function checkEachJourneyHasEdgeCases(doc: string): QACheckResult {
  const failures: string[] = [];
  for (const { name, body } of listJourneys(doc)) {
    if (!/\*\*Edge[- ]cases?[^*]*\*\*/i.test(body)) {
      failures.push(`${name} (no Edge-cases block)`);
      continue;
    }
    const edgeCount = countBulletsInSubsection(body, /\*\*Edge[- ]cases?[^*]*\*\*/i);
    if (edgeCount < 2) {
      failures.push(`${name} (${edgeCount} edge case(s), need ≥2)`);
    }
  }
  if (failures.length > 0) {
    return {
      pass: false,
      detail: `${failures.length} journey(s) with insufficient edge cases: ${failures.slice(0, 3).join(', ')}${failures.length > 3 ? '…' : ''}`,
      auto_fix_hint:
        'each journey must have an `**Edge cases:**` block with at least 2 bullet items (UX outcomes, not error codes)',
    };
  }
  return { pass: true };
}

/**
 * Check 7: Every journey has a Pass-criteria block with ≥1 bullet.
 */
export function checkEachJourneyHasPassCriteria(doc: string): QACheckResult {
  const failures: string[] = [];
  for (const { name, body } of listJourneys(doc)) {
    if (!/\*\*Pass[- ]criteria:?\*\*/i.test(body)) {
      failures.push(`${name} (no Pass-criteria block)`);
      continue;
    }
    const passCount = countBulletsInSubsection(body, /\*\*Pass[- ]criteria:?\*\*/i);
    if (passCount < 1) {
      failures.push(`${name} (no pass-criteria bullets)`);
    }
  }
  if (failures.length > 0) {
    return {
      pass: false,
      detail: `${failures.length} journey(s) with missing pass criteria: ${failures.slice(0, 3).join(', ')}${failures.length > 3 ? '…' : ''}`,
      auto_fix_hint:
        'each journey must have a `**Pass criteria:**` block with at least 1 measurable bullet',
    };
  }
  return { pass: true };
}

// ── Helpers ────────────────────────────────────────────────────────

interface Journey {
  name: string;
  body: string;
}

/** Find all `## Journey N — name` (or `## Journey N`) section headings + their bodies. */
function listJourneys(doc: string): Journey[] {
  const out: Journey[] = [];
  const headingRe = /^##\s+Journey\s+([^\n]*)$/gim;
  const matches: { name: string; index: number; length: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(doc)) !== null) {
    matches.push({
      name: `Journey ${m[1].trim()}`.trim(),
      index: m.index,
      length: m[0].length,
    });
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : doc.length;
    out.push({
      name: matches[i].name,
      body: doc.slice(start, end),
    });
  }
  return out;
}

function listJourneyHeadings(doc: string): string[] {
  return listJourneys(doc).map((j) => j.name);
}

/** Generic section extractor: body of `## <heading>` until next `## ` or EOF. */
function extractSection(doc: string, heading: string): string | null {
  const headingRe = new RegExp(`^##\\s+${escapeRegExp(heading)}\\b[^\\n]*$`, 'im');
  const m = doc.match(headingRe);
  if (!m || m.index === undefined) return null;
  const start = m.index + m[0].length;
  const tail = doc.slice(start);
  const nextHeading = tail.match(/^##\s/m);
  const end = nextHeading && nextHeading.index !== undefined ? start + nextHeading.index : doc.length;
  return doc.slice(start, end);
}

/**
 * Count bullet items in the subsection that immediately follows the
 * given subsection-heading regex (a bold line like `**Edge cases:**`).
 *
 * Counts top-level `-` / `*` bullets only. Stops at the next bold heading
 * line or end of journey body.
 */
function countBulletsInSubsection(journeyBody: string, subheadingRe: RegExp): number {
  const lines = journeyBody.split('\n');
  let inSubsection = false;
  let count = 0;
  for (const line of lines) {
    if (subheadingRe.test(line)) {
      inSubsection = true;
      continue;
    }
    if (!inSubsection) continue;
    // Stop at next bold-line subheading (e.g. `**Pass criteria:**` after `**Edge cases:**`)
    if (/^\s*\*\*[^*]+\*\*\s*:?\s*$/.test(line)) {
      break;
    }
    if (/^\s*[-*]\s+\S/.test(line)) {
      count++;
    }
  }
  return count;
}

// ── Canonical CHECKS array ────────────────────────────────────────

export const CHECKS: QACheck[] = [
  {
    id: 'persona_block_present',
    type: 'static',
    description: '§ Persona heading exists with non-empty, non-placeholder body',
    run: checkPersonaBlockPresent,
  },
  {
    id: 'archetype_declared_and_valid',
    type: 'static',
    description: 'Archetype declared in header; value in valid enum',
    run: checkArchetypeDeclared,
  },
  {
    id: 'journey_count_in_range',
    type: 'static',
    description: '≥2 and ≤8 journey sections',
    run: checkJourneyCountInRange,
  },
  {
    id: 'each_journey_has_goal',
    type: 'static',
    description: 'Every journey section contains **Goal:**',
    run: checkEachJourneyHasGoal,
  },
  {
    id: 'each_journey_has_happy_path',
    type: 'static',
    description: 'Every journey section contains **Happy path narrative:**',
    run: checkEachJourneyHasHappyPath,
  },
  {
    id: 'each_journey_has_edge_cases',
    type: 'static',
    description: 'Every journey has an Edge-cases block with ≥2 bullets',
    run: checkEachJourneyHasEdgeCases,
  },
  {
    id: 'each_journey_has_pass_criteria',
    type: 'static',
    description: 'Every journey has a Pass-criteria block with ≥1 bullet',
    run: checkEachJourneyHasPassCriteria,
  },
];
