/**
 * Horizontal reconciliation — do a run's artifacts agree WITH EACH OTHER?
 *
 * ## The failure class
 *
 * Every `-qa` and `-eval` skill in this repo judges one artifact against the
 * PDD. That is a vertical check, and a document can pass it while contradicting
 * the document next to it. `opp-eval` does not close the gap: it aggregates
 * verdicts, not content.
 *
 * `tekzal/20261013-2314` is what that costs. The partner's Round 1 review found
 * the work order and all four training documents disagreeing on who pays the
 * field worker, and rated the round 2/4 with "No, not as things stand." Their
 * own recommendation:
 *
 *   "Check the generated outputs against each other before release… One
 *    comparison pass would have caught every one."
 *
 * Every check here therefore takes MORE THAN ONE artifact. A check that reads a
 * single document belongs in that document's `-qa` skill, not in this file.
 *
 * ## Precision
 *
 * These run on a contract and on worker-facing training, both of which are full
 * of legitimate prose that resembles a violation. Each check below is narrow on
 * purpose and says what it deliberately does not catch. A broad rule here is
 * worse than no rule: it becomes the always-fires check that gets routed around
 * inside one run, which is the documented fate of `no_renderer_instructions`'
 * rejected broad form.
 *
 * Contract: `skills/_program-facts.md`.
 */

import type { QACheckResult } from '../../lib/qa-types';

/**
 * One generated artifact, as plain text.
 *
 * `label` is what a failure message names, so it must be the thing the operator
 * would open — "work order", "manager guide", "quick reference card".
 */
export interface Artifact {
  label: string;
  text: string;
}

/** Facts settled in the PDD that artifacts must not restate differently. */
export interface SettledFacts {
  /** Maximum number of FLWs. */
  workerCap?: number;
  /** Maximum deliveries per worker for the whole engagement. */
  perWorkerCap?: number;
  /** Campaign total across all workers. */
  campaignTotal?: number;
  /** How many conditions the payment test has. Round 1: contract 5, training 4. */
  paymentConditionCount?: number;
}

function norm(s: string): string {
  // Collapse whitespace so a phrase split across a line break in a Doc export
  // still matches. Keeps case — several checks are case-sensitive on purpose.
  return s.replace(/\s+/g, ' ');
}

function pass(detail?: string): QACheckResult {
  return detail ? { pass: true, detail } : { pass: true };
}

// ── 1. Who pays the field worker ───────────────────────────────────

/**
 * Dimagi pays the partner; the partner pays the FLW. No artifact may say
 * otherwise.
 *
 * This is the Round 1 fixture. The work order carried "FLW payments are
 * disbursed through Connect directly to the FLW" while all four training
 * documents said the partner pays — and the partner, reasonably, believed the
 * contract. Tekzal called it "the most consequential disagreement in the round"
 * because it decides who funds the float.
 *
 * Deliberately NOT caught: prose that merely mentions Connect and payment in
 * one sentence. Connect legitimately RECORDS payments the partner makes, so
 * "record the payment in Connect" must keep passing. Only a claim that money
 * reaches the worker from Dimagi, or through Connect as the payer, fails.
 */
export function checkNoDirectFlwPayment(artifacts: Artifact[]): QACheckResult {
  const offenders: string[] = [];
  // "disbursed/paid ... directly to the FLW/worker" — the Round 1 wording and
  // its near neighbours.
  const DIRECT = /\b(disbursed|paid|transferred|remitted)\b[^.]{0,80}?\bdirect(ly)?\b[^.]{0,40}?\b(to the )?(FLW|field worker|worker)s?\b/i;
  // "Dimagi pays the FLW" with no partner in between.
  const DIMAGI_PAYS_WORKER = /\bDimagi\b[^.]{0,40}?\b(pays|will pay|disburses|disburse)\b[^.]{0,40}?\b(the )?(FLW|field worker|worker)s?\b/i;

  for (const a of artifacts) {
    const t = norm(a.text);
    const hit = t.match(DIRECT) ?? t.match(DIMAGI_PAYS_WORKER);
    if (hit) offenders.push(`${a.label}: "${hit[0].trim()}"`);
  }

  if (offenders.length === 0) return pass();
  return {
    pass: false,
    detail:
      `${offenders.length} artifact(s) say money reaches the field worker from Dimagi or through ` +
      `Connect: ${offenders.join(' | ')}`,
    auto_fix_hint:
      'Payment flows Dimagi → partner organization → FLW, with no exception. Rewrite to ' +
      '"Dimagi pays {partner}. {partner} pays each Frontline Worker and records the payment in ' +
      'Connect." Connect does not move money. See skills/_program-facts.md § Payment flows.',
  };
}

