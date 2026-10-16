import { describe, it, expect } from 'vitest';

import {
  judgePublishedRender,
  literalMarkdownHits,
  renderedImageCount,
} from '../../lib/published-doc-render-check.js';

/**
 * ace#2213 — the shared render detectors a pre-eval gate runs on a PUBLISHED
 * Doc. Shapes from poverty-graduation/20260905-1345: all five training docs
 * published as raw markdown (headings, bold, pipe tables), two guides with
 * zero images, and every training eval passed them at 8.4-8.8.
 */

const RAW = [
  '## Your daily routine',
  '',
  'Each morning, open **Connect** and check your visits.',
  '',
  '| Step | What to do |',
  '|---|---|',
  '| 1 | Open the app |',
].join('\n');

const CLEAN = [
  'Your daily routine',
  '',
  'Each morning, open Connect and check your visits.',
  '',
  'Step 1: open the app.',
].join('\n');

describe('literalMarkdownHits', () => {
  it('names every raw-markdown marker on a doc uploaded as text', () => {
    const hits = literalMarkdownHits(RAW);
    expect(hits).toEqual(expect.arrayContaining([
      expect.stringMatching(/ATX headings/),
      expect.stringMatching(/bold markers/),
      expect.stringMatching(/pipe tables/),
    ]));
  });

  it('is empty on a properly converted doc', () => {
    expect(literalMarkdownHits(CLEAN)).toEqual([]);
  });

  it('a lone "#" table column does not read as a heading (newline-eating regression)', () => {
    expect(literalMarkdownHits('#\nRow one\n')).toEqual([]);
  });
});

describe('renderedImageCount', () => {
  it('counts <img tags in the html export', () => {
    expect(renderedImageCount('<p><img src="a"></p><IMG src="b">')).toBe(2);
    expect(renderedImageCount('<p>no pictures</p>')).toBe(0);
  });
});

describe('judgePublishedRender — the binary gate', () => {
  it('fails a raw-markdown doc', () => {
    const v = judgePublishedRender({ text: RAW, html: null, images: 3, why: '' });
    expect(v.ok).toBe(false);
    expect(v.failures[0]).toMatch(/raw markdown/);
  });

  it('fails an illustrated guide that renders zero images, even with clean text', () => {
    const v = judgePublishedRender({ text: CLEAN, html: '<p></p>', images: 0, why: '' }, { expectImages: true });
    expect(v.ok).toBe(false);
    expect(v.failures.join(' ')).toMatch(/ZERO images/);
  });

  it('zero images is fine for a text-only artifact (FAQ, card, email)', () => {
    expect(judgePublishedRender({ text: CLEAN, html: '<p></p>', images: 0, why: '' }).ok).toBe(true);
  });

  it('passes a clean, illustrated doc', () => {
    const v = judgePublishedRender({ text: CLEAN, html: '<img>', images: 26, why: '' }, { expectImages: true });
    expect(v).toMatchObject({ ok: true, failures: [], renderedImageCount: 26 });
  });

  it('an unreadable doc is NOT clean — not judged is a fail', () => {
    const v = judgePublishedRender({ text: null, html: null, images: null, why: 'text export answered HTTP 401 anonymously' });
    expect(v.ok).toBe(false);
    expect(v.failures[0]).toMatch(/401/);
  });
});
