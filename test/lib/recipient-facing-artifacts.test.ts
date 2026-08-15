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
    expect(recipientFacing.length).toBeGreaterThanOrEqual(5);
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