// ── 2. The payment test has the same number of conditions everywhere ──

/**
 * Same count, not just same content.
 *
 * Round 1's training closed the payment test at four conditions where the
 * contract set five, the missing one being submission within the per-FLW
 * limits. A worker taught four has been taught that the fifth does not affect
 * her pay — and only the FAQ mentioned over-limit surveys being unpaid, to the
 * coordinator rather than to her.
 *
 * Counts an artifact only if it actually enumerates the test. An artifact that
 * never discusses payment conditions is not evidence of disagreement, so it is
 * skipped rather than counted as zero.
 */
export function checkPaymentConditionCountAgrees(
  artifacts: Artifact[],
  facts: SettledFacts,
): QACheckResult {
  const counts: { label: string; count: number }[] = [];

  const WORD: Record<string, number> = {
    two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };

  for (const a of artifacts) {
    const t = norm(a.text);
    const lead = t.match(
      /\b(a survey is paid|paid when|payment conditions|payable (?:under|when|if)|qualifies for payment|makes a survey payable)\b/i,
    );
    if (!lead) continue;
    const from = lead.index ?? 0;
    const window = t.slice(from, from + 1200);

    // PREFERRED: the document states the count in words. This is how the real
    // Round 1 artifacts expressed it — the manager guide said "all four, and
    // nothing else" and the FAQ said "one of the four conditions failed", while
    // the contract enumerated five as bullets. Counting list markers found
    // neither, because neither is a list. Grounding the check on the captured
    // artifacts is what surfaced that; the bullet count alone reported "fewer
    // than two artifacts enumerate the payment test" and passed the defect.
    const worded =
      window.match(/\ball (two|three|four|five|six|seven|eight|nine|ten)\b/i) ??
      window.match(/\bthe (two|three|four|five|six|seven|eight|nine|ten) conditions\b/i);
    if (worded) {
      counts.push({ label: a.label, count: WORD[worded[1].toLowerCase()] });
      continue;
    }

    // FALLBACK: an enumerated list.
    const numbered = window.match(/(?:^|\s)\d\.\s/g)?.length ?? 0;
    const bulleted = window.match(/(?:^|\s)[•\-*]\s/g)?.length ?? 0;
    const count = Math.max(numbered, bulleted);
    if (count > 0) counts.push({ label: a.label, count });
  }

  if (counts.length < 2) return pass('fewer than two artifacts enumerate the payment test');

  const distinct = new Set(counts.map((c) => c.count));
  const expected = facts.paymentConditionCount;

  if (distinct.size === 1 && (expected === undefined || [...distinct][0] === expected)) {
    return pass(`all ${counts.length} artifacts state ${[...distinct][0]} conditions`);
  }

  return {
    pass: false,
    detail:
      `the payment test is stated with different numbers of conditions: ` +
      counts.map((c) => `${c.label} = ${c.count}`).join(', ') +
      (expected !== undefined ? ` (PDD settles it at ${expected})` : ''),
    auto_fix_hint:
      `State the SAME payment conditions, in the same number, in the contract and in every ` +
      `worker-facing document` +
      (expected !== undefined ? ` — the settled count is ${expected}` : '') +
      `. If a condition is a cap, say in the worker-facing documents that work beyond the cap is ` +
      `recorded but unpaid. See skills/_program-facts.md § Per-run facts.`,
  };
}

// ── 3. The caps multiply out, and reach the person onboarding workers ──

