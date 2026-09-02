/**
 * Ratchet: every artifact declared `recipientFacing: true` must be shared
 * anyone-with-link by its producer, at creation.
 *
 * ace#902. A private Google Doc opens only for accounts explicitly shared on
 * it, so a recipient following the run-summary link hits "You need access".
 * Nothing upstream notices: the doc exists, has the right words, passes every
 * content eval, and returns a perfectly respectable 401 — which a link checker
 * reasonably reads as "auth-gated", the correct verdict for a PLATFORM login
 * gate (Connect, HQ, OCS) and the wrong one for an ACE-authored deliverable.
 *
 * On hh-poverty-targeting/20260722-1341 the summary reported `13 links · 0
 * BROKEN` with all six training links AUTH-GATED. None of them opened for the
 * person they were written for; they were shared by hand after the fact.
 *
 * The DETECT half now exists — `LINK-PRIVATE-DELIVERABLE` in
 * `lib/run-surface-audit.ts`. This is the PREVENT half, because an audit finds
 * it only after the run and only if someone acts on the finding.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACT_MANIFEST } from '../../lib/artifact-manifest.js';

const REPO_ROOT = path.resolve(__dirname, '../..');

/** What a producer can name to prove it shares. The atom is the supported path. */
const SHARE_MARKERS = ['drive_set_anyone_with_link', 'shareAnyoneWithLink'];

const recipientFacing = ARTIFACT_MANIFEST.filter((a) => a.recipientFacing);

function producerSource(producedBy: string): string | null {
  for (const rel of [`skills/${producedBy}/SKILL.md`, `agents/${producedBy}.md`]) {
    const p = path.join(REPO_ROOT, rel);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  return null;
}

describe('recipient-facing artifacts are shared at creation (ace#902)', () => {
  it('the flag is actually used — an empty ratchet proves nothing', () => {
    expect(recipientFacing.length).toBeGreaterThanOrEqual(8);
  });

  it.each(recipientFacing.map((a) => [a.path, a.producedBy] as const))(
    '%s — producer %s names the share step',
    (artifactPath, producedBy) => {
      const src = producerSource(producedBy);
      expect(src, `no SKILL.md/agent doc found for producer "${producedBy}"`).toBeTruthy();
      const named = SHARE_MARKERS.some((m) => src!.includes(m));
      expect(
        named,
        `${artifactPath} is recipientFacing but ${producedBy} never names ` +
          `${SHARE_MARKERS.join(' / ')}. A recipient following the summary link ` +
          `will hit "You need access" and every content check will still be green.`,
      ).toBe(true);
    },
  );
});

describe('the ROLE is declared, and the producer names it (ace#1843)', () => {
  it('every recipient-facing artifact declares a shareRole', () => {
    // Visibility is not a boolean. A Drive READER cannot comment, and
    // skills/feedback-ledger's `channel: gdoc-comments` — the whole
    // feedback -> ledger -> next-run loop — assumes the reviewer can leave an
    // anchored comment. Sharing the PDD `reader` yields a link that opens and
    // a review that is structurally impossible.
    const missing = recipientFacing.filter((a) => !a.shareRole);
    expect(missing.map((a) => a.path)).toEqual([]);
  });

  it.each(
    recipientFacing
      .filter((a) => a.shareRole === 'commenter')
      .map((a) => [a.path, a.producedBy] as const),
  )('%s — producer %s names role: commenter', (artifactPath, producedBy) => {
    const src = producerSource(producedBy)!;
    const namesRole = /role:\s*'commenter'/.test(src);
    expect(
      namesRole,
      `${artifactPath} declares shareRole 'commenter' but ${producedBy} never ` +
        `writes role: 'commenter'. Shared as a reader it opens and cannot be ` +
        `commented on, so the gdoc-comments feedback channel silently has no ` +
        `input while every link check reads green.`,
    ).toBe(true);
  });
});

describe('the three ace#1843 deliverables are covered', () => {
  // Positive control. On hh-poverty-targeting/20260828-0702,
  // bednet-check-2-visit/20260828-0629 and spark-facilitator/20260828-0703 —
  // three independent runs in three days — these 401'd anonymously, taking the
  // run-summary page's entire DESIGN section with them. ace-web MEASURES the
  // access tag, so the page rendered them ADMIN ONLY: a true story about a
  // wrong state.
  it.each([
    '1-design/idea-to-pdd.md',
    '1-design/pdd-to-work-order.gdoc',
    'open-questions.md',
  ])('%s is recipient-facing', (p) => {
    const entry = ARTIFACT_MANIFEST.find((a) => a.path === p);
    expect(entry, `no manifest entry for ${p}`).toBeTruthy();
    expect(entry!.recipientFacing).toBe(true);
  });
});

describe('internal stays expressible — the negative control (ace#1026)', () => {
  it('the OCS widget handoff is NOT recipient-facing', () => {
    // It carries an `embed_key`. It is correctly private now that ace#1811
    // established the public chatbot URL as the LLO route. A guard that flags
    // every unshared artifact fires on this one forever, which is what makes
    // it an always-fires blocker rather than a preventer. Absence of the flag
    // is a deliberate state, not a gap.
    const handoff = ARTIFACT_MANIFEST.find(
      (a) => a.path === '5-ocs/ocs-setup_widget-handoff.md',
    );
    expect(handoff, 'widget-handoff entry vanished from the manifest').toBeTruthy();
    expect(handoff!.recipientFacing).toBeUndefined();
    expect(handoff!.shareRole).toBeUndefined();
  });

  it('no artifact carries shareRole without recipientFacing', () => {
    const orphaned = ARTIFACT_MANIFEST.filter((a) => a.shareRole && !a.recipientFacing);
    expect(orphaned.map((a) => a.path)).toEqual([]);
  });
});

describe('the flag means what it says', () => {
  it('no verdict, manifest, spec or transcript is recipient-facing', () => {
    // Publishing an internal artifact anyone-with-link widens exposure for
    // no one's benefit. Only what is meant to leave the building gets the flag.
    const internal = recipientFacing.filter((a) =>
      /_verdict|manifest|-spec\.yaml|transcript|run_state/.test(a.path),
    );
    expect(internal.map((a) => a.path)).toEqual([]);
  });

  it('every recipient-facing artifact is also `rendered` — a .md is not a link', () => {
    // The recipient opens a Google Doc, not raw markdown in Drive, so the
    // sharing question only arises for artifacts that get rendered.
    const notRendered = recipientFacing.filter((a) => !a.rendered);
    expect(notRendered.map((a) => a.path)).toEqual([]);
  });
});
