/**
 * Do the recipes in a documented chain actually meet?
 *
 * Why this exists (dimagi-internal/ace#1191). `app-test-cases`'s canonical
 * two-leg Deliver snippet teaches this:
 *
 * ```yaml
 * runFlow deliver-form-walk.yaml   # leg A: registration
 * runFlow form-submit.yaml
 * runFlow deliver-form-walk.yaml   # leg B: payable followup
 * ```
 *
 * with nothing between the legs — but the recipes' OWN documented contracts do
 * not meet:
 *
 * ```
 * deliver-form-walk.yaml   Pre-state:  Deliver home (deliver-home-job-card /
 *                                      viewJobCard visible); first action taps "Start"
 * form-submit.yaml         Post-state: "depends on the form … Deliver forms (TBD)
 *                                      likely have an explicit confirmation surface"
 * ```
 *
 * `deliver-sync.yaml` documents the real answer in passing — *"form-submit
 * returns to the form list (or the module list) rather than the app home"* —
 * which is exactly why deliver-sync itself opens with two guarded `back` steps
 * before it can find the home tile.
 *
 * Live consequence (ace#1290, same run family): the Deliver smoke walked leg
 * A, then died at the inter-leg back-navigation on CommCare's "Exit Form?"
 * dialog, having taken a POST_SUBMIT screenshot and reported success.
 *
 * ## What this can and cannot decide
 *
 * The palette entry that FIXES the gap is a new recipe, and a recipe must be
 * proven on a live device before it merges — so it is not here. What is
 * decidable from the checked-in headers, and is the preventer the issue asks
 * for, is that **a documented chain must not contain a step whose post-state
 * cannot be shown to satisfy the next step's pre-state.**
 *
 * Three ways that fails, and the middle one is the live case: a step with no
 * documented contract at all, a step whose post-state is explicitly
 * undetermined ("depends on…", "TBD"), and two determined states that simply
 * do not share an anchor.
 */

export interface StateContract {
  pre?: string;
  post?: string;
  /** The post-state is documented but says it does not know. */
  postIsUndetermined: boolean;
}

const PRE = /^#\s*Pre-state:\s*(.+(?:\n#\s{2,}.+)*)/m;
const POST = /^#\s*Post-state:\s*(.+(?:\n#\s{2,}.+)*)/m;
const UNDETERMINED = /\b(TBD|depends on|unknown|likely|probably)\b/i;

/**
 * A pre-state that deliberately accepts ANY starting point. This is what a
 * guarded re-entry step is for, and it is the correct way to absorb an
 * upstream step whose post-state cannot be determined — so it must NOT be
 * reported as a discontinuity. Without this carve-out the check would flag
 * the very shape that fixes the problem, which is how a lint becomes the
 * always-fires class nobody reads.
 */
const PERMISSIVE_PRE = /\b(anywhere|any screen|any state|from anywhere|wherever)\b/i;

function clean(block: string | undefined): string | undefined {
  if (!block) return undefined;
  return block
    .split('\n')
    .map((l) => l.replace(/^#\s*/, '').trim())
    .join(' ')
    .trim();
}

export function parseStateContract(recipeText: string): StateContract {
  const pre = clean(PRE.exec(recipeText)?.[1]);
  const post = clean(POST.exec(recipeText)?.[1]);
  return { pre, post, postIsUndetermined: post !== undefined && UNDETERMINED.test(post) };
}

/**
 * Selector anchors named inside a state sentence.
 *
 * Anchors are the only part of these sentences that can be compared
 * mechanically: kebab-case selector ids (`deliver-home-job-card`),
 * snake_case CommCare ids (`nav_btn_next`), and camelCase view ids
 * (`viewJobCard`). Everything else is prose written for a human.
 */
export function anchorsIn(stateText: string | undefined): string[] {
  if (!stateText) return [];
  const out = new Set<string>();
  for (const m of stateText.matchAll(/\b[a-z][a-z0-9]*(?:[-_][a-z0-9]+){1,}\b/gi)) out.add(m[0]);
  for (const m of stateText.matchAll(/\b[a-z]+(?:[A-Z][a-z0-9]+){1,}\b/g)) out.add(m[0]);
  return [...out];
}

export type ChainFindingKind =
  | 'missing-contract'
  | 'undetermined-post-state'
  | 'state-discontinuity';

export interface ChainFinding {
  kind: ChainFindingKind;
  detail: string;
}

export interface ChainStep {
  recipe: string;
  text: string;
}

export interface ChainReport {
  ok: boolean;
  findings: ChainFinding[];
}

export function checkChainContinuity(steps: ChainStep[]): ChainReport {
  const findings: ChainFinding[] = [];
  const contracts = steps.map((s) => ({ ...s, contract: parseStateContract(s.text) }));

  for (let i = 0; i < contracts.length - 1; i++) {
    const cur = contracts[i];
    const next = contracts[i + 1];

    if (!cur.contract.post) {
      findings.push({
        kind: 'missing-contract',
        detail:
          `${cur.recipe} documents no Post-state, so nothing can show it leaves the device where ` +
          `${next.recipe} needs to start. Add a "# Post-state:" header line`,
      });
      continue;
    }
    if (!next.contract.pre) {
      findings.push({
        kind: 'missing-contract',
        detail:
          `${next.recipe} documents no Pre-state, so nothing can show ${cur.recipe} leaves the ` +
          'device where it needs to start. Add a "# Pre-state:" header line',
      });
      continue;
    }
    const nextAcceptsAnything = PERMISSIVE_PRE.test(next.contract.pre);
    if (cur.contract.postIsUndetermined && !nextAcceptsAnything) {
      findings.push({
        kind: 'undetermined-post-state',
        detail:
          `${cur.recipe}'s post-state is undetermined ("${cur.contract.post}"), so the chain cannot ` +
          `be shown to reach ${next.recipe}'s pre-state ("${next.contract.pre}"). Either determine ` +
          'it on a live device, or put an explicit re-entry step between them',
      });
      continue;
    }

    if (nextAcceptsAnything) continue;

    const postAnchors = anchorsIn(cur.contract.post);
    const preAnchors = anchorsIn(next.contract.pre);
    // No anchors on either side means the states are prose-only — not provably
    // discontinuous, so don't manufacture a finding.
    if (postAnchors.length === 0 || preAnchors.length === 0) continue;
    if (!postAnchors.some((a) => preAnchors.includes(a))) {
      findings.push({
        kind: 'state-discontinuity',
        detail:
          `${cur.recipe} leaves the device at [${postAnchors.join(', ')}] but ${next.recipe} starts ` +
          `from [${preAnchors.join(', ')}] — no shared anchor, so the chain does not connect`,
      });
    }
  }

  return { ok: findings.length === 0, findings };
}
