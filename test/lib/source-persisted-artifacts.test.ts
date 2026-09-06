/**
 * Ratchet: every artifact declared `sourcePersisted: true` in ARTIFACT_MANIFEST
 * must have its composed markdown written to a sibling `<name>.source.md` as a
 * PLAIN text/markdown file.
 *
 * The class this prevents (ace#1687, half 2): `drive_create_doc_from_markdown`
 * consumes its input. What lands in Drive is a native Google Doc, and the
 * markdown that produced it exists nowhere afterwards — the `.md` on
 * `training-faq.md` is part of the display NAME, not a separate file.
 * `drive_list_folder` over `hh-poverty-targeting/20260824-1404`'s
 * `6-qa-and-training/` returns all five training documents as
 * `application/vnd.google-apps.document` and no sibling markdown of any kind;
 * the same holds for the PDD and Work Order in `1-design/`.
 *
 * That makes `DOC-FIDELITY-UNVERIFIED` — the only check that compares what was
 * PUBLISHED against what was WRITTEN, and the only thing that could have
 * caught a guide silently losing 44 screenshots and 224 words with every other
 * check green (ace#1418) — permanently unresolvable. Its remediation says to
 * pass `--doc-source` mapping each url to its source markdown. There was no
 * such artifact to point at, so a BLOCKING finding could only ever report
 * UNVERIFIED, and the regression it guards stayed unguarded.
 *
 * Prose in a SKILL.md is what fails under load, so the contract is a test.
 *
 * Deliberately a RATCHET over opt-in entries only: machine-parsed artifacts
 * (verdicts, manifests, specs) are never rendered and so never lose anything,
 * and `open-questions.md` is deliberately excluded — it is an opp-level LIVING
 * document reviewers hand-edit in place across runs, so published-vs-source
 * divergence there is legitimate and a fidelity diff would report human edits
 * as defects.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACT_MANIFEST, sourceMarkdownPathFor } from '../../lib/artifact-manifest.js';

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * The BYTE-PRESERVING write atoms.
 *
 * `drive_create_file` was named here until ace#1991 and it is the wrong atom:
 * it ALWAYS creates a Google Doc. There is no mimeType that changes that, and
 * the key a caller passed to try was dropped by the MCP schema — so all six
 * flagged producers named it, this ratchet went green, and every `.source.md`
 * in Drive was a SECOND rendered Doc. DOC-FIDELITY then compared one Doc
 * against another built by the same importer: structurally passing, and unable
 * to detect the content loss it exists to catch.
 *
 * `drive_upload_binary` uses Drive's media-upload path, so a `text/markdown`
 * body lands as `text/markdown` and `drive_read_file` returns it verbatim via
 * `alt=media` rather than as a Doc export. Despite the name it is the right
 * atom for text whose bytes matter, and `skills/_training-template.md` has
 * prescribed it for `.source.md` since 2026-09-01 — the producers had simply
 * not followed their own template.
 *
 * `drive_update_file` stays: a producer may reasonably overwrite an existing
 * source file in place, and that path does not re-import.
 */
const PLAIN_WRITE_MARKERS = ['drive_upload_binary', 'drive_update_file'];

/**
 * Atoms that ALWAYS convert to a Google Doc. Naming one as the way to persist
 * a source copy reproduces the defect while looking like the fix — which is
 * exactly what happened with `drive_create_file` (ace#1991).
 */
const RENDERING_WRITE_MARKERS = ['drive_create_doc_from_markdown', 'drive_create_file'];

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

