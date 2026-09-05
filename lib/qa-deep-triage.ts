//
// Route `/ace:qa-deep` findings to the party that owns the fix.
//
// The command wrote two verdict YAMLs and stopped. Everything after that —
// deciding whether a finding is a defect in the built product, in the bot's
// prompt, in ACE's own test recipes, or in the ground truth the rubric grades
// against — was left to whoever read the files. That is not a small residue:
// on `spark-facilitator/20260828-0703` the deep app verdict opened with
//
//     BLOCKER — The community case's durable state does not advance on a real
//     meeting. … This is the whole premise of the longitudinal-visits archetype.
//
// which was ACE's own recipe re-filing a preloaded date (ace#1982), not a
// product defect at all. TWO of that verdict's five BLOCKERs were ACE bugs
// wearing product clothing. Nothing in the pipeline could tell the difference,
// so the operator was handed fifteen findings across four owners and became the
// router — by conversation, over six rounds, with three wrong guesses on the way.
//
// The fix is to make ownership a FIRST-CLASS FIELD of a finding rather than
// something a reader infers:
//
//   HARNESS     ACE's recipe / selector / skill is wrong    -> self-heal PR
//   INSTRUMENT  the ground truth or test suite is wrong     -> self-heal PR
//   PRODUCT     the built app is wrong                      -> Phase 3 rework
//   PROMPT      the bot's system prompt is wrong            -> Phase 5 re-publish
//
// The first two are ACE's own code and CLAUDE.md § self-heal already says fix
// them without asking. Only the last two are the operator's, because only they
// turn on product taste and cost. So a correctly-routed run auto-ships the
// harness fixes and hands back TWO decisions instead of fifteen findings.
//
// ── The safety property that shapes the whole module ────────────────────────
//
// A finding is NEVER auto-routed to self-heal on a guess. An explicit marker
// (`[HARNESS]`, `[PRODUCT]`, …) is authoritative; a keyword heuristic is only
// ever advisory and lands in `needsTriage` for a human to confirm. The failure
// this avoids is precisely the inverse of the one that motivated the module: a
// real PRODUCT defect silently "self-healed" as a harness bug and closed. Given
// a 5-BLOCKER verdict where 2 were misattributed BY A CAREFUL READER, a keyword
// matcher must not be trusted to do better — it is a triage aid, not an oracle.
//

/** Who owns the fix for a finding. */
export type FindingOwner = 'HARNESS' | 'INSTRUMENT' | 'PRODUCT' | 'PROMPT';

/** Owners whose fixes land in the ACE repo and need no operator decision. */
export const SELF_HEALABLE_OWNERS: readonly FindingOwner[] = ['HARNESS', 'INSTRUMENT'];

/** Owners whose fixes change the opportunity and are the operator's call. */
export const OPERATOR_OWNERS: readonly FindingOwner[] = ['PRODUCT', 'PROMPT'];

export const OWNER_DESTINATION: Record<FindingOwner, string> = {
  HARNESS: 'self-heal PR (ACE repo)',
  INSTRUMENT: 'self-heal PR (ACE repo)',
  PRODUCT: 'Phase 3 rework (rebuild + re-release + re-run qa-deep)',
  PROMPT: 'Phase 5 re-publish (ocs-agent-setup + re-run qa-deep --ocs-only)',
};

export type Severity = 'BLOCKER' | 'WARN' | 'INFO';

export interface RawFinding {
  /** The `auto_surfaced` message, or a per-item note. */
  message: string;
  severity: Severity;
  /** Which verdict it came from, e.g. `app-ux-eval` / `ocs-chatbot-eval`. */
  source: string;
  /** Entry/journey ref when the finding is attached to one. */
  ref?: string;
  /** Set by the producing skill. Authoritative when present. */
  owner?: FindingOwner;
}

export interface RoutedFinding extends RawFinding {
  owner: FindingOwner;
  destination: string;
  /** How ownership was decided. Only `explicit` may be acted on unattended. */
  basis: 'explicit';
}

