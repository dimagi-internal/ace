import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * dimagi-internal/ace#2221 — the orchestrator's phase-handoff rule drifted off
 * the atom it depends on.
 *
 * `agents/ace-orchestrator.md § Per-phase conventions` mandates inlining the
 * full artifact BODY at every phase handoff. The anti-placeholder half of that
 * guard is real and stays (ace#1103: a `{{PDD}}` token reaching a subagent that
 * then has nothing to read). The RATIONALE underneath it was stale in two ways
 * that pointed the orchestrator at the worse of two available fallbacks:
 *
 *   1. "large artifacts (a 68 KB PDD) exceed the MCP `drive_read_file` result
 *      cap, so the agent's fallback fetch is degraded too" — `drive_read_file`
 *      has a `writeToPath` mode (`mcp/google-drive-server.ts:596`, `:619`,
 *      `:627-628`) that writes the COMPLETE document to disk and returns a
 *      handle with NO content, at zero context cost regardless of size. That is
 *      a full-fidelity read, not a degraded one.
 *   2. "read it from Drive (targeted reads under the result cap)" — prescribed
 *      `offset`/`limit` paging, which the atom's own description calls the more
 *      expensive fallback: paging a document to completion spends its full size
 *      in context; `writeToPath` spends none.
 *
 * And the rule was unachievable as written for ACE's PRIMARY artifacts: an
 * inline read is refused above `DEFAULT_INLINE_MAX_CHARS` (40,000) with a typed
 * `oversized_document`, so L0 physically cannot obtain a >40 KB body to inline.
 * Measured on `spark-facilitator/20260907-1120`, the PDD at
 * `1-design/idea-to-pdd.md` is 48,569 characters.
 *
 * The drift was invisible because nothing connected the two files:
 * `grep -rc writeToPath agents/*.md` returned ZERO matches while the atom had
 * documented the mode for months. This is that connection, as a ratchet.
 *
 * SCOPE, deliberately narrow. It asserts what the handoff guard must SAY, not
 * how it says it:
 *
 *   - the anti-placeholder guard survives (a "fix" cannot be a deletion),
 *   - the by-reference escape hatch names `writeToPath` on BOTH sides
 *     (orchestrator dispatching, phase agent recovering),
 *   - and the retired claims are not re-asserted anywhere in `agents/`.
 *
 * TENSE IS THE DISCRIMINATOR, as in `upstream-absence-claims.test.ts`. The
 * corrected text necessarily RECOUNTS the retired claim ("the rule previously
 * claimed the Drive fallback was itself capped and degraded"). The banned
 * patterns match the ASSERTION only.
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const SELF = 'test/docs/orchestrator-inline-handoff-fallback.test.ts';

const ORCHESTRATOR = 'agents/ace-orchestrator.md';
const orchestratorText = readFileSync(path.join(repoRoot, ORCHESTRATOR), 'utf-8');

/**
 * The handoff guard: from its bolded lead-in up to the next bolded lead-in
 * (`**Scope rule:`). Anchored on "Inline the artifact BODY", which is the
 * wording BOTH the pre-fix and post-fix paragraphs open with — so a regression
 * that reverts the paragraph is still located and still fails, rather than
 * silently reporting "guard not found".
 */
function handoffGuard(): string | undefined {
  const start = orchestratorText.indexOf('**Inline the artifact BODY');
  if (start === -1) return undefined;
  const rest = orchestratorText.slice(start);
  const end = rest.indexOf('**Scope rule:');
  return end === -1 ? rest : rest.slice(0, end);
}

/** Collapse markdown line breaks so a claim wrapped across lines matches. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/**
 * Assertions that the Drive fallback is capped or degraded, or that paging is
 * the fallback of choice. Present tense only — a recounting of the retired
 * claim ("previously claimed …", "used to say …") is the corrected text, not a
 * violation of it.
 */
const RETIRED_CLAIMS: readonly [RegExp, string][] = [
  [
    /exceed(?:s)? the MCP `?drive_read_file`? result cap/i,
    'that large artifacts exceed a `drive_read_file` result cap. `writeToPath` ' +
      'has no size ceiling — only the INLINE mode is capped at 40,000 chars.',
  ],
  [
    /(?:agent's |the )?fallback (?:fetch|read) is degraded/i,
    "that the agent's Drive fallback is degraded. A `writeToPath` read is " +
      'full-fidelity: the complete document, at zero context cost.',
  ],
  [
    /targeted reads under the result cap/i,
    'that the fallback is `offset`/`limit` paging. Paging to completion spends ' +
      "the document's full size in context; `writeToPath` spends none.",
  ],
];

describe('orchestrator phase-handoff guard is current with drive_read_file (ace#2221)', () => {
  it('the anti-placeholder guard still exists — a deletion is not a fix', () => {
    const guard = handoffGuard();
    expect(
      guard,
      `${ORCHESTRATOR} no longer carries the "Inline the artifact BODY" handoff ` +
        'guard. The ace#1103 hazard it names is real — an unsubstituted `{{PDD}}` ' +
        'token reaching a subagent that then has nothing to read. Correct its ' +
        'rationale; do not remove it.',
    ).toBeDefined();

    const g = normalize(guard ?? '');
    const required: [RegExp, string][] = [
      [/PDD_BODY_PLACEHOLDER|\{\{PDD\}\}|placeholder token/i, 'the placeholder tokens it bans'],
      [/ace#1103/i, 'the ace#1103 incident it records'],
    ];
    const missing = required.filter(([re]) => !re.test(g)).map(([, what]) => what);
    expect(missing, `the guard dropped: ${missing.join('; ')}`).toEqual([]);
  });

  it('sanctions the by-reference handoff and names writeToPath', () => {
    const g = normalize(handoffGuard() ?? '');

    expect(
      /writeToPath/.test(g),
      'The handoff guard does not name `writeToPath`. An inline read is refused ' +
        'above 40,000 chars (`oversized_document`), so L0 cannot inline a 48 KB ' +
        'PDD at all — the rule is unachievable without a sanctioned by-reference ' +
        'path. `drive_read_file(fileId, writeToPath=…)` writes the COMPLETE ' +
        'document to disk and returns a handle with no content, at zero context ' +
        'cost regardless of size (mcp/google-drive-server.ts:596, :619, :627-628).',
    ).toBe(true);

    const required: [RegExp, string][] = [
      [/drive_read_file/i, 'the atom the fallback goes through'],
      [/fileId/i, 'that a by-reference block must name the Drive fileId'],
      [/40,?000/, 'the 40,000-char inline cap that decides inline vs by-reference'],
      [
        /by[- ]reference/i,
        'that an over-cap artifact is passed BY REFERENCE rather than dropped',
      ],
    ];
    const missing = required.filter(([re]) => !re.test(g)).map(([, what]) => what);
    expect(
      missing,
      `the by-reference sanction is missing: ${missing.join('; ')}. Each is what ` +
        'keeps a by-reference block from being indistinguishable from the ' +
        'unsubstituted token the guard bans.',
    ).toEqual([]);
  });

  it('gives the phase agent the writeToPath recovery, not a paging recovery', () => {
    const g = normalize(handoffGuard() ?? '');
    // The phase-agent half: "treat the artifact as NOT inlined and read it from
    // Drive with …". Assert the read instruction names writeToPath.
    const phaseAgentSide = /read it from Drive[^.]{0,160}/i.exec(g)?.[0] ?? '';
    expect(
      /writeToPath/.test(phaseAgentSide),
      'The phase-agent side of the guard tells the agent to read the artifact ' +
        `from Drive without naming \`writeToPath\`. Found: "${phaseAgentSide}". ` +
        'This half is what an agent actually executes under failure, so it is ' +
        'the half that must carry the cheap, full-fidelity form.',
    ).toBe(true);
  });

  it('cites ace#2221, so a silent rewording cannot pass for the correction', () => {
    const g = normalize(handoffGuard() ?? '');
    expect(
      /ace#2221/i.test(g),
      'The corrected guard does not cite dimagi-internal/ace#2221. Without the ' +
        'citation a reader cannot date the claim or find why the previous ' +
        'rationale was retired.',
    ).toBe(true);
  });

  it('no agent doc re-asserts the capped/degraded Drive fallback', () => {
    const agentDocs = ['agents/ace-orchestrator.md', 'agents/orchestrator-reference.md'];
    const offenders: string[] = [];

    for (const file of agentDocs) {
      const normalized = normalize(readFileSync(path.join(repoRoot, file), 'utf-8'));
      for (const [claim, why] of RETIRED_CLAIMS) {
        const hit = normalized.match(claim);
        if (hit) offenders.push(`${file}: "${hit[0].trim()}" — asserts ${why}`);
      }
    }

    expect(
      offenders,
      'These agent docs assert a retired premise about `drive_read_file`. The ' +
        `atom's own description (mcp/google-drive-server.ts:593) is the ` +
        'authority; correct the reason rather than softening the rule:\n  ' +
        offenders.join('\n  ') +
        `\n(This test file quotes the banned patterns as source — it is ${SELF}, ` +
        'the registry, not a claim.)',
    ).toEqual([]);
  });
});
