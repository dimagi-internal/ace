import { describe, it, expect, vi } from 'vitest';
import { readPublishedForCaptionBacking } from '../../../mcp/google-drive-server.js';
import { extractCitedFileIds } from '../../../lib/caption-backing.js';

/**
 * dimagi-internal/ace#2492: `verify_caption_backing` read a rendered training
 * guide (a native Google Doc) with the default text/plain export, which keeps a
 * link's text and drops its target — so `extractCitedFileIds` found nothing and
 * the fence passed every FLW/LLO guide vacuously (`cited_total: 0`).
 *
 * The two bodies below are the SHAPES Drive actually returns for one citation
 * (measured on spark-facilitator/20260925-1536, FLW guide doc 1yTTs9d8…):
 * plain = link text only; markdown = `[text](url)`.
 */
const ID = '1cg6eLqvVcMR0zpDLQZti8d8l2dFyGyAU';
const PLAIN = 'Then tap TAKE PICTURE. You cannot pick an old photo (Meeting photo).\n';
const MARKDOWN = `Then tap **TAKE PICTURE**. You cannot pick an old photo ([Meeting photo](https://drive.google.com/file/d/${ID}/view)).\n`;

function fakeDrive(mimeType: string, bodies: Record<string, string>) {
  const exportCalls: string[] = [];
  return {
    exportCalls,
    files: {
      get: vi.fn(async (params: any) => {
        if (params?.alt === 'media') return { data: bodies['media'] };
        return { data: { mimeType, name: 'x', version: '1' } };
      }),
      export: vi.fn(async (params: any) => {
        exportCalls.push(params.mimeType);
        return { data: bodies[params.mimeType] };
      }),
    },
  };
}

describe('readPublishedForCaptionBacking (ace#2492)', () => {
  it('the premise: a plain export of a Doc carries no citable id', () => {
    expect(extractCitedFileIds(PLAIN)).toEqual([]);
    expect(extractCitedFileIds(MARKDOWN)).toEqual([ID]);
  });

  it('re-reads a prose Google Doc as markdown so link targets survive', async () => {
    const fake = fakeDrive('application/vnd.google-apps.document', {
      'text/plain': PLAIN,
      'text/markdown': MARKDOWN,
    });
    const text = await readPublishedForCaptionBacking('doc', fake as any, { sleep: async () => {} });
    expect(extractCitedFileIds(text)).toEqual([ID]);
    expect(fake.exportCalls).toEqual(['text/plain', 'text/markdown']);
  });

  it('keeps the plain read for a Doc that parses as a deck spec (markdown export would escape the YAML)', async () => {
    const spec = [
      'manifest:',
      '  opp:',
      `    photo: https://drive.google.com/uc?export=view&id=${ID}`,
      'modules:',
      '  - slides:',
      '      - layout: image',
      '        image: "@photo"',
      '',
    ].join('\n');
    const fake = fakeDrive('application/vnd.google-apps.document', { 'text/plain': spec });
    const text = await readPublishedForCaptionBacking('spec', fake as any, { sleep: async () => {} });
    expect(text).toBe(spec);
    expect(fake.exportCalls).toEqual(['text/plain']);
  });

  it('reads a non-Doc (text/yaml deck spec) as bytes, once', async () => {
    const fake = fakeDrive('text/yaml', { media: 'slides: []\n' });
    const text = await readPublishedForCaptionBacking('y', fake as any, { sleep: async () => {} });
    expect(text).toBe('slides: []\n');
    expect(fake.exportCalls).toEqual([]);
  });
});
