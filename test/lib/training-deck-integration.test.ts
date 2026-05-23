import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import {
  parseTrainingSpec,
  resolveManifest,
  buildSlidesRequestsV2,
  STENCILS,
  type StencilKey,
} from '../../lib/training-deck-spec.js';

describe('training-deck integration', () => {
  it('generates valid Slides requests from a full multi-module spec', () => {
    const specYaml = yaml.dump({
      slug: 'integration-test',
      name: 'Integration Test Opp',
      program: 'Test Program',
      archetype: 'atomic-visit',
      template_id: 'connect-training-atomic',
      generated_at: '2026-05-23T00:00:00Z',
      source: { pdd_doc_id: 'pdd1', run_id: 'run1' },
      manifest: {
        common: {
          'play-store-search': 'drive:common1',
          'commcare-install': 'drive:common2',
          'connect-home': 'drive:common3',
          'claim-opp': 'drive:common4',
        },
        opp: {
          'learn-m1': 'drive:opp1',
          'deliver-form': 'drive:opp2',
        },
      },
      voice: { audience: 'flw', estimated_duration_minutes: 180, language: 'en' },
      modules: [
        {
          id: 'welcome',
          title: 'Welcome',
          slides: [
            { id: 'cover', layout: 'cover', title: 'Test Opp', subtitle: 'Training', date: 'June 2026' },
            { id: 'agenda', layout: 'agenda', title: 'Agenda', items: [
              { label: 'Setup', duration: '60 min' },
              { label: 'Training', duration: '90 min' },
            ]},
          ],
        },
        {
          id: 'setup',
          title: 'Platform Setup',
          common: true,
          slides: [
            { id: 'install', layout: 'mobile_flow', title: 'Install', steps: [
              { image: '@play-store-search', caption: 'Search' },
              { image: '@commcare-install', caption: 'Install' },
              { image: '@connect-home', caption: 'Open' },
              { image: '@claim-opp', caption: 'Claim' },
            ]},
          ],
        },
        {
          id: 'opp',
          title: 'Your Opportunity',
          slides: [
            { id: 'mission', layout: 'content', title: 'What You Do', body: 'Collect samples.' },
            { id: 'targets', layout: 'stats', title: 'Targets', stats: [
              { big: '5', label: 'visits/day' },
              { big: '$23', label: 'per sample' },
            ]},
            { id: 'screen', layout: 'walkthrough', title: 'The Form', image: '@deliver-form', body: '1. Open\n2. Fill' },
          ],
        },
        {
          id: 'eval',
          title: 'Evaluation',
          slides: [
            { id: 'ready', layout: 'checklist', title: 'Ready?', items: ['Learn done', 'Form practiced'] },
            { id: 'next', layout: 'timeline', title: 'Next', steps: [
              { label: 'Today', detail: 'Training' },
              { label: 'Monday', detail: 'Go live' },
            ]},
          ],
        },
        {
          id: 'close',
          title: 'Resources',
          slides: [
            { id: 'bye', layout: 'closing', title: 'Thank You', body: 'Good luck!' },
          ],
        },
      ],
    });

    // Parse
    const spec = parseTrainingSpec(specYaml);
    expect(spec.modules).toHaveLength(5);
    const totalSlides = spec.modules.reduce((sum, m) => sum + m.slides.length, 0);
    expect(totalSlides).toBe(9);

    // Resolve manifest
    const manifest = resolveManifest(spec.manifest);

    // Build requests
    const stencilMap = Object.fromEntries(
      Object.entries(STENCILS).map(([k, v]) => [k, v]),
    ) as Record<StencilKey, string>;
    const requests = buildSlidesRequestsV2(spec, { stencils: stencilMap, manifest });

    // Verify: 9 duplicateObject (one per slide)
    const duplicates = requests.filter((r: any) => r.duplicateObject);
    expect(duplicates).toHaveLength(9);

    // Verify: 14 deleteObject (one per stencil)
    const deletes = requests.filter((r: any) => r.deleteObject);
    expect(deletes).toHaveLength(14);

    // Verify: createImage calls (4 from mobile_flow + 1 from walkthrough = 5 minimum)
    const images = requests.filter((r: any) => r.createImage);
    expect(images.length).toBeGreaterThanOrEqual(5);

    // Verify: walkthrough image resolves to correct Drive URL
    const walkthroughImg = images.find((r: any) =>
      r.createImage.url.includes('opp2'),
    );
    expect(walkthroughImg).toBeTruthy();

    // Verify: mobile_flow images resolve to correct common Drive URLs
    const commonImgs = images.filter((r: any) =>
      r.createImage.url.includes('common'),
    );
    expect(commonImgs.length).toBeGreaterThanOrEqual(4);

    // Verify: replaceAllText calls exist for various layouts
    const replaces = requests.filter((r: any) => r.replaceAllText);
    expect(replaces.length).toBeGreaterThan(20); // many placeholders across 9 slides

    // Verify: stats slide cleared unused slot
    const stat3Clear = replaces.find((r: any) =>
      r.replaceAllText.containsText?.text === '{{STAT3}}' &&
      r.replaceAllText.replaceText === '',
    );
    expect(stat3Clear).toBeTruthy();
  });
});