/**
 * Worker cap × per-worker cap must cover the campaign total, and the worker cap
 * has to appear where a coordinator will read it.
 *
 * Round 1: no training document mentioned the five-worker cap the 100-survey
 * arithmetic depended on. "A coordinator who onboards ten workers has promised
 * 200 surveys against a 100 survey ceiling."
 */
export function checkCapsReachTheCoordinator(
  artifacts: Artifact[],
  facts: SettledFacts,
): QACheckResult {
  const { workerCap, perWorkerCap, campaignTotal } = facts;
  if (workerCap === undefined || perWorkerCap === undefined || campaignTotal === undefined) {
    return pass('caps not all settled in the PDD; nothing to reconcile');
  }

  const failures: string[] = [];

  if (workerCap * perWorkerCap < campaignTotal) {
    failures.push(
      `${workerCap} workers × ${perWorkerCap} each = ${workerCap * perWorkerCap}, ` +
        `below the campaign total of ${campaignTotal}`,
    );
  }

  // The guide a coordinator actually runs the program from must carry the
  // worker cap. Matched as a bare number near a worker noun rather than an
  // exact sentence, because the guide phrases it freely.
  const guide = artifacts.find((a) => /manager guide|llo guide|operations guide/i.test(a.label));
  if (guide) {
    const capRe = new RegExp(
      `\\b(${workerCap}|${numberWord(workerCap)})\\b[^.]{0,40}?\\b(FLWs?|field workers?|workers?)\\b`,
      'i',
    );
    if (!capRe.test(norm(guide.text))) {
      failures.push(`the ${workerCap}-worker cap does not appear in ${guide.label}`);
    }
  }

  if (failures.length === 0) return pass();
  return {
    pass: false,
    detail: failures.join('; '),
    auto_fix_hint:
      `Put the worker cap in the manager guide next to the campaign total, and make the ` +
      `arithmetic close: worker cap × per-worker cap must be at least the campaign total. ` +
      `See skills/_program-facts.md § The caps must multiply out.`,
  };
}

function numberWord(n: number): string {
  const words = [
    'zero', 'one', 'two', 'three', 'four', 'five',
    'six', 'seven', 'eight', 'nine', 'ten',
  ];
  return words[n] ?? String(n);
}

// ── 4. Consent precedes every question ─────────────────────────────

/**
 * In any numbered step list, the consent step comes before any step that asks
 * the seller something or photographs anything.
 *
 * Round 1's quick reference card — the document physically carried to the stall
 * — asked what she sells at step 2 and read consent at step 4, while the same
 * card listed under Never: "Photograph or ask before she says yes."
 */
export function checkConsentPrecedesQuestions(artifacts: Artifact[]): QACheckResult {
  const offenders: string[] = [];

  for (const a of artifacts) {
    const t = norm(a.text);
    const steps = [...t.matchAll(/(?:^|\s)(\d)\.\s([^0-9]{3,120}?)(?=\s\d\.\s|$)/g)];
    if (steps.length < 3) continue;

    let consentStep: number | null = null;
    let askStep: number | null = null;
    for (const s of steps) {
      const n = Number(s[1]);
      const body = s[2];
      if (consentStep === null && /\bconsent\b|\bsays yes\b|\bpermission to (ask|continue)\b/i.test(body)) {
        consentStep = n;
      }
      if (askStep === null && /\bask (her|what|whether)\b|\bphotograph\b|\btake (a |the )?pictures?\b/i.test(body)) {
        askStep = n;
      }
    }

    if (consentStep !== null && askStep !== null && askStep < consentStep) {
      offenders.push(`${a.label}: asks at step ${askStep}, consents at step ${consentStep}`);
    }
  }

  if (offenders.length === 0) return pass();
  return {
    pass: false,
    detail: `consent is not the first step: ${offenders.join(' | ')}`,
    auto_fix_hint:
      'Reorder so consent precedes every question and every photograph. This binds hardest on ' +
      'the quick reference card, which is the document carried to the stall. ' +
      'See skills/_program-facts.md § Consent comes before any question.',
  };
}

// ── 5. A contingent phase is not "a separate engagement" ───────────

/**
 * When a later phase sits inside the same contract, in the same period and
 * against the same cap, calling it "a separate engagement" tells the partner
 * they have not yet agreed to it.
 *
 * Three of five Round 1 documents did.
 */
