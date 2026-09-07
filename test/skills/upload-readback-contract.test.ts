/**
 * dimagi-internal/ace#1831 — every Drive upload in the capture skill is shared,
 * and every one is read back by BYTES.
 *
 * ## The two halves this pins
 *
 * 1. **Sharing.** `app-screenshot-capture` shared its PNGs (the 2026-05-07
 *    contract) and left three other upload sites unshared, each with a
 *    rationale that asked the wrong question — "XMLs aren't consumed by Slides",
 *    "these are forensic, not presentational". Slides is one consumer; the
 *    capture manifest publishes all of them as run artifacts a reviewer can be
 *    handed.
 *
 * 2. **Verification, and specifically its GRAIN.** `200` is not evidence. On
 *    2026-09-06 an anonymous sweep of `hh-poverty-targeting/20260828-0702`
 *    returned `200` for all six artifacts while two of them were Google's
 *    virus-scan warning page. A HEAD or status check — the one #1831 originally
 *    proposed — certifies both. The amendment recorded on the issue is that the
 *    check must assert magic bytes, and this test is what keeps the skill saying
 *    so after someone simplifies the prose.
 *
 * ## Evidence class
 *
 * STATIC TEXT over one SKILL.md. The behavioural claims it guards are tested in
 * `test/lib/upload-readback.test.ts` against the observed bytes.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SKILL = 'skills/app-screenshot-capture/SKILL.md';
const text = () => readFileSync(join(REPO, SKILL), 'utf8');

describe('every upload is shared (ace#1831)', () => {
  /**
   * The exact rationales that shipped the defect. Both read as reasonable and
   * both are wrong for the same reason: they name ONE consumer (Slides, a deck)
   * and conclude nothing else reads the file.
   */
  it('no upload site claims anyone-with-link is unnecessary', () => {
    const offenders = text()
      .split('\n')
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /no\s+`?shareAnyoneWithLink`?\s+(?:needed|required)/i.test(l))
      .map(([n, l]) => `${SKILL}:${n}  ${l.trim()}`);
    expect(
      offenders,
      `Every artifact this skill uploads is published in the capture manifest as a run ` +
        `artifact. "Not consumed by Slides" and "forensic, not presentational" are not ` +
        `reasons to leave one unreadable (ace#1831).\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the three non-PNG upload sites name the flag', () => {
    const t = text();
    // Anchored on the UPLOAD instruction, not on the bare filename — each of
    // these paths is also discussed elsewhere in the skill, and matching the
    // first mention tests the wrong paragraph.
    for (const anchor of [
      '`journey-deliver/00-postlearn-landing.xml` (`drive_upload_binary`',
      '`6-qa-and-training/videos/_device/<filename>` (same mimeType',
      '/screenshots/<recipe-base>/<step-name>.xml`',
    ]) {
      const i = t.indexOf(anchor);
      expect(i, `${anchor} is gone from ${SKILL}`).toBeGreaterThan(-1);
      // The flag must be stated within the same paragraph-ish neighbourhood.
      expect(t.slice(i, i + 700), anchor).toContain('shareAnyoneWithLink');
    }
  });
});

describe('the post-upload check asserts BYTES, not 200 (ace#1831)', () => {
  const step = () => {
    const t = text();
    const start = t.indexOf('### Step 5.8:');
    expect(start, 'Step 5.8 (the anonymous readback) is missing').toBeGreaterThan(-1);
    return t.slice(start, t.indexOf('### Step 6:', start));
  };

  it('names the classifier rather than re-deriving a magic-byte table in prose', () => {
    expect(step()).toContain('classifyUploadReadback');
    expect(step()).toContain('lib/upload-readback.ts');
  });

  it('says explicitly that a status check is not enough', () => {
    expect(step()).toMatch(/never by 200|not by `?200|`200`\/HEAD check/i);
  });

  it('the fetch it prescribes carries no credentials', () => {
    expect(step()).toMatch(/with no credentials|anonymous/i);
  });

  /**
   * The distinction that cost the most to learn. An interstitial file is
   * ALREADY anonymously reachable, so `drive_set_anyone_with_link` is a no-op on
   * it — applying the gated remedy there reads as progress while changing
   * nothing. The skill must carry both remedies, separately.
   */
  it('distinguishes an interstitial from a gated file, with different remedies', () => {
    const s = step();
    expect(s).toContain('interstitial');
    expect(s).toContain('drive_set_anyone_with_link');
    expect(s).toMatch(/sharing will NOT help|sharing them again changes nothing/i);
  });

  it('records the measurement it rests on', () => {
    expect(step()).toContain('Virus scan warning');
    expect(step()).toContain('hh-poverty-targeting/20260828-0702');
  });
});
