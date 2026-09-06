/**
 * Static QA checks for `pdd-to-work-order-qa`.
 *
 * Operates on the work-order markdown body. Some checks take additional
 * inputs (the decisions.yaml string, the declared archetype) — they're
 * separate exported functions, all of them pure.
 *
 * Imported by:
 *   - The skill body at runtime via the QA runner
 *   - Per-skill tests under `test/skills/pdd-to-work-order-qa/`
 *
 * The `CHECKS` array is the canonical ordering. Static checks that need
 * supplementary context (decisions.yaml, archetype) receive it via
 * `QACheckContext` — see qa-types.ts for the shape.
 */
import type { QACheck, QACheckContext, QACheckResult } from '../../lib/qa-types';
import { normalizeDriveExport } from '../../lib/drive-export';
import { classifyGrainRelation, readProgramParameter } from '../../lib/payment-grain';

/**
 * The 11 required headings in a complete work order. Matched against
 * `##` and `###` lines, tolerant of leading numeric prefixes (`## 1.`,
 * `### 4.1`) and bold-wrapping (`## **Background**`).
 */
const REQUIRED_SECTIONS: string[] = [
  'Background',
  'Scope of Work',
  'Geographic Coverage',
  'Deliverables and Verification',
  'Timeline and Milestones',
  'Payment Terms',
  'Roles and Responsibilities',
  'Permissions, Ethics, and Compliance',
  'Data Handling',
  'Signatures',
  'Annexures',
];