export interface TriagedFinding extends RawFinding {
  /** Best guess, or undefined when no signal at all. */
  suggestedOwner?: FindingOwner;
  /** Why the guess — the matched cues, for a human to sanity-check. */
  cues: string[];
}

export interface TriageResult {
  /** Explicitly-owned, safe to route unattended. */
  routed: RoutedFinding[];
  /** Heuristic or unknown — a human confirms before anything is done. */
  needsTriage: TriagedFinding[];
}

/** `[HARNESS]`, `[PRODUCT] …` — the marker a producing skill emits. */
const MARKER_RE = /\[(HARNESS|INSTRUMENT|PRODUCT|PROMPT)\]/i;

/**
 * Advisory cues only. Deliberately NOT tuned to be clever: a cue that fires is
 * a prompt to look, never a decision. See the safety note in the header.
 */
const CUES: Record<FindingOwner, RegExp[]> = {
  HARNESS: [
    /\brecipe\b/i,
    /\bassert(ion|Visible|Not)?\b/i,
    /\bselector\b/i,
    /\bmanifest\b/i,
    /\bapp-test-cases\b/i,
    /\bwatchdog\b/i,
    /\bthe instrument\b/i,
    /\bcapture[_ ]robustness\b/i,
  ],
  INSTRUMENT: [
    /\bexpected_tags\b/i,
    /\bexpected_answer_summary\b/i,
    /\bground truth\b/i,
    /\bpdd-to-test-prompts\b/i,
    /\bpdd-to-app-journeys\b/i,
    /\banswer key\b/i,
  ],
  PRODUCT: [
    /\bpreload/i,
    /\bcase (state|detail|list)\b/i,
    /\breviewable\b/i,
    /\bthe (app|form|widget)\b/i,
    /\bon-screen\b/i,
    /\bafter submit\b/i,
  ],
  PROMPT: [
    /\bsystem prompt\b/i,
    /\bthe bot\b/i,
    /\bfabricat/i,
    /\bescalation address\b/i,
    /\brefus(e|al)\b/i,
    /\bplaceholder\b/i,
  ],
};

/** Read an explicit owner marker. Returns undefined when absent. */
export function explicitOwner(message: string): FindingOwner | undefined {
  const m = MARKER_RE.exec(message);
  return m ? (m[1].toUpperCase() as FindingOwner) : undefined;
}

/** Advisory guess + the cues behind it. Never authoritative. */
export function suggestOwner(message: string): { owner?: FindingOwner; cues: string[] } {
  const hits: { owner: FindingOwner; cues: string[] }[] = [];
  for (const owner of Object.keys(CUES) as FindingOwner[]) {
    const cues = CUES[owner].filter((re) => re.test(message)).map((re) => re.source);
    if (cues.length > 0) hits.push({ owner, cues });
  }
  if (hits.length === 0) return { cues: [] };
  hits.sort((a, b) => b.cues.length - a.cues.length);
  // A tie is genuinely ambiguous — report the cues, withhold the guess.
  if (hits.length > 1 && hits[0].cues.length === hits[1].cues.length) {
    return { cues: hits.flatMap((h) => h.cues) };
  }
  return { owner: hits[0].owner, cues: hits[0].cues };
}

/**
 * Split findings into what may be acted on unattended and what a human must
 * confirm. `finding.owner` (set by the producing skill) wins over any marker in
 * the text; a marker wins over the heuristic; the heuristic never routes.
 */
export function triageFindings(findings: readonly RawFinding[]): TriageResult {
  const routed: RoutedFinding[] = [];
  const needsTriage: TriagedFinding[] = [];

  for (const f of findings) {
    const owner = f.owner ?? explicitOwner(f.message);
    if (owner) {
      routed.push({ ...f, owner, destination: OWNER_DESTINATION[owner], basis: 'explicit' });
    } else {
      const { owner: suggestedOwner, cues } = suggestOwner(f.message);
      needsTriage.push({ ...f, suggestedOwner, cues });
    }
  }

  return { routed, needsTriage };
}