export function checkContingentPhaseNotCalledSeparate(artifacts: Artifact[]): QACheckResult {
  const SEPARATE = /\bseparate engagement\b/i;
  const offenders = artifacts
    .filter((a) => SEPARATE.test(norm(a.text)))
    .map((a) => a.label);

  if (offenders.length === 0) return pass();
  return {
    pass: false,
    detail: `"separate engagement" appears in: ${offenders.join(', ')}`,
    auto_fix_hint:
      'A later phase inside the same work order, same period and same cap is CONTINGENT Phase B, ' +
      'not a separate engagement. Reserve "separate" for work needing its own work order. ' +
      'See skills/_program-facts.md § A contingent later phase.',
  };
}

// ── 6. No device or camera guidance in partner-facing artifacts ────

/**
 * Operator decision, 2026-11-25: artifacts shared with a partner must not
 * proactively recommend anything about devices, and there is no camera
 * standard. The single capture control is live-photo-only, enforced in the app
 * build rather than asserted in prose.
 *
 * Deliberately NOT caught: describing what the app does ("the app opens the
 * camera"), or telling a worker to hold the phone steady. The rule is against
 * RECOMMENDING equipment or capture settings, not against mentioning a phone.
 */
export function checkNoDeviceOrCameraGuidance(artifacts: Artifact[]): QACheckResult {
  const PATTERNS: [RegExp, string][] = [
    [/\b(minimum|recommended|required)\s+(handset|device|phone|camera)\b/i, 'device specification'],
    [/\bstandard\s+handset\b/i, 'handset standardization'],
    [/\b(turn|switch)\s+(off|on)\s+(HDR|filters?|scene modes?|auto[- ]?enhanc\w*)\b/i, 'camera setting'],
    [/\bHDR\b/i, 'camera setting'],
    [/\bmegapixels?\b/i, 'camera specification'],
  ];
  const offenders: string[] = [];
  for (const a of artifacts) {
    const t = norm(a.text);
    for (const [re, kind] of PATTERNS) {
      const m = t.match(re);
      if (m) offenders.push(`${a.label}: ${kind} — "${m[0].trim()}"`);
    }
  }
  if (offenders.length === 0) return pass();
  return {
    pass: false,
    detail: offenders.join(' | '),
    auto_fix_hint:
      'Remove device and camera guidance from partner-facing artifacts. The only capture control ' +
      'is live photo only, no gallery upload, and it is enforced in the app build. ' +
      'See skills/_program-facts.md § No device or camera guidance.',
  };
}

// ── 7. Approvals stay generic ──────────────────────────────────────

/**
 * Never name a specific permission, authority, fee or lead time for an
 * approval. The partner holds the local context and owns the process.
 *
 * Round 1 required a permission for workers to carry a reference object that no
 * authority in the country issues, and required market permission with no
 * schedule time, no budget line and no stated consequence — while the partner
 * knew it was two permissions, days to weeks, and usually a fee.
 *
 * Deliberately NOT caught: the sanctioned generic line, which contains
 * "approvals" and "authorities" and must keep passing.
 */
export function checkApprovalsStayGeneric(artifacts: Artifact[]): QACheckResult {
  const NAMED = [
    /\bmarket queen\b/i,
    /\bmetropolitan assembly\b/i,
    /\bmunicipal assembly\b/i,
    /\bpermission (?:to|for) (?:FLWs?|field workers?|workers?) to (?:carry|display)\b/i,
    /\bmarket permission\b/i,
  ];
  const offenders: string[] = [];
  for (const a of artifacts) {
    const t = norm(a.text);
    for (const re of NAMED) {
      const m = t.match(re);
      if (m) offenders.push(`${a.label}: "${m[0].trim()}"`);
    }
  }
  if (offenders.length === 0) return pass();
  return {
    pass: false,
    detail: `named approvals found: ${offenders.join(' | ')}`,
    auto_fix_hint:
      'Replace every named permission, authority, fee or lead time with the one generic line: ' +
      '"Take all required approvals from respective authorities for smooth deployment." ' +
      'The partner owns the approval process. See skills/_program-facts.md § Approvals are generic.',
  };
}

