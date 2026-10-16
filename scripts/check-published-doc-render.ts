#!/usr/bin/env -S npx tsx
/**
 * Binary pre-eval gate: does a PUBLISHED Google Doc render as a document?
 *
 *   npx tsx scripts/check-published-doc-render.ts <docUrl|docId> [--expect-images] [--json]
 *
 * Reads the doc's anonymous txt + html exports (what a reader outside ACE
 * gets) and exits:
 *   0  renders clean: no literal markdown (and >= 1 image with --expect-images)
 *   1  fails: raw markdown on the page, zero images on an illustrated artifact,
 *      or the doc could not be read anonymously (not judged is not clean)
 *   2  usage error
 *
 * Run it on the published Doc URL BEFORE any `-eval` grades the artifact; a
 * non-zero exit means the eval's verdict is `fail` whatever the prose scores.
 * `--expect-images` is for artifacts flagged `illustrated: true` in
 * `lib/artifact-manifest.ts` (the FLW and LLO guides).
 *
 * Why a script and not a rubric sentence (ace#2213): all five Phase 6 training
 * evals passed at 8.4-8.8 on docs that published as raw markdown, two with 0 of
 * 157 screenshots, while their own rubric told them to open the published doc.
 */

import { fetchPublishedDocExport, judgePublishedRender } from '../lib/published-doc-render-check.js';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const expectImages = args.includes('--expect-images');
  const asJson = args.includes('--json');
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) {
    console.error('usage: check-published-doc-render.ts <docUrl|docId> [--expect-images] [--json]');
    return 2;
  }
  const url = /^[A-Za-z0-9_-]{10,}$/.test(target)
    ? `https://docs.google.com/document/d/${target}/edit`
    : target;

  const exp = await fetchPublishedDocExport(url);
  const verdict = judgePublishedRender(exp, { expectImages });
  if (asJson) {
    console.log(JSON.stringify({ url, expectImages, ...verdict }, null, 2));
  } else if (verdict.ok) {
    console.log(`PASS ${url} — renders clean, ${verdict.renderedImageCount ?? 'unknown'} image(s)`);
  } else {
    console.log(`FAIL ${url}`);
    for (const f of verdict.failures) console.log(`  - ${f}`);
    console.log('  fix: republish via drive_create_doc_from_markdown (and, for an illustrated guide, ' +
      'scripts/embed-doc-screenshots.ts), then re-run this check before grading');
  }
  return verdict.ok ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err);
  process.exit(1);
});
