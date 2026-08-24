/**
 * The Nova binding fence must assert the PRINCIPAL, and Step 0 must be
 * session-scoped (dimagi-internal/ace#1604).
 *
 * Every other MCP in the Step 2a fence fails CLOSED: an unbound server's atoms
 * do not resolve, so the fence sees a missing name and halts. Nova fails OPEN.
 * It is a remote `type: "http"` MCP whose `headersHelper` degrades to `{}` when
 * it cannot supply a bearer:
 *
 *   if [ -n "$NOVA_API_KEY" ]; then printf '{"Authorization":"Bearer %s"}' ... else printf '{}'; fi
 *
 * The connection then comes up as a DIFFERENT principal. Its atoms resolve
 * perfectly — they just answer for the wrong account. Resolvability, the only
 * thing Step 2a used to check, is blind to this by construction.
 *
 * Observed on spark-facilitator/20260820-0817, resuming mid-Phase-3:
 *   get_lookup_tables(<live app>) -> {"error_type":"not_found"}
 *   get_hq_connection()           -> {"error_type":"scope_missing", nova.hq.read}
 * while a direct POST to the same endpoint, with the key from ~/.ace/env.sh,
 * returned the run's own apps. Nothing on disk was wrong.
 *
 * Two rules came out of it, and this test is the ratchet on both:
 *
 *  1. The L0 fence asserts the principal (not just that Nova's atoms resolve)
 *     whenever commcare-setup is `pending` OR `in_progress`.
 *  2. `commcare-setup` Step 0 is SESSION-scoped and re-runs on resume, because
 *     a `done` marker written by a prior session says nothing about this one.
 *     Caching it inverts the gate — the fresh-session-wrong-principal case is
 *     exactly the case in which it gets skipped.
 *
 * SCOPE: offline and deterministic. This asserts the RULES are still stated in
 * the procedure docs the orchestrator executes. It does not call Nova.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORCHESTRATOR = path.join(REPO_ROOT, 'agents/ace-orchestrator.md');
const COMMCARE_SETUP = path.join(REPO_ROOT, 'agents/commcare-setup.md');

const read = (p: string) => fs.readFileSync(p, 'utf8');

describe('Nova principal fence (ace#1604)', () => {
  it('the L0 binding fence distinguishes resolvable from correct-principal', () => {
    const text = read(ORCHESTRATOR);

    // The fence must say, in some form, that resolving is insufficient for Nova.
    expect(
      /resolvable is not enough for nova/i.test(text),
      'agents/ace-orchestrator.md § Pre-flight Step 2a lost the rule that Nova ' +
        'fails OPEN (atoms resolve under the wrong principal). Without it the ' +
        'fence is back to a resolvability check that ace#1604 walked straight ' +
        'through.',
    ).toBe(true);

    // It must name the actual assertion, not just describe the hazard.
    expect(
      text.includes('list_apps') && /get_hq_connection/.test(text),
      'the fence must name BOTH probes: list_apps (resume — assert the run\'s ' +
        'nova_app_ids are visible) and get_hq_connection (fresh run — no app ' +
        'ids to check yet).',
    ).toBe(true);

    // in_progress is the case that actually bit: a resume mid-Phase-3.
    expect(
      /in_progress/.test(text.slice(text.indexOf('Resolvable is not enough'))),
      'the Nova principal check must fire when commcare-setup is `in_progress`, ' +
        'not only `pending` — ace#1604 was a mid-phase resume, where the phase ' +
        'is in_progress and never pending.',
    ).toBe(true);
  });

  it('the halt tells the next session the on-disk credential is probably fine', () => {
    const text = read(ORCHESTRATOR);
    // The halt is a markdown blockquote, so its sentences wrap across `>` lines.
    // Flatten before matching — otherwise this asserts line-wrapping, not content.
    const block = text
      .slice(text.indexOf('Resolvable is not enough'))
      .replace(/\n>?\s*/g, ' ');

    expect(
      /in-session binding fault, not a config defect/i.test(block),
      'the ace#1604 halt must state that this is a BINDING fault rather than a ' +
        'config defect. The session that hit it spent its opening turns proving ' +
        'a correct key was correct; the halt text is what stops the next one ' +
        'from repeating that.',
    ).toBe(true);

    expect(
      /quit and reopen claude code/i.test(block),
      'MCP auth binds at connection time, so the remediation is a full restart. ' +
        'A halt that omits it invites an in-session retry that cannot work.',
    ).toBe(true);
  });

  it('commcare-setup Step 0 is session-scoped and re-runs on resume', () => {
    const text = read(COMMCARE_SETUP).replace(/\s+/g, ' ');

    expect(
      /session-scoped precondition/i.test(text),
      'agents/commcare-setup.md § Step 0 lost its session-scoped declaration. ' +
        "Step 0 verifies a property of THIS session's Nova MCP binding; a " +
        '`done` marker from a previous session is not evidence about this one.',
    ).toBe(true);

    // The specific cached-state trap, named so it cannot be re-introduced.
    // `run_state.yaml` outliving the session is the whole mechanism, and
    // "treat it as unrun" is the instruction that closes it.
    expect(
      /treat step 0 as unrun on entry/i.test(text),
      'Step 0 must instruct the reader to treat it as UNRUN on entry rather ' +
        'than branching on the recorded step state. Softening that to "check ' +
        'whether it already passed" reopens ace#1604: the probe-then-branch ' +
        'reads the very state that is stale.',
    ).toBe(true);
  });

  it('both docs cite the issue, so the rule keeps its provenance', () => {
    for (const p of [ORCHESTRATOR, COMMCARE_SETUP]) {
      expect(
        read(p).includes('ace#1604'),
        `${path.relative(REPO_ROOT, p)} must cite ace#1604 next to the Nova ` +
          'principal rule. An uncited invariant is the first one a future edit ' +
          'deletes as redundant.',
      ).toBe(true);
    }
  });
});