// ── 8. One name per captured field ─────────────────────────────────

/**
 * A field called one thing in training and another in the guide and the
 * contract is two fields to the person reading.
 *
 * Round 1: `stock` in worker-facing training, `availability` in the manager
 * guide checklist and the work order — with the answer options published
 * nowhere, so there was nothing to check either name against.
 *
 * Takes the alias pairs to watch as an argument rather than hard-coding them,
 * because the fields are per-program. The caller passes what the PDD settled.
 */
export function checkOneNamePerField(
  artifacts: Artifact[],
  aliasGroups: string[][],
): QACheckResult {
  const failures: string[] = [];

  for (const group of aliasGroups) {
    const seen = new Map<string, string[]>(); // alias -> artifact labels
    for (const a of artifacts) {
      const t = norm(a.text);
      for (const alias of group) {
        const re = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (re.test(t)) {
          if (!seen.has(alias)) seen.set(alias, []);
          seen.get(alias)!.push(a.label);
        }
      }
    }
    if (seen.size > 1) {
      failures.push(
        [...seen.entries()].map(([alias, labels]) => `"${alias}" in ${labels.join('/')}`).join(' vs '),
      );
    }
  }

  if (failures.length === 0) return pass();
  return {
    pass: false,
    detail: `the same field is called different things: ${failures.join('; ')}`,
    auto_fix_hint:
      'Settle ONE name per captured field in the PDD and use it in the app, the contract, the ' +
      'manager guide and the training. Publish its answer options somewhere a worker can be ' +
      'taught them. See skills/_program-facts.md § One name per field.',
  };
}

// ── 9. One support route and one reply-time claim ──────────────────

/**
 * Round 1's manager guide and FAQ committed Dimagi to a reply "within one
 * working day", which the work order did not carry, and routed escalations to a
 * different email domain than the contract and the platform links used. The
 * partner's note: if the domain is wrong, false-record reporting and worker
 * suspension have no route at all.
 */
export function checkSupportRouteAgrees(artifacts: Artifact[]): QACheckResult {
  const domains = new Map<string, string[]>();
  const slaClaims = new Map<string, string[]>();

  for (const a of artifacts) {
    const t = norm(a.text);
    for (const m of t.matchAll(/[\w.+-]+@([\w-]+\.[\w.-]+)/g)) {
      const d = m[1].toLowerCase().replace(/[.,;)]+$/, '');
      if (!domains.has(d)) domains.set(d, []);
      if (!domains.get(d)!.includes(a.label)) domains.get(d)!.push(a.label);
    }
    const sla = t.match(/\bwithin (one|1|two|2|three|3) working days?\b/i);
    if (sla) {
      const k = sla[0].toLowerCase();
      if (!slaClaims.has(k)) slaClaims.set(k, []);
      if (!slaClaims.get(k)!.includes(a.label)) slaClaims.get(k)!.push(a.label);
    }
  }

  const failures: string[] = [];
  if (domains.size > 1) {
    failures.push(
      'escalation addresses use more than one domain: ' +
        [...domains.entries()].map(([d, l]) => `${d} (${l.join('/')})`).join(' vs '),
    );
  }
  if (slaClaims.size > 1) {
    failures.push(
      'more than one reply-time commitment: ' +
        [...slaClaims.entries()].map(([s, l]) => `"${s}" (${l.join('/')})`).join(' vs '),
    );
  }

  if (failures.length === 0) return pass();
  return {
    pass: false,
    detail: failures.join('; '),
    auto_fix_hint:
      'Use one support address and one reply-time commitment across the contract, the manager ' +
      'guide and the FAQ — and make sure the contract carries the commitment the guides promise. ' +
      'See skills/_program-facts.md § Per-run facts.',
  };
}

// ── 10. A taught floor is taught with its target ───────────────────

/**
 * If the training teaches a minimum, it must also teach the target.
 *
 * Round 1: the contract suggested a median visit of six to fifteen minutes and
 * warned about a median sitting against the five-minute floor. No training
 * document carried the target, and the deck's practice exercise tested for five
 * minutes — the floor. Training a worker to the floor is training her to the
 * thing the contract treats as a red flag.
 */
