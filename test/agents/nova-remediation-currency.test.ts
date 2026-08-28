/**
 * Nova auth remediation must not outlive the mechanism it was written for.
 *
 * ## The incident this exists for
 *
 * `voidcraft-labs/nova-plugin#52` was filed on the theory that *a stored OAuth
 * credential outranks the `headersHelper` PAT*. ACE wrote that mechanism into
 * four operator-facing surfaces, each terminating at the same instruction:
 * `/mcp` -> nova -> `Clear authentication`.
 *
 * On 2026-08-25 the issue's own author DISPROVED it, in that thread, with the
 * client logs:
 *
 *     Successfully retrieved 0 headers from headersHelper
 *     No access token in storage
 *
 * There was no stored token to outrank anything. The real cause is that Claude
 * Code 2.1.238 changed what environment `headersHelper` receives at
 * interactive-session connect time; nova's helper reads `$NOVA_API_KEY` from
 * that env and takes its `else printf '{}'` branch, so no header is sent and
 * the client correctly begins an OAuth cascade (0 of 53 sessions on 2.1.238+
 * sent a header; 32/32 did on 2.1.237).
 *
 * `Clear authentication` is therefore a **no-op by construction** in this
 * state: it removes an OAuth token and restores no credential, so the session
 * re-prompts OAuth and the operator loops. ACE kept prescribing it as the
 * terminal remedy for three days after the correction, across four files. That
 * is dimagi-internal/ace#1769's complaint one layer down — the branch the
 * operator is routed to is itself the wrong one.
 *
 * ## Why this is a test and not a paragraph
 *
 * The upstream issue is still OPEN, so `scripts/probe-upstream-asks.ts` — which
 * reports issues ACE cites as live but that have CLOSED — cannot see this. The
 * mechanism was corrected *in a comment* while the issue stayed open, which is
 * a silent-failure shape that probe is structurally blind to.
 *
 * The invariant: any surface that still names `Clear authentication` must also
 * name the thing that actually fixes it, so an operator reading it cannot be
 * routed to the no-op alone.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Operator-facing surfaces that prescribe a Nova auth remedy. */
const SURFACES = [
  'agents/ace-orchestrator.md',
  'agents/commcare-setup.md',
  'playbook/integrations/nova-integration.md',
  'bin/ace-doctor',
];

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Nova auth remediation currency (nova-plugin#52, mechanism corrected 2026-08-25)', () => {
  it.each(SURFACES)(
    '%s: naming `Clear authentication` requires naming the real fix alongside it',
    (rel) => {
      const text = read(rel);
      if (!text.includes('Clear authentication')) return; // surface carries no remedy
      expect(
        text.includes('nova_header_readiness'),
        `${rel} prescribes \`Clear authentication\` without naming nova_header_readiness, ` +
          'the probe that installs the static-header override. `Clear authentication` removes ' +
          'an OAuth token and restores no credential, so on Claude Code 2.1.238+ it is a no-op ' +
          'by construction and the operator loops (nova-plugin#52, third correction).',
      ).toBe(true);
    },
  );

  it.each(SURFACES)(
    '%s: does not assert stored-OAuth precedence as a live cause',
    (rel) => {
      const text = read(rel);
      // The disproved claim, in the phrasings ACE actually shipped it in.
      const disproved = [
        /cause is a stored OAuth token\s+outranking/i,
        /a stored OAuth credential is outranking the headersHelper PAT/i,
        /A stored OAuth credential OUTRANKS the `headersHelper` PAT/,
        /a stored expired OAuth credential is\s*\n?\s*#?\s*outranking the headersHelper PAT/i,
      ];
      for (const re of disproved) {
        expect(
          re.test(text),
          `${rel} still asserts stored-OAuth precedence as the cause. That was DISPROVED ` +
            'upstream on 2026-08-25 (`No access token in storage` alongside `retrieved 0 ' +
            'headers from headersHelper`). The cause is that no Authorization header is sent ' +
            'at all on Claude Code 2.1.238+. Cite the header mechanism, or mark the old ' +
            'reading DISPROVED where the forensic narrative is kept for history.',
        ).toBe(false);
      }
    },
  );

  it('the corrected mechanism is stated where the fix lives', () => {
    // lib/nova-header-readiness.ts is the code that answers "will a header be
    // sent?" — it must keep saying so, since every surface above defers to it.
    const lib = read('lib/nova-header-readiness.ts');
    expect(lib).toMatch(/2\.1\.238/);
    expect(lib).toMatch(/no-op by construction/i);
  });
});