const REQUIRED_WO_DECISION_IDS = [
  'wo-number',
  'wo-period-of-performance',
  'wo-total-not-to-exceed-usd',
  'wo-payment-schedule-split',
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Drive-export escape normalisation. Lives in `lib/drive-export.ts` because
 * `idea-to-pdd-qa` hit the identical class through its own read path
 * (dimagi-internal/ace#1617) — see that module for the full mechanism. Applied
 * at the entry of every body check below so the reader's `exportAs` is never
 * load-bearing: `SKILL.md` § Process step 1 mandates `text/plain` here, its
 * sibling mandates `text/markdown`, and both must score the same document
 * identically (dimagi-internal/ace#1609).
 *
 * Re-exported so callers and tests that already import it from this module
 * keep working.
 */
export { normalizeDriveExport } from '../../lib/drive-export';

/**
 * Check 1: All 11 required work-order sections are present.
 *
 * Heading-match tolerance (intentional — real work orders vary):
 *   ✓ numbered prefix:  `## 1. Background`, `### 4.1 Primary Deliverable`
 *   ✓ bold-wrapped:     `## **Background**`
 *   ✓ trailing context: `## Background — context`
 *   ✓ case variation:   `## background`
 *   ✗ truncated:        `## Backgrd`
 */
export function checkAllRequiredSectionsPresent(raw: string): QACheckResult {
  const wo = normalizeDriveExport(raw);
  const missing: string[] = [];
  for (const section of REQUIRED_SECTIONS) {
    // Match a section-heading line. Accepts BOTH:
    //   - markdown source (`## 1. Background`, `### 4.1 Primary Deliverable`, `## **Background**`)
    //   - Google Docs plain-text export (`1. Background`, `4.1 Primary Deliverable`, `Signatures`)
    // The `##`/`###` prefix is optional so the same check works against either source.
    const re = new RegExp(
      // Tolerate leading whitespace — gdoc plain-text export tab-indents
      // section headings that abut a preceding table (sections 1, Signatures,
      // Annexures in the work-order template).
      `^\\s*(?:#{2,3}\\s+)?(?:\\*\\*)?(?:\\d+(?:\\.\\d+)?\\.?\\s+)?(?:\\*\\*)?${escapeRegExp(section)}\\b`,
      'mi',
    );
    if (!re.test(wo)) {
      missing.push(section);
    }
  }
  if (missing.length === 0) return { pass: true };
  return {
    pass: false,
    detail: `missing required section(s): ${missing.map((s) => `§ ${s}`).join(', ')}`,
    auto_fix_hint:
      `regenerate the work order with explicit instructions to include each missing section. ` +
      `Missing: ${missing.join(', ')}. ` +
      `Heading match tolerates numbered prefixes (\`## 1.\`, \`### 4.1\`), bold wrapping (\`## **X**\`), ` +
      `the bare gdoc-plain-text form (\`1. Background\`, \`Signatures\`), ` +
      `and trailing context after the section name. The full required-section list is in ` +
      `templates/work-order-template.md.`,
  };
}

/**
 * Check 2: All four required `wo-*` decision rows are present in decisions.yaml.
 *
 * Parses the YAML structure looking for `id: <name>` entries — robust to row order.
 * Doesn't fully validate the schema (that's decisions-schema.ts's job); just confirms
 * the four IDs exist somewhere in the document.
 */
export function checkRequiredWoDecisionsPresent(decisionsYaml: string): QACheckResult {
  const missing: string[] = [];
  for (const id of REQUIRED_WO_DECISION_IDS) {
    // Match `id: <name>` (with optional quoting) on its own line in the YAML.
    const re = new RegExp(`^\\s*-?\\s*id:\\s*['"]?${escapeRegExp(id)}['"]?\\s*$`, 'm');
    if (!re.test(decisionsYaml)) {
      missing.push(id);
    }
  }
  if (missing.length === 0) return { pass: true };
  return {
    pass: false,
    detail: `decisions.yaml missing required wo-* row(s): ${missing.join(', ')}`,
    auto_fix_hint:
      `add the following decision rows to decisions.yaml under \`decisions:\`, each with phase=1-design, ` +
      `skill=pdd-to-work-order, status=ai-default, and an appropriate question/ai-default/source/options: ` +
      missing.join(', '),
  };
}

/**
 * Check 3: Period of Performance has both start + end dates (`YYYY-MM-DD to YYYY-MM-DD`)
 * OR an explicit `[...]` placeholder. Scaffolding `{{...}}` markers fail.
 */
export function checkPeriodOfPerformanceComplete(raw: string): QACheckResult {
  const wo = normalizeDriveExport(raw);
  // Find the Period of Performance value. Tries two layouts:
  //   - markdown table:  `| Period of Performance | 2026-05-22 to 2026-07-31 |`
  //   - gdoc plain text: `Period of Performance\n\t2026-05-22 to 2026-07-31` (label
  //     and value on separate lines; cell prefix may be tab or whitespace).
  const mdMatch = wo.match(/\|\s*Period of Performance\s*\|\s*([^|\n]+?)\s*\|/i);
  const gdocMatch = wo.match(/Period of Performance[\s\r\n]*?[\t ]+([^\r\n]+)/i);
  const m = mdMatch ?? gdocMatch;
  if (!m) {
    return {
      pass: false,
      detail: 'no Period of Performance row found in the header table',
      auto_fix_hint:
        'add a `| Period of Performance | YYYY-MM-DD to YYYY-MM-DD |` row to the header table (or `[TBD]` if dates are still being finalized)',
    };
  }
  const value = m[1].trim();
  const explicitRange = /\d{4}-\d{2}-\d{2}\s+to\s+\d{4}-\d{2}-\d{2}/.test(value);
  // Prose date ranges are house style for the work-order producer
  // (e.g. "May 22, 2026 to July 31, 2026", "Jul 31 2026"). Accept a full or
  // 3-letter month name (optional trailing period, optional comma) on BOTH
  // sides of "to" — a faithful prose render must not trigger an auto-fix loop
  // every run. (jjackson/ace#733)
  const proseRange =
    /[A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4}\s+to\s+[A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4}/.test(value);
  const explicitPlaceholder = /^\[[^\]]+\]$/.test(value);
  if (explicitRange || proseRange || explicitPlaceholder) return { pass: true, detail: value };
  return {
    pass: false,
    detail: `Period of Performance value '${value}' is incomplete (need a start and end date: 'YYYY-MM-DD to YYYY-MM-DD', 'Mon DD, YYYY to Mon DD, YYYY', or '[TBD]')`,
    auto_fix_hint:
      'fill the Period of Performance cell with both a start and end date — ISO `YYYY-MM-DD to YYYY-MM-DD` or prose `Mon DD, YYYY to Mon DD, YYYY` — ' +
      'or a single bracketed placeholder spanning the whole cell, e.g. `[TBD]` or `[Start and end dates set at award]`: ' +
      'one pair of brackets, no nested `]` — NOT two bracketed spans joined by "to". ' +
      'Scaffolding `{{...}}` markers must not leak through.',
  };
}

/**
 * Check 4: Payment schedule percentages in § 6.2 sum to exactly 100.
 *
 * Extracts the section body between `## 6.2` (or `### 6.2`) and the next `##` /`###`
 * heading, finds all `\d+%` matches, sums them. Tolerates table cells, prose, or
 * mixed. Section 6.2 might be `### 6.2 Payment Schedule` (subsection of § 6) so
 * the extractor matches either heading level.
 */
export function checkPaymentScheduleSumsTo100(raw: string): QACheckResult {
  const wo = normalizeDriveExport(raw);
  const body = extractNumberedSection(wo, '6.2');
  if (body === null) {
    return {
      pass: false,
      detail: 'missing § 6.2 Payment Schedule section',
      auto_fix_hint:
        'add a `### 6.2 Payment Schedule` section with a table of milestones, each row showing % of total; percentages must sum to 100',
    };
  }
  const matches = body.match(/(\d{1,3})\s*%/g) || [];
  if (matches.length === 0) {
    return {
      pass: false,
      detail: '§ 6.2 Payment Schedule has no `%` percentages',
      auto_fix_hint:
        'populate § 6.2 with a milestone table whose `% of Total` column contains percentages summing to 100',
    };
  }
  const total = matches.reduce((sum, m) => sum + parseInt(m, 10), 0);
  if (total === 100) return { pass: true, detail: `${matches.length} milestone(s) sum to 100%` };
  return {
    pass: false,
    detail: `§ 6.2 Payment Schedule milestones sum to ${total}% (need 100%)`,
    auto_fix_hint:
      `adjust the milestone percentages in § 6.2 so they sum to exactly 100. Current values: ${matches.join(', ')} = ${total}%.`,
  };
}

/**
 * Check 5: § 6.1 Total Not-to-Exceed has a USD amount or explicit placeholder.
 *
 * Accepts `USD 2500`, `USD 2,500`, `USD [TBD]`. Rejects bare `USD ` with nothing after.
 */
export function checkTotalNtePresent(raw: string): QACheckResult {
  const wo = normalizeDriveExport(raw);
  const body = extractNumberedSection(wo, '6.1');
  if (body === null) {
    return {
      pass: false,
      detail: 'missing § 6.1 Total Not-to-Exceed section',
      auto_fix_hint:
        'add a `### 6.1 Total Not-to-Exceed` section stating `USD <amount>` or `USD [TBD]` if the cap is still being finalized',
    };
  }
  // Match `USD` followed by whitespace then either a digit or `[`.
  const m = body.match(/USD\s+([\d\[])/);
  if (!m) {
    return {
      pass: false,
      detail: '§ 6.1 has no `USD <amount>` (need a digit or `[TBD]` placeholder after `USD`)',
      auto_fix_hint:
        'in § 6.1, state Dimagi\'s commitment as `USD <amount>` (numeric, e.g. `USD 2500`) or `USD [TBD]` if pending',
    };
  }
  return { pass: true };
}

/**
 * Check 6: Both signature blocks present (`**Subcontractor**` + `**Dimagi, Inc.**`).
 *
 * The bold-marker pattern is the canonical template form. Flexible to allow
 * `## Subcontractor` style headings as well.
 */
export function checkSignatureBlocksPresent(raw: string): QACheckResult {
  const wo = normalizeDriveExport(raw);
  // Accept four forms for each label:
  //   - bold form           `**Subcontractor**`
  //   - markdown heading     `## Subcontractor`
  //   - bare, alone on line  `Subcontractor`
  //   - TAB/CELL-DELIMITED   `Subcontractor\tDimagi, Inc.`
  // The last is the load-bearing case: the work-order template's Signatures
  // section is a 2-col Google Docs table whose two column headers live in the
  // SAME table row, so the gdoc plain-text export (what drive_read_file returns
  // and what this QA reads) renders both labels on ONE tab-separated line —
  // `"Subcontractor\tDimagi, Inc."`. The bare `^\s*X\s*$` alternative fails on
  // that line (the trailing tab + the other label aren't whitespace-then-EOL),
  // so we match each label as a standalone token bounded by line-start-or-tab on
  // the left and tab-or-line-end on the right. See jjackson/ace#706.
  //
  // `|` joins `\t` as a cell delimiter so the markdown export of that same
  // table (`| Subcontractor | Dimagi, Inc. |`) matches too — the doc is the
  // same, only `exportAs` differs (dimagi-internal/ace#1609).
  //
  // The CELL-delimited Dimagi alternative requires the full `Dimagi, Inc.`
  // legal name, unlike the bold/heading ones. Allowing bare `Dimagi` in a
  // table cell made the Roles and Responsibilities header row
  // (`| Activity | Partner | Dimagi |`) read as a signature block, so a work
  // order with its signature section deleted still passed. A signature block
  // names the legal entity; a responsibilities column header does not.
  const hasSub =
    /\*\*\s*Subcontractor\s*\*\*|^#{1,3}\s+Subcontractor\b|(?:^|\t|\|)[ \t]*Subcontractor[ \t]*(?:\t|\||$)/im.test(
      wo,
    );
  const hasDimagi =
    /\*\*\s*Dimagi(?:,\s*Inc\.?)?\s*\*\*|^#{1,3}\s+Dimagi(?:,\s*Inc\.?)?\b|(?:^|\t|\|)[ \t]*Dimagi,\s*Inc\.?[ \t]*(?:\t|\||$)/im.test(
      wo,
    );
  const missing: string[] = [];
  if (!hasSub) missing.push('Subcontractor');
  if (!hasDimagi) missing.push('Dimagi, Inc.');
  if (missing.length === 0) return { pass: true };
  return {
    pass: false,
    detail: `missing signature block(s): ${missing.join(', ')}`,
    auto_fix_hint:
      `add a Signatures section with both blocks: \`**Subcontractor**\` (Partner side) and \`**Dimagi, Inc.**\` (Dimagi side), ` +
      `each with By/Name/Title/Date/Address lines. See templates/work-order-template.md.`,
  };
}

/**
 * Check 7: Scope of Work language matches the declared archetype.
 *
 * Branches on the `archetype` argument:
 *   - atomic-visit:        requires visit phrasing as the unit of work
 *   - longitudinal-visits: requires visit phrasing AND a longitudinal marker
 *                          (the entity being followed, or its sequence/phase)
 *   - focus-group:         requires /per[- ]session|attestation/ AND /gdoc|google doc/
 *   - multi-stage:         requires /stage\s*\d|per stage/
 *
 * This check tests ARCHETYPE SHAPE ONLY. It deliberately says nothing about
 * the evidence mechanism (photo, GPS, consent attestation, case state,
 * observation). Photo/GPS is one possible Layer A mechanism, not a property
 * of any archetype — a perfectly valid visit-shaped programme can exclude it,
 * and bednet-check-2-visit does, at source. A bare `/photo|gps/` test was
 * required here until ace#1771 and failed in both directions: it has no
 * polarity, so it PASSED a contract whose only § 2 mention of photo/GPS was
 * an exclusion bullet ("The partner will not: Collect photographs, GPS
 * coordinates..."), and it would have FAILED the same contract had that
 * exclusion simply been omitted — then told the producer, via auto_fix_hint,
 * to add photo/GPS language contradicting its own PDD. Evidence-mechanism
 * coverage, if ever wanted, belongs in a separate check driven by what the
 * PDD's Evidence Model Layer A actually declares, with polarity, not
 * assumed from the archetype.
 *
 * Pass `null`/`undefined` to skip the check entirely (returns pass with a note).
 */
export function checkArchetypeAppropriateScope(
  raw: string,
  archetype?: string | null,
): QACheckResult {
  if (!archetype) {
    return { pass: true, detail: 'archetype not provided; skip' };
  }
  const wo = normalizeDriveExport(raw);
  const scope = extractNumberedSection(wo, '2') ?? wo;
  const missing: string[] = [];
  if (archetype === 'atomic-visit') {
    // Accept any visit-shaped phrasing — "per visit", "per-visit", "each
    // visit", "household visit", "household-level visit", or just the noun
    // "visit" used as the unit. Differentiation from focus-group comes from
    // the absence of session/attestation/gdoc language, not from a single
    // canonical phrase.
    if (!/\bvisit(?:s|-|\b)/i.test(scope)) missing.push('"visit" phrasing as the unit of work');
  } else if (archetype === 'longitudinal-visits') {
    // Same visit-shaped unit as atomic-visit — the paid thing is still one
    // visit producing one record. What must ALSO be present is evidence the
    // scope describes work against a followed entity over time, because that
    // is the whole distinction. A work order that reads identically to an
    // atomic-visit one has lost the longitudinal half somewhere between the
    // PDD and the contract, which is exactly how ace#1462 happened: the PDD
    // prose was longitudinal-aware and the payment predicate was not.
    if (!/\bvisit(?:s|-|\b)/i.test(scope)) missing.push('"visit" phrasing as the unit of work');
    if (!/\b(case|cases|household|community|participant|enrol|enroll|register|registered|cohort|longitudinal|over time|follow[- ]?up|repeat|phase|sequence|milestone|visit\s*\d)\b/i.test(scope)) {
      missing.push('a longitudinal marker (the followed entity, or its phase/sequence/follow-up cadence)');
    }
  } else if (archetype === 'focus-group') {
    if (!/per[- ]session|session|attestation/i.test(scope)) missing.push('"session" or attestation phrasing');
    if (!/gdoc|google\s+doc/i.test(scope)) missing.push('gdoc reference');
  } else if (archetype === 'multi-stage') {
    if (!/stage\s*\d|per stage/i.test(scope)) missing.push('stage phrasing');
  } else {
    return {
      pass: false,
      detail: `unknown archetype '${archetype}' (expected atomic-visit | longitudinal-visits | focus-group | multi-stage)`,
      auto_fix_hint:
        'archetype must be one of atomic-visit, longitudinal-visits, focus-group, multi-stage; verify the PDD frontmatter',
    };
  }
  if (missing.length === 0) return { pass: true, detail: `scope matches ${archetype} archetype` };
  return {
    pass: false,
    detail: `scope of work does not match ${archetype} archetype: missing ${missing.join(', ')}`,
    auto_fix_hint:
      `rewrite § 2 Scope of Work to match the ${archetype} archetype's expected language. ` +
      `Missing markers: ${missing.join(', ')}. ` +
      `atomic-visit needs visit phrasing as the unit of work; longitudinal-visits needs that PLUS the followed ` +
      `entity (case/household/community) or its phase/sequence; focus-group needs "per session"/attestation + gdoc; ` +
      `multi-stage needs stage references. Do NOT add evidence-mechanism language (photo, GPS) to satisfy this ` +
      `check — the archetype does not determine the evidence model, and the PDD may put those out of scope.`,
  };
}

/**
 * Check 8: No leaked template markers in the final artifact.
 *
 * Two marker families must both be absent from a rendered work order:
 *  - `<<...>>` — intermediate scaffolding / producer notes that must be
 *    stripped before ship.
 *  - `{{...}}` — the template's fill-in tokens (e.g. `{{scope_will_body}}`).
 *    Every one is supposed to be substituted during render; a surviving
 *    `{{...}}` means a fill-in was never populated. This is exactly as
 *    regen-blocking as a leaked `<<...>>` and previously slipped through
 *    because only `<<...>>` was matched (jjackson/ace#833).
 */
export function checkNoScaffoldingMarkers(raw: string): QACheckResult {
  const wo = normalizeDriveExport(raw);
  const matches = [...(wo.match(/<<[^>]*>>/g) || []), ...(wo.match(/\{\{[^}]*\}\}/g) || [])];
  if (matches.length === 0) return { pass: true };
  const dedup = Array.from(new Set(matches));
  return {
    pass: false,
    detail: `found ${matches.length} leaked template marker(s): ${dedup.join(', ')}`,
    auto_fix_hint:
      `strip all leaked \`<<...>>\` scaffolding markers and unfilled \`{{...}}\` template tokens from the work order — ` +
      `they're producer scaffolding / un-substituted fill-ins, not final content. ` +
      `Replace each with the concrete value it represents, or remove the surrounding phrase if no longer applicable. ` +
      `Markers found: ${dedup.join(', ')}.`,
  };
}