export function checkFloorTaughtWithTarget(artifacts: Artifact[]): QACheckResult {
  const FLOOR = /\b(at least|minimum of|no less than)\s+(\w+)\s+minutes?\b/i;
  const TARGET = /\b(\w+)\s+to\s+(\w+)\s+minutes?\b/i;

  const offenders: string[] = [];
  for (const a of artifacts) {
    if (!/deck|guide|training|faq|quick reference/i.test(a.label)) continue;
    const t = norm(a.text);
    if (FLOOR.test(t) && !TARGET.test(t)) offenders.push(a.label);
  }

  if (offenders.length === 0) return pass();
  return {
    pass: false,
    detail: `teaches the minimum visit length without the target range: ${offenders.join(', ')}`,
    auto_fix_hint:
      'Teach the target visit duration alongside the floor, and set practice exercises against ' +
      'the target. A worker trained to the floor is trained to the number the contract flags. ' +
      'See skills/_program-facts.md § Per-run facts.',
  };
}

/**
 * The runnable check set.
 *
 * This exists because a checks module nothing calls is not a check — it is a
 * library that happens to be tested. `RECONCILE_CHECKS` used to be a bare list
 * of names, which meant § Process step 3 ("run every check") had nothing to
 * run and the skill would have been executed by an agent re-deriving the calls
 * from prose. Same class as ace#1877, where a helper shipped with a skill line
 * saying "call it" and nothing ever did.
 */
export interface ReconcileCheck {
  id: string;
  run: (artifacts: Artifact[], facts: SettledFacts, aliasGroups: string[][]) => QACheckResult;
}

export const CHECKS: ReconcileCheck[] = [
  { id: 'no_direct_flw_payment', run: (a) => checkNoDirectFlwPayment(a) },
  { id: 'payment_condition_count_agrees', run: (a, f) => checkPaymentConditionCountAgrees(a, f) },
  { id: 'caps_reach_the_coordinator', run: (a, f) => checkCapsReachTheCoordinator(a, f) },
  { id: 'consent_precedes_questions', run: (a) => checkConsentPrecedesQuestions(a) },
  { id: 'contingent_phase_not_called_separate', run: (a) => checkContingentPhaseNotCalledSeparate(a) },
  { id: 'no_device_or_camera_guidance', run: (a) => checkNoDeviceOrCameraGuidance(a) },
  { id: 'approvals_stay_generic', run: (a) => checkApprovalsStayGeneric(a) },
  { id: 'one_name_per_field', run: (a, _f, g) => checkOneNamePerField(a, g) },
  { id: 'support_route_agrees', run: (a) => checkSupportRouteAgrees(a) },
  { id: 'floor_taught_with_target', run: (a) => checkFloorTaughtWithTarget(a) },
];

/** Check ids, for the skill body and the registry tests to iterate. */
export const RECONCILE_CHECKS = CHECKS.map((c) => c.id);

/**
 * Run the whole set. This is what § Process step 3 calls.
 *
 * Fewer than two artifacts is `incomplete`, not `fail`: reconciliation is a
 * relation between documents, and one document cannot disagree with itself.
 * That distinction matters because `fail` sends the orchestrator into an
 * auto-fix loop over an artifact that is not wrong.
 */
export function runReconciliation(
  artifacts: Artifact[],
  facts: SettledFacts = {},
  aliasGroups: string[][] = [],
): { verdict: 'pass' | 'fail' | 'incomplete'; failures: { check: string; detail: string; auto_fix_hint: string }[] } {
  if (artifacts.length < 2) return { verdict: 'incomplete', failures: [] };

  const failures: { check: string; detail: string; auto_fix_hint: string }[] = [];
  for (const check of CHECKS) {
    const r = check.run(artifacts, facts, aliasGroups);
    if (!r.pass) {
      failures.push({
        check: check.id,
        detail: r.detail ?? '',
        auto_fix_hint: r.auto_fix_hint ?? '',
      });
    }
  }
  return { verdict: failures.length === 0 ? 'pass' : 'fail', failures };
}
