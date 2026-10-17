/**
 * Does Phase 7 (synthetic-data-and-workflows) apply to this design at all?
 * (ace#2806)
 *
 * Phase 7's product is a semantic-layer CASCADE: a programme of partners, each
 * with a roster of workers, followed over weeks, with a lagging partner and a
 * standout worker to find (`lib/cascade-story.ts` `DEFAULT_FLOORS` and the four
 * `REQUIRED_SIGNAL_KINDS`). A design with a single worker, or with no partner
 * organisation at all, has none of that to show — so every route to a green
 * Phase 7 runs through invented partners, workers and weeks, which
 * `CLAUDE.md § No inferred backstory` forbids. `group-payment-test/20261007-1700`
 * (one worker, no partner) failed `demo-data-setup-qa` 6/10 BY CONSTRUCTION.
 *
 * Operator decision (Jonathan, 2026-10-16): such a design SKIPS Phase 7 and
 * records why. There is deliberately no reduced-floor mode: a floor lowered to
 * fit a one-worker design produces a dashboard whose every comparison is empty.
 *
 * The decision is read from what the PDD itself says, never inferred:
 *   - single worker — `§ FLW Requirements` "Number of FLWs" is 1 (or 0);
 *   - no partner    — `§ LLO Preference` says there is NO partner / implementing
 *                     organisation / LLO. "None pre-named" is NOT that: it means
 *                     the LLO has not been chosen yet (Phase 8 selects one), and
 *                     the design still has a partner.
 * A PDD that states neither keeps Phase 7. An unparseable FLW count keeps it too —
 * skipping a phase is the claim that needs evidence, not running it.
 *
 * Pure. The phase doc (`agents/synthetic-data-and-workflows.md § Scale: a
 * single-worker or no-partner design is a no-op`) runs it via
 * `scripts/phase7-applicability.ts`.
 */

export type Phase7SkipKind = 'single-worker' | 'no-partner';

export interface Phase7SkipReason {
  kind: Phase7SkipKind;
  /** The PDD line the decision rests on, verbatim (trimmed). */
  evidence: string;
}

/** Stable `run_state.yaml` `skip_reason` for a scale skip. */
export const PHASE7_SCALE_SKIP_REASON = 'design-below-cascade-scale';

export type Phase7Applicability =
  | { applicable: true; flw_count: number | null }
  | {
      applicable: false;
      skip_reason: typeof PHASE7_SCALE_SKIP_REASON;
      reasons: Phase7SkipReason[];
      flw_count: number | null;
      /** One sentence for `skip_detail` / the phase summary. */
      detail: string;
    };

/** The body of a `## <heading>` section (to the next `## `), or null. */
export function pddSection(pdd: string, heading: RegExp): string | null {
  const lines = pdd.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+/.test(l) && heading.test(l.replace(/^##\s+/, '')));
  if (start < 0) return null;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##?\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

// A range ("1–3", "1 to 3") reads as its upper bound: a design that may grow
// past one worker is not a single-worker design.
const FLW_COUNT_LINE = /number of (?:flws|workers|frontline workers)\b[^0-9\n]*?(\d[\d,]*)(?:\s*(?:-|–|—|to)\s*(\d[\d,]*))?/i;

/** The PDD's declared worker count, or null when it states none. */
export function pddFlwCount(pdd: string): { count: number; line: string } | null {
  const section = pddSection(pdd, /^FLW Requirements\b/i) ?? pdd;
  for (const line of section.split('\n')) {
    const m = FLW_COUNT_LINE.exec(line);
    if (m) return { count: Number((m[2] ?? m[1]).replace(/,/g, '')), line: line.trim() };
  }
  return null;
}

/**
 * An explicit statement that the design has no partner organisation.
 * Matches "no partner organisation", "no implementing organization", "no
 * partner", "no LLO"; never "None pre-named" / "not yet selected".
 */
const NO_PARTNER = /\bno (?:partner|implementing|local|lead)?\s*(?:partner|organi[sz]ations?|orgs?|LLOs?)\b/i;

export function pddNoPartnerStatement(pdd: string): string | null {
  const section = pddSection(pdd, /^LLO Preference\b/i);
  if (section === null) return null;
  for (const line of section.split('\n')) {
    if (NO_PARTNER.test(line)) return line.trim();
  }
  return null;
}

export function phase7Applicability(pdd: string): Phase7Applicability {
  const reasons: Phase7SkipReason[] = [];
  const flw = pddFlwCount(pdd);
  if (flw && flw.count <= 1) reasons.push({ kind: 'single-worker', evidence: flw.line });
  const noPartner = pddNoPartnerStatement(pdd);
  if (noPartner) reasons.push({ kind: 'no-partner', evidence: noPartner });

  const flw_count = flw ? flw.count : null;
  if (!reasons.length) return { applicable: true, flw_count };

  const what = reasons
    .map((r) => (r.kind === 'single-worker' ? `a single worker (${flw_count})` : 'no partner organisation'))
    .join(' and ');
  return {
    applicable: false,
    skip_reason: PHASE7_SCALE_SKIP_REASON,
    reasons,
    flw_count,
    detail:
      `The design has ${what}, so a partner-and-worker cascade demo could only be built from invented ` +
      `partners, workers and weeks (ace#2806); Phase 7 is skipped by operator decision rather than run at a reduced floor.`,
  };
}