/**
 * Renderer instructions that survived templating into the delivered contract.
 *
 * The class the existing preventers were built for but do not cover:
 * **scaffolting that does not look like scaffolding** (ace#1004). The live
 * WORK_ORDER_TEMPLATE_ID ended § 6.2 with
 *
 * > "…at the per-visit (or per-session, per archetype) rate proposed in the
 * > partner's solicitation response."
 *
 * `(or per-session, per archetype)` tells the RENDERER which archetype branch
 * to pick, and it rendered verbatim into a signed contract — a partner reading
 * their own work order saw a parenthetical about an "archetype" defined
 * nowhere in the document. It is not a `{{token}}` and not a `<<marker>>`, so
 * `no_scaffolding_markers` passed it, and the skill's own token-coverage scan
 * (§ Process step 5, the ace#819 preventer) looks only for surviving `{{`.
 * QA returned 8/8 with the defect present.
 *
 * Kept HIGH-PRECISION on purpose. A work order is full of legitimate
 * parentheticals ("(see § 4.1)", "(or quarterly, at their discretion)"), so a
 * broad "flag alternation" rule would be the always-fires class and would be
 * routed around within a run. Three narrow triggers only:
 *
 *  1. the literal renderer tell `per archetype` / `by archetype`;
 *  2. a parenthetical alternation between two PAYMENT-UNIT nouns — the choice
 *     the archetype branch exists to make;
 *  3. an unresolved authoring marker (TODO / TBD / FIXME) addressed to whoever
 *     renders the document.
 */
