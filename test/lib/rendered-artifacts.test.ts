/**
 * Ratchet: every artifact declared `rendered: true` in ARTIFACT_MANIFEST must
 * be produced through a Google-Docs RENDERING path, never `drive_create_file`.
 *
 * The class this prevents: `drive_create_file` uploads the body as
 * `text/plain`, so a markdown document lands in Drive with every `##`, `**`,
 * `|` and `---` as a literal character on the page. The failure is SILENT —
 * word counts, section checks and evals all still pass — and it only surfaces
 * when a human opens the link. It has shipped twice: on the PDD
 * (dimagi-internal/ace#1061) and across all five Phase-6 training guides
 * (ace#1338, caught by a partner reading the docs, not by ACE).
 *
 * Deliberately a RATCHET, not a blanket rule. It asserts only over entries
 * that opt in via `rendered: true`, so machine-parsed artifacts
 * (run_state.yaml, decisions.yaml, every *_verdict.yaml, specs, manifests)
 * are never checked and stay correctly on `drive_create_file` — Drive's
 * markdown converter mangles YAML. Adding a new human-facing artifact means
 * setting the flag, and then this test makes forgetting the renderer fail CI.
 *
 * Three renderers count, because ACE has three legitimate paths to a rendered
 * gdoc: markdown conversion, Docs template copy, and the decisions renderer.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACT_MANIFEST } from '../../lib/artifact-manifest.js';

const REPO_ROOT = path.resolve(__dirname, '../..');

/** Atoms that produce a NATIVE, styled Google Doc. */
const RENDERER_ATOMS = [
  'drive_create_doc_from_markdown',
  'docs_copy_template',
  'render_decisions_log',
];

/**
 * Resolve a manifest `producedBy` to its instruction file. Some artifacts are
 * produced by agents rather than skills (the manifest lint does the same
 * skills-then-agents resolution).
 */
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

describe('rendered artifacts must go through a gdoc renderer', () => {
  const rendered = ARTIFACT_MANIFEST.filter((a) => a.rendered);

  it('at least the known human-facing artifacts are flagged', () => {
    // Guards against the flag being silently dropped from every entry, which
    // would make the assertions below vacuously green.
    expect(rendered.length).toBeGreaterThanOrEqual(8);
    const paths = rendered.map((a) => a.path);
    expect(paths).toContain('1-design/idea-to-pdd.md');
    expect(paths).toContain('6-qa-and-training/training-faq.md');
  });

  it("every rendered artifact's producer references a renderer atom", () => {
    const offenders: string[] = [];
    for (const a of rendered) {
      const doc = producerDoc(a.producedBy);
      if (!doc) {
        offenders.push(`${a.path}: producer '${a.producedBy}' has no SKILL.md or agents/*.md`);
        continue;
      }
      if (!RENDERER_ATOMS.some((atom) => doc.text.includes(atom))) {
        offenders.push(
          `${a.path}: ${doc.file} never mentions a renderer atom ` +
            `(one of: ${RENDERER_ATOMS.join(', ')})`,
        );
      }
    }
    expect(
      offenders,
      offenders.length
        ? `Artifacts flagged 'rendered: true' whose producer does not render:\n  ` +
            offenders.join('\n  ') +
            `\n\nA human opens these documents. Write them with ` +
            `drive_create_doc_from_markdown so Drive converts the markdown, or drop ` +
            `the 'rendered' flag if the artifact is actually machine-parsed.`
        : undefined,
    ).toEqual([]);
  });

  it('no line naming a rendered artifact also names drive_create_file', () => {
    // The narrow, high-signal form of "don't write this one with the wrong
    // atom": a producer may legitimately call drive_create_file elsewhere (its
    // own verdict YAML), so only lines that mention THIS artifact's basename
    // are checked.
    const offenders: string[] = [];
    for (const a of rendered) {
      const doc = producerDoc(a.producedBy);
      if (!doc) continue;
      const basename = a.path.split('/').pop()!;
      doc.text.split('\n').forEach((line, i) => {
        // A line that names BOTH atoms is a tools list or an explicit
        // "renderer for the prose, create_file for the YAML" contrast — not a
        // write instruction pointing the artifact at the wrong atom.
        if (RENDERER_ATOMS.some((atom) => line.includes(atom))) return;
        if (line.includes(basename) && line.includes('drive_create_file')) {
          offenders.push(`${doc.file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      offenders.length
        ? `drive_create_file named on the same line as a rendered artifact:\n  ` + offenders.join('\n  ')
        : undefined,
    ).toEqual([]);
  });

  it('no producer of a rendered artifact emits a markdown IMAGE against the internal drive: scheme', () => {
    // Drive's markdown importer drops an image node whose src it cannot fetch
    // — silently, alt text included. `drive:<fileId>` is an ACE-internal
    // reference, not a resolvable URL, so `![alt](drive:<id>)` in a rendered
    // gdoc evaporates. Measured on spark-facilitator/20260813-2126: all 44
    // screenshot refs in the FLW guide vanished, 224 words lost, every content
    // check still green (ace#1338). The link form survives AND is clickable.
    const offenders: string[] = [];
    for (const a of rendered) {
      const doc = producerDoc(a.producedBy);
      if (!doc) continue;
      doc.text.split('\n').forEach((line, i) => {
        if (/!\[[^\]]*\]\(drive:/.test(line) && !line.includes('❌')) {
          offenders.push(`${doc.file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      offenders.length
        ? `Markdown image against the drive: scheme in a rendered artifact's producer:\n  ` +
            offenders.join('\n  ') +
            `\n\nUse [alt](https://drive.google.com/file/d/<fileId>/view) instead — an ` +
            `unfetchable image src is dropped silently by Drive's importer.`
        : undefined,
    ).toEqual([]);
  });

  it('no .yaml artifact is flagged rendered (YAML must not go through Drive conversion)', () => {
    const bad = rendered.filter((a) => a.path.endsWith('.yaml') || a.path.endsWith('.json'));
    expect(
      bad.map((a) => a.path),
      "Drive's markdown converter mangles YAML/JSON — these must stay on drive_create_file.",
    ).toEqual([]);
  });
});