export interface OperatorDecision {
  owner: FindingOwner;
  destination: string;
  findings: RoutedFinding[];
  blockerCount: number;
}

export interface DecisionSet {
  /** Auto-shippable: HARNESS + INSTRUMENT, explicit only. */
  selfHeal: RoutedFinding[];
  /** One decision per operator-owned area, most severe first. */
  decisions: OperatorDecision[];
  needsTriage: TriagedFinding[];
}

/** Group a triage into the self-heal batch and the operator's decisions. */
export function buildDecisionSet(triage: TriageResult): DecisionSet {
  const selfHeal = triage.routed.filter((f) => SELF_HEALABLE_OWNERS.includes(f.owner));

  const decisions: OperatorDecision[] = [];
  for (const owner of OPERATOR_OWNERS) {
    const findings = triage.routed.filter((f) => f.owner === owner);
    if (findings.length === 0) continue;
    decisions.push({
      owner,
      destination: OWNER_DESTINATION[owner],
      findings,
      blockerCount: findings.filter((f) => f.severity === 'BLOCKER').length,
    });
  }
  decisions.sort((a, b) => b.blockerCount - a.blockerCount);

  return { selfHeal, decisions, needsTriage: triage.needsTriage };
}

function line(f: RawFinding): string {
  const ref = f.ref ? ` (${f.ref})` : '';
  const msg = f.message.replace(MARKER_RE, '').replace(/\s+/g, ' ').trim();
  return `  - [${f.severity}]${ref} ${msg}`;
}

/**
 * The whole point of the module: what the operator actually reads. A decision
 * per area, not a finding list.
 */
export function formatDecisionBrief(
  set: DecisionSet,
  gate: { appVerdict?: string; appScore?: number; ocsVerdict?: string; ocsScore?: number },
): string {
  const out: string[] = ['# Deep QA — decisions', ''];

  const bits: string[] = [];
  if (gate.appVerdict) bits.push(`app ${gate.appScore ?? '?'} (${gate.appVerdict})`);
  if (gate.ocsVerdict) bits.push(`bot ${gate.ocsScore ?? '?'} (${gate.ocsVerdict})`);
  if (bits.length) out.push(`**Gate:** ${bits.join(', ')}`, '');

  if (set.selfHeal.length > 0) {
    out.push(
      `## Self-healed — no decision needed (${set.selfHeal.length})`,
      '',
      'ACE own-code defects. Shipped as PRs; listed so the fixes are auditable,',
      'not so you have to act on them.',
      '',
      ...set.selfHeal.map(line),
      '',
    );
  }

  if (set.decisions.length === 0) {
    out.push('## Your decisions', '', 'None — nothing operator-owned surfaced.', '');
  } else {
    out.push(`## Your decisions (${set.decisions.length})`, '');
    set.decisions.forEach((d, i) => {
      out.push(
        `### ${i + 1}. ${d.owner} — ${d.findings.length} finding(s), ${d.blockerCount} blocker(s)`,
        '',
        `Fix path: ${d.destination}`,
        '',
        ...d.findings.map(line),
        '',
        `**Rework, or accept and record the residual?**`,
        '',
      );
    });
  }

  if (set.needsTriage.length > 0) {
    out.push(
      `## Unclassified (${set.needsTriage.length}) — confirm owner before anything is done`,
      '',
      'No explicit owner marker. A guess is shown where cues fired; it is NOT',
      'acted on. Two of five blockers on 20260828-0703 were misattributed by a',
      'careful human reader, so a keyword match does not get to decide.',
      '',
      ...set.needsTriage.map((f) => {
        const guess = f.suggestedOwner ? ` — guess: ${f.suggestedOwner}` : ' — no signal';
        return `${line(f)}${guess}`;
      }),
      '',
    );
  }

  return out.join('\n');
}