const UNIT_NOUNS = ['visit', 'session', 'meeting', 'household', 'group', 'participant', 'form', 'delivery'];

const UNIT_RE = new RegExp(`per[- ](?:${UNIT_NOUNS.join('|')})s?\\b`, 'i');

/**
 * A parenthetical is a renderer instruction when it names a payment UNIT and
 * is offering it as an ALTERNATIVE — either it opens with "or" (the
 * alternative to the unit stated outside the parens) or it names a second unit
 * inside. Everything else — "(see § 4.1)", "(or quarterly, at their
 * discretion)" — is ordinary contract prose and must not fire.
 */
function unrenderedUnitAlternation(wo: string): string | null {
  for (const m of wo.matchAll(/\(([^)]*)\)/g)) {
    const inner = m[1];
    const units = [...inner.matchAll(new RegExp(UNIT_RE.source, 'gi'))];
    if (units.length === 0) continue;
    const opensWithOr = /^\s*or\b/i.test(inner);
    if (opensWithOr || units.length >= 2) return m[0];
  }
  return null;
}

const RENDERER_TELLS: Array<{ find: (wo: string) => string | null; why: string }> = [
  {
    find: (wo) => /\b(?:per|by)\s+archetype\b/i.exec(wo)?.[0] ?? null,
    why: '"per archetype" is an instruction to the renderer — the partner has no idea what an archetype is',
  },
  {
    find: unrenderedUnitAlternation,
    why: 'a parenthetical offering an alternative payment UNIT is the archetype branch left unrendered — pick one',
  },
  {
    // `[TBD]` — a bare TBD alone inside brackets — is the placeholder checks 3
    // and 5 explicitly instruct the producer to write, so it must NOT read as a
    // renderer tell. Before ace#1484 it did: check 5's auto_fix_hint said "state
    // `USD [TBD]` if pending" and this rule then failed the document for saying
    // exactly that, so a producer following the hint could never satisfy both
    // checks and the Phase-1 loop oscillated until it halted `incomplete`.
    //
    // Everything else still fails, because everything else IS addressed to a
    // renderer rather than to the counterparty: bare `TBD` in prose, `TODO:`,
    // `FIXME`, and `[TBD-by-renderer]` (bracketed, but naming the renderer —
    // the brackets don't launder it).
    find: (wo) =>
      /\b(?:TODO|TBD(?:-by-\w+)?|FIXME)\b/i.exec(wo.replace(/\[TBD\]/gi, '[…]'))?.[0] ?? null,
    why: 'an authoring marker addressed to whoever renders the document',
  },
];