describe('source-persisted artifacts must store their composed markdown', () => {
  const flagged = ARTIFACT_MANIFEST.filter((a) => a.sourcePersisted);

  it('every markdown-composed document a run hands to a reviewer is flagged', () => {
    // Guards against the flag being quietly dropped, which would make every
    // assertion below vacuously green — the way this whole class of defect
    // survives. These six are the documents a normal run composes AS MARKDOWN
    // and publishes through Drive's importer: the PDD and the five training
    // documents.
    const paths = flagged.map((a) => a.path).sort();
    expect(paths).toEqual([
      '1-design/idea-to-pdd.md',
      '6-qa-and-training/training-faq.md',
      '6-qa-and-training/training-flw-guide.md',
      '6-qa-and-training/training-llo-guide.md',
      '6-qa-and-training/training-onboarding-email.md',
      '6-qa-and-training/training-quick-reference.md',
    ]);
  });

  it('the Work Order is deliberately NOT flagged — it has no markdown source', () => {
    // Pinned so a future reader does not "complete the set". The work order is
    // built by docs_copy_template = drive.files.copy + replaceAllText: Doc to
    // Doc, no importer, so the content-dropping class DOC-FIDELITY guards
    // cannot occur, and there is no composed markdown to persist. A .source.md
    // there would be a file the document was never produced from — a green
    // diff that means nothing. See the sourcePersisted doc comment.
    const wo = ARTIFACT_MANIFEST.find((a) => a.path === '1-design/pdd-to-work-order.gdoc');
    expect(wo, 'the work-order entry vanished — this pin needs revisiting').toBeDefined();
    expect(wo!.sourcePersisted).toBeUndefined();
  });

  it('every source-persisted artifact is also rendered', () => {
    // The flag exists BECAUSE the renderer consumes its input. A plain-file
    // artifact still has its own bytes on Drive, so flagging one is incoherent
    // rather than merely redundant.
    const bad = flagged.filter((a) => !a.rendered).map((a) => a.path);
    expect(bad, 'sourcePersisted implies rendered — these are missing rendered: true').toEqual([]);
  });

  it('the registered .source.md entries match the flagged set exactly', () => {
    // Kills drift between the flag and the registry: a flag with no companion
    // entry is invisible to anything reading the manifest, and a companion
    // entry with no flag is a file nothing ever writes.
    const registered = ARTIFACT_MANIFEST.filter((a) => a.path.endsWith('.source.md'))
      .map((a) => a.path)
      .sort();
    const derived = flagged.map((a) => sourceMarkdownPathFor(a.path)).sort();
    expect(registered).toEqual(derived);
  });

  it('every .source.md companion is optional and names its producer', () => {
    // Required would retroactively fail every run that completed before this
    // shipped — verify_phase_artifacts only demands the required set, and
    // counts these under optional_present_count.
    const offenders: string[] = [];
    for (const a of ARTIFACT_MANIFEST.filter((x) => x.path.endsWith('.source.md'))) {
      if (a.required) offenders.push(`${a.path}: required: true would fail every pre-ace#1687 run`);
      const published = flagged.find((p) => sourceMarkdownPathFor(p.path) === a.path);
      if (published && a.producedBy !== published.producedBy) {
        offenders.push(
          `${a.path}: producedBy '${a.producedBy}' != publisher '${published.producedBy}'`,
        );
      }
    }
    expect(offenders, offenders.join('\n  ') || undefined).toEqual([]);
  });

  it("every flagged artifact's producer names the persist step", () => {
    const offenders: string[] = [];
    for (const a of flagged) {
      const doc = producerDoc(a.producedBy);
      if (!doc) {
        offenders.push(`${a.path}: producer '${a.producedBy}' has no SKILL.md or agents/*.md`);
        continue;
      }
      const sourceName = path.basename(sourceMarkdownPathFor(a.path));
      if (!doc.text.includes(sourceName)) {
        offenders.push(`${a.path}: ${doc.file} never names '${sourceName}'`);
      }
    }
    expect(
      offenders,
      offenders.length
        ? `Artifacts flagged 'sourcePersisted: true' whose producer never persists the markdown:\n  ` +
            offenders.join('\n  ') +
            `\n\nWithout it DOC-FIDELITY-UNVERIFIED can only ever report UNVERIFIED, so a ` +
            `BLOCKING gate is unresolvable and the regression it guards is unguarded. Write the ` +
            `same string twice: drive_create_doc_from_markdown for the human, drive_upload_binary ` +
            `(mimeType: text/markdown) for the auditor — NOT drive_create_file, which renders ` +
            `too (ace#1991).`
        : undefined,
    ).toEqual([]);
  });

  it('no producer persists its source markdown through the RENDERER', () => {
    // The fix's own footgun: reaching for drive_create_doc_from_markdown to
    // write the source copy converts it to a Doc as well, destroying the exact
    // bytes the comparison needs. That reproduces the defect while looking
    // like the fix. Require the plain-file atom to be named alongside.
    const offenders: string[] = [];
    for (const a of flagged) {
      const doc = producerDoc(a.producedBy);
      if (!doc) continue;
      if (!PLAIN_WRITE_MARKERS.some((m) => doc.text.includes(m))) {
        offenders.push(
          `${doc.file}: never names a byte-preserving write atom ` +
            `(one of: ${PLAIN_WRITE_MARKERS.join(', ')}) — the source copy must NOT be rendered`,
        );
      }
    }
    expect(offenders, offenders.join('\n  ') || undefined).toEqual([]);
  });

  it('no producer names a RENDERING atom as the way to write its .source.md (ace#1991)', () => {
    // The sibling of the check above, and the one that was missing. Naming a
    // byte-preserving atom SOMEWHERE in the document is satisfied by a
    // producer that then instructs `drive_create_file` for the companion — and
    // that is precisely what all six did. Read the sentence that mentions
    // `.source.md`, and require that no converting atom appears in it.
    const offenders: string[] = [];
    for (const a of flagged) {
      const doc = producerDoc(a.producedBy);
      if (!doc) continue;
      const lines = doc.text.split('\n');
      for (const [i, line] of lines.entries()) {
        if (!line.includes('.source.md')) continue;
        // A wrapped instruction: the .source.md and the atom are routinely on
        // adjacent lines, so read a small window rather than one line.
        const window = lines.slice(Math.max(0, i - 3), i + 4).join(' ');
        const rendering = RENDERING_WRITE_MARKERS.filter((m) => window.includes(m));
        if (rendering.length === 0) continue;
        // Naming the renderer is FINE and usually necessary — it is where the
        // bytes came from, and "NOT drive_create_file" is the load-bearing
        // warning. What is not fine is a window that names a converting atom
        // and NO byte-preserving one, because then the converting atom is the
        // only write on offer. That is the exact pre-ace#1991 state of all six
        // producers, and it is what this predicate detects.
        if (PLAIN_WRITE_MARKERS.some((m) => window.includes(m))) continue;
        offenders.push(
          `${doc.file}:${i + 1} writes a .source.md naming only ${rendering.join(' / ')}`,
        );
      }
    }
    expect(
      offenders,
      offenders.length
        ? offenders.join('\n  ') +
          `\n\ndrive_create_doc_from_markdown and drive_create_file BOTH always create a Google ` +
          `Doc. A .source.md written through either is a second rendered Doc, and DOC-FIDELITY ` +
          `then compares one Doc against another built by the same importer. Use ` +
          `drive_upload_binary with mimeType: 'text/markdown' (ace#1991).`
        : undefined,
    ).toEqual([]);
  });
});
