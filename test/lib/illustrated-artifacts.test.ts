/**
 * Ratchet: every artifact declared `illustrated: true` in ARTIFACT_MANIFEST
 * must be produced through a two-step write — render the markdown, THEN embed
 * the screenshots with the Docs API.
 *
 * The class this prevents: a step-by-step guide that publishes with zero
 * images. It is the harder sibling of the `rendered` class, because nothing
 * looks wrong. Every word survives, so word counts, section checks and all
 * five per-artifact content evals score it a pass; the only reader who
 * notices is the field worker holding the phone. It has shipped twice on the
 * same two documents:
 *
 *   - `![alt](drive:<fileId>)` — an ACE-internal reference, not a URL. Drive's
 *     importer drops the image node silently, alt text included (ace#1338).
 *   - `[alt](https://drive.google.com/file/d/<id>/view)` — the fix for the
 *     above. It restored the words as 44 clickable links and none of the
 *     pictures (ace#1418).
 *
 * Prose in a SKILL.md is what failed both times, so the contract is a test.
 *
 * Deliberately a RATCHET over opt-in entries only: `training-quick-reference`
 * is a printed pocket card that says "No screenshots", and machine-parsed
 * artifacts are never illustrated. Adding a new shown-the-screens artifact
 * means setting the flag, and then forgetting the embed step fails CI.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACT_MANIFEST } from '../../lib/artifact-manifest.js';

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * Things a producer can name to prove it embeds images AFTER conversion.
 * The script is the supported path; the atom and the lib are named because a
 * skill may reasonably drive the batchUpdate itself.
 */
const EMBED_MARKERS = [
  'embed-doc-screenshots',
  'insertInlineImage',
  'doc-image-embed',
];

function producerDoc(producedBy: string): { file: string; text: string } | null {
  for (const candidate of [
    path.join(REPO_ROOT, 'skills', producedBy, 'SKILL.md'),
    path.join(REPO_ROOT, 'agents', `${producedBy}.md`),
  ]) {
    if (fs.existsSync(candidate)) {
      return { file: path.relative(REPO_ROOT, candidate), text: fs.readFileSync(candidate, 'utf8') };
    }
  }
  return null;
}

describe('illustrated artifacts must embed their screenshots', () => {
  const illustrated = ARTIFACT_MANIFEST.filter((a) => a.illustrated);

  it('the two guides a partner reads step-by-step are flagged', () => {
    // Guards against the flag being quietly dropped, which would make every
    // assertion below vacuously green — the exact way this defect survived.
    const paths = illustrated.map((a) => a.path);
    expect(paths).toContain('6-qa-and-training/training-flw-guide.md');
    expect(paths).toContain('6-qa-and-training/training-llo-guide.md');
  });

  it('every illustrated artifact is also rendered', () => {
    // Images are inserted into a NATIVE Google Doc. A text/plain upload has no
    // document structure to insert into, so `illustrated` without `rendered`
    // is incoherent rather than merely incomplete.
    const bad = illustrated.filter((a) => !a.rendered).map((a) => a.path);
    expect(bad, 'illustrated implies rendered — these are missing rendered: true').toEqual([]);
  });

  it("every illustrated artifact's producer names the embed step", () => {
    const offenders: string[] = [];
    for (const a of illustrated) {
      const doc = producerDoc(a.producedBy);
      if (!doc) {
        offenders.push(`${a.path}: producer '${a.producedBy}' has no SKILL.md or agents/*.md`);
        continue;
      }
      if (!EMBED_MARKERS.some((m) => doc.text.includes(m))) {
        offenders.push(
          `${a.path}: ${doc.file} never mentions the embed step ` +
            `(one of: ${EMBED_MARKERS.join(', ')})`,
        );
      }
    }
    expect(
      offenders,
      offenders.length
        ? `Artifacts flagged 'illustrated: true' whose producer never embeds images:\n  ` +
            offenders.join('\n  ') +
            `\n\nDrive's markdown conversion alone publishes these with ZERO pictures and ` +
            `every word intact, so nothing else catches it. Run ` +
            `scripts/embed-doc-screenshots.ts after the render, or drop the flag if the ` +
            `artifact genuinely is not shown-the-screens (a printed pocket card, say).`
        : undefined,
    ).toEqual([]);
  });

  it('no producer of an illustrated artifact treats a screenshot LINK as the finished state', () => {
    // The 2026-08-13 regression in one line: a producer was told to emit
    // `[alt](https://drive.google.com/file/d/<id>/view)` and stop. The link
    // form is fine as a caption, but a producer that says it INSTEAD of an
    // image, with no embed step anywhere, ships a guide of 44 links.
    const offenders: string[] = [];
    for (const a of illustrated) {
      const doc = producerDoc(a.producedBy);
      if (!doc) continue;
      const namesLinkForm = /drive\.google\.com\/file\/d\/<file\s*_?id>\/view/i.test(doc.text);
      const namesEmbed = EMBED_MARKERS.some((m) => doc.text.includes(m));
      if (namesLinkForm && !namesEmbed) {
        offenders.push(`${doc.file}: prescribes the Drive LINK form with no embed step`);
      }
    }
    expect(offenders, offenders.join('\n  ') || undefined).toEqual([]);
  });
});