export function checkNoRendererInstructions(raw: string): QACheckResult {
  const wo = normalizeDriveExport(raw);
  const findings: string[] = [];
  for (const { find, why } of RENDERER_TELLS) {
    const hit = find(wo);
    if (hit) findings.push(`"${hit.trim()}" — ${why}`);
  }
  if (findings.length === 0) return { pass: true };
  return {
    pass: false,
    detail: `found ${findings.length} renderer instruction(s) in the delivered contract: ${findings.join('; ')}`,
    auto_fix_hint:
      'Resolve each to the single value this opportunity actually uses, in the TEMPLATE rather than by ' +
      'hand-editing the rendered doc — a hardcoded sentence outside the token system is one the producing ' +
      'skill cannot influence, which is how it reached a signed contract. § 6.2\'s closing sentence is ' +
      '`{{payment_unit_closing}}`; emit the archetype-appropriate wording for it. Do NOT regenerate the ' +
      'PDD (dimagi-internal/ace#1004).',
  };
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Extract the body of a numbered section like `## 6.1 Total Not-to-Exceed` or
 * `### 6.2 Payment Schedule` (everything until the next heading of equal or
 * higher level, or EOF).
 *
 * For top-level numbers (e.g. `6`), matches `## 6.` style; for sub-sections
 * (e.g. `6.1`), matches `### 6.1` style. Returns null if not found.
 */
function extractNumberedSection(wo: string, number: string): string | null {
  // Determine heading depth from the number's dot-count.
  const depth = number.includes('.') ? 3 : 2;
  const hashes = '#'.repeat(depth);
  // Accept BOTH markdown source (`### 6.1 …`) and gdoc plain-text (`6.1 …`).
  // The `##`/`###` prefix is optional.
  const headingRe = new RegExp(
    // Tolerate leading whitespace (gdoc plain-text export indents some
    // headings with `\t` when they abut a table).
    `^\\s*(?:${hashes}\\s+)?(?:\\*\\*)?${escapeRegExp(number)}(?:\\.|\\s)[^\\n]*$`,
    'mi',
  );
  const headingMatch = wo.match(headingRe);
  if (!headingMatch || headingMatch.index === undefined) return null;
  const bodyStart = headingMatch.index + headingMatch[0].length;
  const tail = wo.slice(bodyStart);
  // Stop at the next equal-or-higher heading. Accepts BOTH markdown form
  // (`^#{1,depth}\s`) AND gdoc plain-text numbered form (e.g. when extracting
  // `6.1` at depth 3, stop on the next subsection `6.2 …` or top-level `7. …`;
  // when extracting `6` at depth 2, stop on the next top-level `7. …`).
  // The numbered alternative matches a digit-prefixed heading at depth-or-higher.
  const stopAlternatives = [
    // markdown heading — narrow to `##` (depth 2) or `###` (depth 3) since
    // standalone `#` characters appear inside table cells (e.g. the `#`
    // column header of section 6.2's payment table) and would otherwise
    // truncate the extracted body.
    `#{2,${depth}}\\s`,
    // numbered plain-text heading at depth-or-higher:
    //   depth=2 (top-level): `^\d+\.\s` (matches `7. …`)
    //   depth=3 (subsection): `^\d+\.\d+\s` OR `^\d+\.\s` (matches `6.2 …` or `7. …`)
    depth === 3 ? `\\d+\\.\\d+\\s|\\d+\\.\\s` : `\\d+\\.\\s`,
  ];
  const stopRe = new RegExp(`^\\s*(?:\\*\\*)?(?:${stopAlternatives.join('|')})`, 'm');
  const nextHeadingMatch = tail.match(stopRe);
  const bodyEnd =
    nextHeadingMatch && nextHeadingMatch.index !== undefined
      ? bodyStart + nextHeadingMatch.index
      : wo.length;
  return wo.slice(bodyStart, bodyEnd);
}

// ── Canonical CHECKS array ────────────────────────────────────────

/**
 * Ordered list of static checks pdd-to-work-order-qa runs against a work-order
 * artifact. The `id` of each check matches the row in
 * skills/pdd-to-work-order-qa/SKILL.md `## Checks` table.
 *
 * Context expected:
 *   - `decisionsYaml: string` — the decisions.yaml file contents (for check 2)
 *   - `archetype: string` — the PDD-declared archetype (for check 7)
 */
/**
 * Check 10: the rate unit the Work Order quotes is not finer than the
 * `entity_id` grain that actually resolves payable units (ace#1946).
 *
 * The PDD-side counterpart is `idea-to-pdd-qa § payment_unit_matches_entity_grain`
 * (ace#1420) and the comparison logic is shared via `lib/payment-grain.ts`, so
 * the two documents cannot disagree about what a payable unit is.
 *
 * Why the PDD-side check is not enough: it gates the PDD, and the error can
 * re-enter one step downstream in the document that actually gets SIGNED.
 * That is exactly what happened on bednet-check-2-visit/20260902-1555 —
 * `idea-to-pdd-qa` caught the per-visit/per-worker-day mismatch, the PDD was
 * corrected, and then `pdd-to-work-order`'s own archetype template put the
 * per-visit sentence back into § 6.2 while this QA returned 9/9. It was caught
 * only by a downstream eval dimension reading the paragraph. On that opp the
 * overstatement was up to 6x.
 *
 * Grain sources, in order:
 *   1. `ctx.entityIdGrain` — an explicitly supplied grain string.
 *   2. `ctx.pddText` — the PDD body's `| entity_id_grain | ... |` row
 *      (the skill passes it via `--pdd`).
 *   3. The Work Order's OWN payable-unit declaration, when it carries one.
 *      This is the self-contradiction case and needs no context at all: the
 *      rendered § 6.2 on that run said both "at the per-visit rate" and "the
 *      payable unit under this Work Order is a worker-day, not an individual
 *      visit".
 *
 * Skips silently (pass) when no grain is available from any source — an
 * undecided grain is not in scope, per the binary-QA convention.
 */
export function checkPaymentUnitMatchesEntityGrain(
  raw: string,
  ctx?: QACheckContext,
): QACheckResult {
  const wo = normalizeDriveExport(raw);

  const rate = extractQuotedRateUnit(wo);
  if (rate === null) {
    return { pass: true, detail: 'no "per-<unit> rate" phrasing found in the work order — not applicable' };
  }

  const grain = resolveEntityIdGrain(wo, ctx);
  if (grain === null) {
    return {
      pass: true,
      detail:
        `work order quotes a "${rate}" rate, but no entity_id_grain is available ` +
        `(pass the PDD body via --pdd, or ctx.entityIdGrain) — not applicable`,
    };
  }

  const relation = classifyGrainRelation(rate, grain.value);
  if (relation.kind !== 'mismatch') {
    return {
      pass: true,
      detail: `work-order rate unit ("${rate}") is consistent with entity_id_grain ("${grain.value}", from ${grain.source})`,
    };
  }

  return {
    pass: false,
    detail:
      `the work order quotes a per-${relation.unitEvent} rate ("${rate}") but the payable unit is ` +
      `day-scoped ("${grain.value}", from ${grain.source}): Connect resolves payable units by ` +
      `entity_id, so several same-day ${relation.unitEvent}s by one worker collapse into ONE payable ` +
      `unit. This is a contractual document — the partner has been quoted a price per ` +
      `${relation.unitEvent} for something Connect will not pay per ${relation.unitEvent}.`,
    auto_fix_hint:
      `Re-derive § 6 Payment Terms against the GRAIN, not the archetype. Quote the rate per the ` +
      `payable unit the opportunity actually resolves (e.g. "…at the per-day rate proposed in the ` +
      `partner's solicitation response, for each verified follow-up day"), with the band multiplied ` +
      `by the expected ${relation.unitEvent}s per worker-day, and restate any caps and the ` +
      `not-to-exceed total in those same units. Do NOT take the sentence from the archetype: ` +
      `\`pdd-to-work-order\` § Process step 5 derives \`{{payment_unit_closing}}\` from the PDD's ` +
      `\`entity_id_grain\` / \`payment_rate_unit\`, because the archetype does not determine the ` +
      `grain — the opportunity does (ace#1946, ace#1420).`,
  };
}

/**
 * Pull the unit out of the Work Order's quoted rate — the "<unit>" in
 * "at the per-<unit> rate". Matches the § 6 Payment Terms body when it can be
 * isolated, else the whole document.
 *
 * Returns the FIRST per-event unit found if there is one (a mixed multi-stage
 * work order should be judged on the finest unit it quotes), else the first
 * unit found at all.
 */
function extractQuotedRateUnit(wo: string): string | null {
  const body = extractNumberedSection(wo, '6') ?? wo;
  // `per-visit rate`, `per visit rate`, `per verified follow-up day rate`.
  const re = /\bper[-\s]((?:[A-Za-z][A-Za-z-]*)(?:\s+[A-Za-z][A-Za-z-]*){0,3}?)\s+rates?\b/gi;
  const units: string[] = [];
  for (const m of body.matchAll(re)) units.push(`per-${m[1].trim().toLowerCase()}`);
  if (units.length === 0) return null;
  for (const u of units) {
    if (classifyGrainRelation(u, 'day').kind === 'mismatch') return u;
  }
  return units[0];
}

/**
 * Resolve the `entity_id` grain from context, or from the work order's own
 * payable-unit declaration.
 *
 * The self-declaration branch is deliberately narrow: it reads only a sentence
 * naming the "payable unit" / "payment unit", and only accepts a day term used
 * as the unit NOUN (`a worker-day`, `each calendar day`, `per day`). Without
 * that shape a settlement window ("within 30 days of invoice receipt") in the
 * same sentence would read as a day-scoped grain and fail a sound contract.
 */
function resolveEntityIdGrain(
  wo: string,
  ctx?: QACheckContext,
): { value: string; source: string } | null {
  const explicit = (ctx?.entityIdGrain as string | undefined)?.trim();
  if (explicit) return { value: explicit, source: 'ctx.entityIdGrain' };

  const pddText = (ctx?.pddText as string | undefined) ?? '';
  const fromPdd = readProgramParameter(pddText, 'entity_id_grain');
  if (fromPdd) return { value: fromPdd, source: 'PDD § Program Parameters' };

  // Collapse soft line-wraps first: a rendered paragraph is one SENTENCE but
  // several lines, so a newline is not a boundary here — the period is.
  const flat = wo.replace(/\s+/g, ' ');
  for (const m of flat.matchAll(/(?:payable|payment)\s+unit\b[^.]{0,200}/gi)) {
    const sentence = m[0];
    if (/\b(?:a|an|the|per|each|one)\s+(?:[A-Za-z]+[-\s])?(?:day|date)\b/i.test(sentence)) {
      return { value: sentence.trim(), source: 'the work order’s own payable-unit declaration' };
    }
  }
  return null;
}

/**
 * Check 11: a committed advance percentage against an UNRESOLVED not-to-exceed
 * must say that nothing is payable until the cap is fixed (ace#2007).
 *
 * `checkTotalNtePresent` deliberately accepts `USD [TBD]` — a work order drafted
 * before a partner is selected is the normal Phase 1 case, and the cap is set by
 * the solicitation. What is NOT normal is pairing that placeholder with a
 * milestone table that reads as a commitment: "40% mobilization advance", amount
 * cell "[Amount derived from the agreed cap]". A percentage of an undefined base
 * is not a signable commitment, and on poverty-graduation/20260905-0924 the
 * `commercial_realism` judge scored it strike 1 of 3 and called it sufficient on
 * its own to make the draft unsignable.
 *
 * The fix is NOT to remove the split — a 40/60 structure pending a cap is an
 * ordinary pre-award shape, and `checkPaymentScheduleSumsTo100` requires the
 * percentages to remain readable. It is to make the contingency EXPLICIT in the
 * document, which costs one sentence and no legal drafting.
 *
 * Scope note: this deliberately does NOT police termination / liability / IP /
 * governing-law clauses. Those are absent from the work-order body by design —
 * it is annexed to an MSA (`templates/work-order-template.md:147`), which is
 * where they live. ace#1481 asserted otherwise and was closed NOT_PLANNED with
 * the premise disproved; do not re-add that check.
 */
export function checkAdvanceContingentWhenCapUnresolved(raw: string): QACheckResult {
  const wo = normalizeDriveExport(raw);
  const nte = extractNumberedSection(wo, '6.1');
  const schedule = extractNumberedSection(wo, '6.2');
  // Either section missing is already reported by its own check; do not
  // double-report it here.
  if (nte === null || schedule === null) return { pass: true };

  // Is the cap a real number, or a bracketed placeholder? `checkTotalNtePresent`
  // has already established one of the two forms follows `USD`.
  const capResolved = /USD\s+\d/.test(nte);
  if (capResolved) return { pass: true };

  // Cap is unresolved. Does the schedule state that nothing is owed yet?
  const contingencyStated =
    /no (?:payment|amount|sum)[^.\n]{0,80}(?:due|owed|payable)/i.test(schedule) ||
    /(?:not|no)[^.\n]{0,40}(?:payable|due|owed)[^.\n]{0,80}until[^.\n]{0,80}cap/i.test(schedule) ||
    /indicative[^.\n]{0,120}(?:until|pending|upon)/i.test(schedule) ||
    /percentages?[^.\n]{0,120}(?:structural|indicative|not a commitment)/i.test(schedule);

  if (contingencyStated) return { pass: true };

  return {
    pass: false,
    detail:
      '\u00a7 6.1 states the not-to-exceed as a placeholder rather than a number, but \u00a7 6.2 ' +
      'presents the milestone percentages as a commitment with no statement that nothing is ' +
      'payable until the cap is fixed. A percentage of an undefined base is not a signable ' +
      'commitment.',
    auto_fix_hint:
      'keep the percentage split (it is an ordinary pre-award structure and payment_schedule_sums_to_100 ' +
      'requires it), and add one sentence to \u00a7 6.2 such as: "These percentages are indicative of the ' +
      'agreed split only. No amount is payable under this schedule until the total not-to-exceed in ' +
      '\u00a7 6.1 is fixed at contract execution."',
  };
}

/**
 * Check 12: a milestone schedule and a per-unit rate in the same § 6.2 must say
 * how they relate (ace#2023, strike 1).
 *
 * These are two different payment models. A 40/60 milestone split pays against
 * the cap; a per-verified-unit rate pays against delivery. Both are legitimate,
 * and real contracts carry both — but only when one says whether the advance is
 * RECOVERABLE against accrued units or is a separate stream. Silence there is
 * what a contracts reviewer cannot sign, and neither
 * `payment_schedule_sums_to_100` (which only sums percentages) nor
 * `payment_unit_matches_entity_grain` (which compares the rate unit to the
 * entity grain) can see it.
 */
export function checkPaymentModelsReconciled(raw: string): QACheckResult {
  const wo = normalizeDriveExport(raw);
  const schedule = extractNumberedSection(wo, '6.2');
  if (schedule === null) return { pass: true }; // owned by payment_schedule_sums_to_100

  const hasMilestones = /\d{1,3}\s*%/.test(schedule);
  const hasPerUnit = /per[- ](?:verified[- ])?unit|per verified unit|rate per/i.test(schedule);
  if (!hasMilestones || !hasPerUnit) return { pass: true }; // only one model — nothing to reconcile

  const reconciled =
    /recoverab|recouped|offset against|credited against|deducted from|drawn down|reconcile[sd]? against/i.test(
      schedule,
    );
  if (reconciled) return { pass: true };

  return {
    pass: false,
    detail:
      '\u00a7 6.2 states BOTH a milestone percentage schedule and a per-unit rate without saying how ' +
      'they relate \u2014 whether the advance is recoverable against accrued units or is a separate ' +
      'stream. A reviewer cannot tell what is owed when both apply.',
    auto_fix_hint:
      'add one clause to \u00a7 6.2 stating the relationship, e.g. "The mobilization advance is ' +
      'recoverable: verified units accrue against it until it is fully drawn down, after which units ' +
      'are paid at the agreed rate." Keep both models; state the link.',
  };
}

/**
 * Check 13: a per-FLW cap the PDD DECLARES must reach the contract (ace#2023,
 * strike 2).
 *
 * `daily_cap_per_flw` is an anti-skimming control. It only controls anything if
 * the party bound by it can read it, and with a per-unit rate against an
 * unresolved NTE it is the only volume bound the contract has.
 *
 * Reads the cap BY KEY from decisions.yaml. It does NOT infer a cap from any
 * other numeric row: on poverty-graduation/20260905-1345 the eval judge read
 * `expected_reach_min: 300` as a `total_cap_per_flw` that does not exist
 * anywhere in the PDD, and struck the work order for omitting it. Absence of a
 * declared cap is a PASS here — this check enforces transmission, never
 * invention.
 */
export function checkDeclaredCapReachesContract(
  raw: string,
  ctx?: QACheckContext,
): QACheckResult {
  const decisions = (ctx?.decisionsYaml as string) ?? '';
  // `daily_cap_per_flw: 25`, or the decisions-row form with the value on its
  // own line beneath the id.
  const m =
    decisions.match(/daily_cap_per_flw["']?\s*:\s*["']?(\d+)/i) ??
    decisions.match(/daily[-_]cap[-_]per[-_]flw[\s\S]{0,120}?["']?ai-default["']?\s*:\s*["']?(\d+)/i);
  if (!m) return { pass: true }; // no declared cap — nothing to transmit

  const cap = m[1];
  const wo = normalizeDriveExport(raw);
  const payment = extractNumberedSection(wo, '6');
  const body = payment ?? wo;
  if (new RegExp(`\\b${cap}\\b`).test(body)) return { pass: true };

  return {
    pass: false,
    detail:
      `the design declares a per-FLW daily cap of ${cap}, but it does not appear in \u00a7 6 Payment ` +
      'Terms. A cap the paying party never states is not a control, and with a per-unit rate it is the ' +
      'only volume bound the contract carries.',
    auto_fix_hint:
      `state the cap in \u00a7 6, e.g. "No more than ${cap} verified units per field worker per day are ` +
      'payable." Transmit only caps the design actually declares \u2014 do NOT invent a programme-wide ' +
      'total from a neighbouring figure such as expected reach (ace#2023).',
  };
}

/**
 * Check 14: a milestone that pays on "acceptance" must define acceptance
 * (ace#2023, strike 3).
 *
 * The rubric's own named failure mode is "payment triggers that aren't tied to
 * an objectively determinable event". "Acceptance of the final verified dataset"
 * with no criteria, no window and no deemed-acceptance default is exactly that:
 * the paying party can withhold indefinitely by not accepting.
 */
export function checkAcceptanceDefined(raw: string): QACheckResult {
  const wo = normalizeDriveExport(raw);
  const schedule = extractNumberedSection(wo, '6.2');
  if (schedule === null) return { pass: true };

  if (!/accept(?:ance|ed|s)?\b/i.test(schedule)) return { pass: true }; // no acceptance trigger to define

  // The window must run from SUBMISSION/DELIVERY/RECEIPT, i.e. from the event
  // that starts the acceptance clock. A window measured FROM acceptance is a
  // payment term, not a definition of acceptance — "Within 30 days of
  // acceptance" tells you when money moves once acceptance has happened, and
  // says nothing about when or whether it happens. Measured on
  // poverty-graduation/20260905-1345, whose milestone-2 timing cell reads
  // exactly that and false-passed the first cut of this check.
  const defined =
    /deemed[- ]accept/i.test(wo) ||
    /accept(?:ance)?\s+criteria/i.test(wo) ||
    /within\s+\d+\s+(?:business\s+)?days?\s+(?:of|after|from)\s+(?:the\s+|each\s+|final\s+)*(?:submission|delivery|receipt|submitted|delivered)/i.test(
      wo,
    );
  if (defined) return { pass: true };

  return {
    pass: false,
    detail:
      '\u00a7 6.2 pays on "acceptance" but the document defines no acceptance criteria, no review ' +
      'window, and no deemed-acceptance default \u2014 so the trigger is not objectively determinable ' +
      'and payment can be withheld indefinitely by not accepting.',
    auto_fix_hint:
      'define acceptance once and reference it: state a review window and a deemed-acceptance default, ' +
      'e.g. "Dimagi will review within 15 business days of submission; absent written rejection ' +
      'identifying the deficient units, the submission is deemed accepted."',
  };
}

export const CHECKS: QACheck[] = [
  {
    id: 'all_required_sections_present',
    type: 'static',
    description: '11 required work-order sections all present',
    run: (wo: string) => checkAllRequiredSectionsPresent(wo),
  },
  {
    id: 'required_wo_decisions_present',
    type: 'static',
    description: 'All four required wo-* decision rows present in decisions.yaml',
    run: (_wo: string, ctx?: QACheckContext) =>
      checkRequiredWoDecisionsPresent(((ctx?.decisionsYaml as string) ?? '')),
  },
  {
    id: 'period_of_performance_complete',
    type: 'static',
    description: 'Period of Performance has both start + end dates (or [TBD])',
    run: (wo: string) => checkPeriodOfPerformanceComplete(wo),
  },
  {
    id: 'payment_schedule_sums_to_100',
    type: 'static',
    description: 'Milestone percentages in § 6.2 sum to exactly 100',
    run: (wo: string) => checkPaymentScheduleSumsTo100(wo),
  },
  {
    id: 'total_nte_present',
    type: 'static',
    description: '§ 6.1 has `USD <amount>` (numeric) or `USD [TBD]` placeholder',
    run: (wo: string) => checkTotalNtePresent(wo),
  },
  {
    id: 'signature_blocks_present',
    type: 'static',
    description: 'Both Subcontractor and Dimagi, Inc. signature blocks present',
    run: (wo: string) => checkSignatureBlocksPresent(wo),
  },
  {
    id: 'archetype_appropriate_scope',
    type: 'static',
    description: 'Scope of Work language matches the declared archetype',
    run: (wo: string, ctx?: QACheckContext) =>
      checkArchetypeAppropriateScope(wo, (ctx?.archetype as string | undefined) ?? null),
  },
  {
    id: 'no_renderer_instructions',
    type: 'static',
    description:
      'No renderer instructions survived into the delivered contract — "per archetype", an unrendered ' +
      'payment-unit alternation, or a TODO/TBD/FIXME marker (dimagi-internal/ace#1004)',
    run: (wo: string) => checkNoRendererInstructions(wo),
  },
  {
    id: 'no_scaffolding_markers',
    type: 'static',
    description: 'No leaked `<<...>>` scaffolding markers or unfilled `{{...}}` template tokens from intermediate generation',
    run: (wo: string) => checkNoScaffoldingMarkers(wo),
  },
  {
    id: 'advance_contingent_when_cap_unresolved',
    type: 'static',
    description:
      'A milestone percentage stated against an unresolved \u00a7 6.1 cap must say that nothing is ' +
      'payable until the cap is fixed (dimagi-internal/ace#2007)',
    run: (wo: string) => checkAdvanceContingentWhenCapUnresolved(wo),
  },
  {
    id: 'payment_models_reconciled',
    type: 'static',
    description:
      'A milestone schedule and a per-unit rate in the same \u00a7 6.2 state how they relate ' +
      '(dimagi-internal/ace#2023)',
    run: (wo: string) => checkPaymentModelsReconciled(wo),
  },
  {
    id: 'declared_cap_reaches_contract',
    type: 'static',
    description:
      'A per-FLW daily cap the design DECLARES appears in \u00a7 6 Payment Terms; a cap the design ' +
      'does not declare is never invented (dimagi-internal/ace#2023)',
    run: (wo: string, ctx?: QACheckContext) => checkDeclaredCapReachesContract(wo, ctx),
  },
  {
    id: 'acceptance_defined',
    type: 'static',
    description:
      'A milestone paying on "acceptance" defines criteria, a review window, or a deemed-acceptance ' +
      'default (dimagi-internal/ace#2023)',
    run: (wo: string) => checkAcceptanceDefined(wo),
  },
  {
    id: 'payment_unit_matches_entity_grain',
    type: 'static',
    description:
      'The rate unit quoted in \u00a7 6 Payment Terms is not finer than the entity_id grain that ' +
      'actually resolves payable units (dimagi-internal/ace#1946; PDD-side counterpart ace#1420)',
    run: (wo: string, ctx?: QACheckContext) => checkPaymentUnitMatchesEntityGrain(wo, ctx),
  },
];
