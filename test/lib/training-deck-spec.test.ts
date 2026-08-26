import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  parseTrainingSpec,
  parseUnexpandedTrainingSpec,
  TrainingDeckSpecSchema,
  SlideSpecSchema,
  resolveManifest,
  normalizeDriveImageUrl,
  computeVisualCoverage,
  resolveModuleRefs,
  STENCILS,
  STENCIL_PLACEHOLDERS,
  buildSlidesRequestsV2,
  type BuildOptsV2,
  type StencilKey,
} from '../../lib/training-deck-spec.js';
import {
  STENCIL_TEXT_BUILDERS,
  COLOR_GRAY,
  MARGIN,
} from '../../lib/training-deck-stencil-geometry.js';

// ============================================================================
// YAML-based Training Deck Spec (v2) — parseTrainingSpec + Zod schemas
// ============================================================================

/** Minimal valid YAML spec used across multiple tests. */
function minimalYaml(slidesYaml = `
    - id: s1
      layout: cover
      title: Welcome
`): string {
  return `
slug: test-opp
name: Test Training
program: Test Program
archetype: atomic-visit
template_id: tmpl_abc
generated_at: "2026-05-23T00:00:00Z"
source:
  pdd_doc_id: doc_123
  run_id: run_456
manifest:
  common:
    logo: drive:logo123
voice:
  audience: flw
  estimated_duration_minutes: 15
  language: en
modules:
  - id: m1
    title: Module One
    slides:
${slidesYaml}
`;
}

describe('parseTrainingSpec', () => {
  it("accepts the partnership-pitch archetype and prospect audience", () => {
    const yaml = minimalYaml()
      .replace("archetype: atomic-visit", "archetype: partnership-pitch")
      .replace("audience: flw", "audience: prospect");
    const spec = parseTrainingSpec(yaml);
    expect(spec.archetype).toBe("partnership-pitch");
    expect(spec.voice.audience).toBe("prospect");
  });

  it('parses a minimal valid YAML spec', () => {
    const spec = parseTrainingSpec(minimalYaml());
    expect(spec.slug).toBe('test-opp');
    expect(spec.name).toBe('Test Training');
    expect(spec.program).toBe('Test Program');
    expect(spec.archetype).toBe('atomic-visit');
    expect(spec.template_id).toBe('tmpl_abc');
    expect(spec.source.pdd_doc_id).toBe('doc_123');
    expect(spec.manifest.common).toEqual({ logo: 'drive:logo123' });
    expect(spec.voice.audience).toBe('flw');
    expect(spec.voice.estimated_duration_minutes).toBe(15);
    expect(spec.modules).toHaveLength(1);
    expect(spec.modules[0].slides).toHaveLength(1);
    expect(spec.modules[0].slides[0].layout).toBe('cover');
  });

  it('rejects spec with missing required field (slug)', () => {
    const yamlStr = minimalYaml().replace('slug: test-opp\n', '');
    expect(() => parseTrainingSpec(yamlStr)).toThrow();
  });

  it('rejects slide with unknown layout', () => {
    const slidesYaml = `
    - id: s1
      layout: unknown_layout
      title: Bad Slide
`;
    expect(() => parseTrainingSpec(minimalYaml(slidesYaml))).toThrow();
  });
});

describe('SlideSpecSchema per-layout validation', () => {
  it('validates cover layout with optional fields', () => {
    const result = SlideSpecSchema.parse({
      id: 's1', layout: 'cover', title: 'Hello',
      subtitle: 'World', date: '2026-05-23',
    });
    expect(result.layout).toBe('cover');
    if (result.layout !== 'cover') throw new Error('expected cover');
    expect(result.subtitle).toBe('World');
  });

  it('validates cover layout without optional fields', () => {
    const result = SlideSpecSchema.parse({ id: 's1', layout: 'cover', title: 'Hello' });
    expect(result.layout).toBe('cover');
    if (result.layout !== 'cover') throw new Error('expected cover');
    expect(result.subtitle).toBeUndefined();
  });

  it('validates section layout', () => {
    const result = SlideSpecSchema.parse({ id: 's1', layout: 'section', title: 'Part 1' });
    expect(result.layout).toBe('section');
  });

  it('validates agenda layout', () => {
    const result = SlideSpecSchema.parse({
      id: 's1', layout: 'agenda', title: 'Agenda',
      items: [
        { label: 'Intro', duration: '5m' },
        { label: 'Demo', duration: '10m' },
      ],
    });
    expect(result.layout).toBe('agenda');
  });

  it('validates content layout', () => {
    const result = SlideSpecSchema.parse({
      id: 's1', layout: 'content', title: 'Key Points',
      body: 'Some markdown content here.',
    });
    expect(result.layout).toBe('content');
    if (result.layout !== 'content') throw new Error('expected content');
    expect(result.body).toBe('Some markdown content here.');
  });

  it('validates walkthrough layout', () => {
    const result = SlideSpecSchema.parse({
      id: 's1', layout: 'walkthrough', title: 'Step-by-step',
      image: 'drive:img1', body: 'Follow along with the screenshot.',
    });
    expect(result.layout).toBe('walkthrough');
    if (result.layout !== 'walkthrough') throw new Error('expected walkthrough');
    expect(result.image).toBe('drive:img1');
    expect(result.body).toBe('Follow along with the screenshot.');
  });

  it('validates mobile_flow with 2 steps (minimum)', () => {
    const result = SlideSpecSchema.parse({
      id: 's1', layout: 'mobile_flow', title: 'App Flow',
      steps: [
        { image: 'drive:a', caption: 'Step 1' },
        { image: 'drive:b', caption: 'Step 2' },
      ],
    });
    expect(result.layout).toBe('mobile_flow');
  });

  it('rejects mobile_flow with 5 steps (max is 4)', () => {
    expect(() => SlideSpecSchema.parse({
      id: 's1', layout: 'mobile_flow', title: 'App Flow',
      steps: [
        { image: 'a', caption: '1' },
        { image: 'b', caption: '2' },
        { image: 'c', caption: '3' },
        { image: 'd', caption: '4' },
        { image: 'e', caption: '5' },
      ],
    })).toThrow();
  });

  it('validates web_screen layout', () => {
    const result = SlideSpecSchema.parse({
      id: 's1', layout: 'web_screen', title: 'Dashboard',
      image: 'drive:dash', caption: 'The main dashboard view',
    });
    expect(result.layout).toBe('web_screen');
    if (result.layout !== 'web_screen') throw new Error('expected web_screen');
    expect(result.caption).toBe('The main dashboard view');
  });

  it('validates web_screen layout without optional caption', () => {
    const result = SlideSpecSchema.parse({
      id: 's1', layout: 'web_screen', title: 'Dashboard',
      image: 'drive:dash',
    });
    if (result.layout !== 'web_screen') throw new Error('expected web_screen');
    expect(result.caption).toBeUndefined();
  });

  it('validates mobile_zoom layout', () => {
    const result = SlideSpecSchema.parse({
      id: 's1', layout: 'mobile_zoom', title: 'Zoom In',
      image: 'drive:zoom',
      callouts: ['Notice the sync icon', 'Tap the submit button'],
    });
    expect(result.layout).toBe('mobile_zoom');
    if (result.layout !== 'mobile_zoom') throw new Error('expected mobile_zoom');
    expect(result.callouts).toEqual(['Notice the sync icon', 'Tap the submit button']);
  });

  it('validates mobile_zoom layout without optional callouts', () => {
    const result = SlideSpecSchema.parse({
      id: 's1', layout: 'mobile_zoom', title: 'Zoom In',
      image: 'drive:zoom',
    });
    if (result.layout !== 'mobile_zoom') throw new Error('expected mobile_zoom');
    expect(result.callouts).toBeUndefined();
  });

  it('validates two_column layout', () => {
    const result = SlideSpecSchema.parse({
      id: 's1', layout: 'two_column', title: 'Comparison',
      left: { heading: 'Before', body: 'Old process', image: 'drive:before' },
      right: { heading: 'After', body: 'New process' },
    });
    expect(result.layout).toBe('two_column');
    if (result.layout !== 'two_column') throw new Error('expected two_column');
    expect(result.left.image).toBe('drive:before');
    expect(result.right.image).toBeUndefined();
  });

  it('validates stats layout with 1 stat (minimum)', () => {
    const result = SlideSpecSchema.parse({
      id: 's1', layout: 'stats', title: 'Impact',
      stats: [{ big: '95%', label: 'Completion rate' }],
    });
    expect(result.layout).toBe('stats');
  });

  it('rejects stats layout with 0 stats', () => {
    expect(() => SlideSpecSchema.parse({
      id: 's1', layout: 'stats', title: 'Impact',
      stats: [],
    })).toThrow();
  });

  it('rejects stats layout with 4 stats (max is 3)', () => {
    expect(() => SlideSpecSchema.parse({
      id: 's1', layout: 'stats', title: 'Impact',
      stats: [
        { big: '1', label: 'a' },
        { big: '2', label: 'b' },
        { big: '3', label: 'c' },
        { big: '4', label: 'd' },
      ],
    })).toThrow();
  });

  it('validates timeline layout with 2 steps (minimum)', () => {
    const result = SlideSpecSchema.parse({
      id: 's1', layout: 'timeline', title: 'Process',
      steps: [
        { label: 'Start', detail: 'Begin here' },
        { label: 'End', detail: 'Finish here' },
      ],
    });
    expect(result.layout).toBe('timeline');
  });

  it('rejects timeline layout with 1 step (min is 2)', () => {
    expect(() => SlideSpecSchema.parse({
      id: 's1', layout: 'timeline', title: 'Process',
      steps: [{ label: 'Only', detail: 'One step' }],
    })).toThrow();
  });

  it('rejects timeline layout with 6 steps (max is 5)', () => {
    expect(() => SlideSpecSchema.parse({
      id: 's1', layout: 'timeline', title: 'Process',
      steps: [
        { label: '1', detail: 'a' },
        { label: '2', detail: 'b' },
        { label: '3', detail: 'c' },
        { label: '4', detail: 'd' },
        { label: '5', detail: 'e' },
        { label: '6', detail: 'f' },
      ],
    })).toThrow();
  });

  it('validates checklist layout', () => {
    const result = SlideSpecSchema.parse({
      id: 's1', layout: 'checklist', title: 'Before You Go',
      items: ['Phone charged', 'App installed', 'ID card ready'],
    });
    expect(result.layout).toBe('checklist');
    if (result.layout !== 'checklist') throw new Error('expected checklist');
    expect(result.items).toEqual(['Phone charged', 'App installed', 'ID card ready']);
  });

  it('validates exercise layout', () => {
    const result = SlideSpecSchema.parse({
      id: 's1', layout: 'exercise', title: 'Practice',
      duration: '10 minutes',
      body: 'Open the app and register a test case.',
    });
    expect(result.layout).toBe('exercise');
    if (result.layout !== 'exercise') throw new Error('expected exercise');
    expect(result.duration).toBe('10 minutes');
  });

  it('validates closing layout', () => {
    const result = SlideSpecSchema.parse({
      id: 's1', layout: 'closing', title: 'Thank You',
      body: 'Questions? Contact support@example.com',
    });
    expect(result.layout).toBe('closing');
    if (result.layout !== 'closing') throw new Error('expected closing');
    expect(result.body).toBe('Questions? Contact support@example.com');
  });
});

// ============================================================================
// resolveManifest — manifest resolver for @alias image refs
// ============================================================================

describe('resolveManifest', () => {
  const manifest = {
    common: { logo: 'drive:1ABC', 'install-step1': 'drive:1DEF' },
    opp: { form1: 'drive:2GHI', logo: 'drive:2JKL' },
  };

  it('merges common + opp with opp winning on collision', () => {
    const resolved = resolveManifest(manifest);
    // opp's logo wins over common's logo
    expect(resolved.get('logo')).toBe('drive:2JKL');
    // common-only key is still accessible
    expect(resolved.get('install-step1')).toBe('drive:1DEF');
    // opp-only key is accessible
    expect(resolved.get('form1')).toBe('drive:2GHI');
  });

  it('resolveImageRef strips @ prefix and returns Drive URL', () => {
    const resolved = resolveManifest(manifest);
    expect(resolved.resolveImageRef('@form1')).toBe(
      'https://drive.google.com/uc?export=view&id=2GHI',
    );
    // opp wins on collision for logo
    expect(resolved.resolveImageRef('@logo')).toBe(
      'https://drive.google.com/uc?export=view&id=2JKL',
    );
  });

  it('resolveImageRef passes https:// URLs through', () => {
    const resolved = resolveManifest(manifest);
    expect(resolved.resolveImageRef('https://example.com/img.png')).toBe(
      'https://example.com/img.png',
    );
  });

  it('resolveImageRef throws for unresolvable alias', () => {
    const resolved = resolveManifest(manifest);
    expect(() => resolved.resolveImageRef('@nonexistent')).toThrow(/unresolvable/);
  });

  it('resolveImageRef returns non-drive values as-is', () => {
    const resolved = resolveManifest({
      common: { banner: 'https://cdn.example.com/banner.png' },
    });
    expect(resolved.resolveImageRef('@banner')).toBe('https://cdn.example.com/banner.png');
  });

  it('resolveImageRef converts a bare Drive fileId manifest value to a uc?export=view URL (ace#853)', () => {
    const resolved = resolveManifest({
      common: { shot: '1Enhe4EwQ_Hexy1oGW3tsWFqNYYmy-qLrIq2sc1rtoF0' },
    });
    expect(resolved.resolveImageRef('@shot')).toBe(
      'https://drive.google.com/uc?export=view&id=1Enhe4EwQ_Hexy1oGW3tsWFqNYYmy-qLrIq2sc1rtoF0',
    );
  });

  it('resolveImageRef does NOT treat short tokens or paths as bare fileIds', () => {
    const resolved = resolveManifest({
      common: { rel: 'images/banner.png', short: 'abc123' },
    });
    expect(resolved.resolveImageRef('@rel')).toBe('images/banner.png');
    expect(resolved.resolveImageRef('@short')).toBe('abc123');
  });

  it('get returns undefined for missing alias', () => {
    const resolved = resolveManifest(manifest);
    expect(resolved.get('missing')).toBeUndefined();
  });

  it('handles empty manifest (both fields undefined)', () => {
    const resolved = resolveManifest({});
    expect(resolved.get('anything')).toBeUndefined();
  });

  // #630 — Slides createImage rejects Drive share/view URLs; resolveImageRef
  // must rewrite them to the embeddable uc?export=view&id=<id> form.
  const UC = 'https://drive.google.com/uc?export=view&id=1AbC_dEf-123';
  it('resolveImageRef rewrites a raw Drive /file/d/<id>/view https URL (#630)', () => {
    const resolved = resolveManifest({});
    expect(
      resolved.resolveImageRef('https://drive.google.com/file/d/1AbC_dEf-123/view?usp=drivesdk'),
    ).toBe(UC);
  });

  it('resolveImageRef rewrites a Drive /file/d/<id>/view value behind an @alias (#630)', () => {
    const resolved = resolveManifest({
      opp: { shot: 'https://drive.google.com/file/d/1AbC_dEf-123/view' },
    });
    expect(resolved.resolveImageRef('@shot')).toBe(UC);
  });
});

describe('normalizeDriveImageUrl (#630)', () => {
  const ID = '1AbC_dEf-123';
  const UC = `https://drive.google.com/uc?export=view&id=${ID}`;

  it('rewrites /file/d/<id>/view, /edit, /preview', () => {
    expect(normalizeDriveImageUrl(`https://drive.google.com/file/d/${ID}/view?usp=drivesdk`)).toBe(UC);
    expect(normalizeDriveImageUrl(`https://drive.google.com/file/d/${ID}/edit`)).toBe(UC);
    expect(normalizeDriveImageUrl(`https://drive.google.com/file/d/${ID}/preview`)).toBe(UC);
  });

  it('rewrites open?id= and is idempotent on the uc form', () => {
    expect(normalizeDriveImageUrl(`https://drive.google.com/open?id=${ID}`)).toBe(UC);
    expect(normalizeDriveImageUrl(UC)).toBe(UC);
  });

  it('passes non-Drive URLs through unchanged', () => {
    expect(normalizeDriveImageUrl('https://example.com/x.png')).toBe('https://example.com/x.png');
    expect(normalizeDriveImageUrl('https://cdn.example.com/a/b/c.jpg')).toBe('https://cdn.example.com/a/b/c.jpg');
  });

  it('leaves an unrecognized Drive URL shape untouched', () => {
    const weird = 'https://drive.google.com/drive/folders/1XYZ';
    expect(normalizeDriveImageUrl(weird)).toBe(weird);
  });
});

// ============================================================================
// buildSlidesRequestsV2 — v2 builder for 14-stencil layouts
// ============================================================================

/** Build a full YAML spec string with the given slides YAML fragment. */
function v2Yaml(slidesYaml: string): string {
  return `
slug: test-opp
name: Test Training
program: Test Program
archetype: atomic-visit
template_id: tmpl_abc
generated_at: "2026-05-23T00:00:00Z"
source:
  pdd_doc_id: doc_123
  run_id: run_456
manifest:
  common:
    logo: drive:logo123
    screen1: drive:scr1
    screen2: drive:scr2
    screen3: drive:scr3
    screen4: drive:scr4
    zoom_img: drive:zoom1
    web_img: drive:web1
    left_img: drive:left1
    right_img: drive:right1
voice:
  audience: flw
  estimated_duration_minutes: 15
  language: en
modules:
  - id: m1
    title: Module One
    slides:
${slidesYaml}
`;
}

/** Build a BuildOptsV2 from the parsed spec, using STENCILS constant values as objectIds. */
function v2Opts(yamlStr: string): BuildOptsV2 {
  const spec = parseTrainingSpec(yamlStr);
  const stencilMap = {} as Record<StencilKey, string>;
  for (const [key, value] of Object.entries(STENCILS)) {
    stencilMap[key as StencilKey] = value;
  }
  return {
    stencils: stencilMap,
    manifest: resolveManifest(spec.manifest),
  };
}

describe('buildSlidesRequestsV2', () => {
  it('emits duplicateObject for cover stencil', () => {
    const yamlStr = v2Yaml(`
      - id: s1
        layout: cover
        title: Welcome
        subtitle: Hello
        date: "2026-05-23"
    `);
    const spec = parseTrainingSpec(yamlStr);
    const opts = v2Opts(yamlStr);
    const reqs = buildSlidesRequestsV2(spec, opts);

    const dup = reqs.find((r: any) => r.duplicateObject);
    expect(dup).toBeTruthy();
    expect((dup as any).duplicateObject.objectIds[STENCILS.cover]).toBe('ace_slide_1');
  });

  it('emits replaceAllText for content body', () => {
    const yamlStr = v2Yaml(`
      - id: s1
        layout: content
        title: Key Points
        body: "Important information here."
    `);
    const spec = parseTrainingSpec(yamlStr);
    const opts = v2Opts(yamlStr);
    const reqs = buildSlidesRequestsV2(spec, opts);

    const bodyRepl = reqs.find(
      (r: any) =>
        r.replaceAllText?.containsText.text === '{{BODY}}' &&
        r.replaceAllText?.pageObjectIds?.[0] === 'ace_slide_1',
    );
    expect(bodyRepl).toBeTruthy();
    expect((bodyRepl as any).replaceAllText.replaceText).toBe('Important information here.');
  });

  it('emits createImage for walkthrough with correct Drive URL', () => {
    const yamlStr = v2Yaml(`
      - id: s1
        layout: walkthrough
        title: Step by Step
        image: "@screen1"
        body: Follow along
    `);
    const spec = parseTrainingSpec(yamlStr);
    const opts = v2Opts(yamlStr);
    const reqs = buildSlidesRequestsV2(spec, opts);

    const img = reqs.find((r: any) => r.createImage);
    expect(img).toBeTruthy();
    expect((img as any).createImage.url).toBe(
      'https://drive.google.com/uc?export=view&id=scr1',
    );
    expect((img as any).createImage.elementProperties.pageObjectId).toBe('ace_slide_1');
    // Verify v5.3 walkthrough geometry — body widened to ~45% of the
    // slide width (vs ~35% in v5.2), so image area now starts at 4343400
    // EMU (~47.5% in) and is 4343400 wide (~47.5% of 9144000). See
    // `lib/training-deck-spec.ts` case 'walkthrough'. Earlier
    // generations: v3.2 placed the image at 3383280 (~37% in); pre-v3.2
    // at the slide midline (4572000).
    expect((img as any).createImage.elementProperties.transform.translateX).toBe(4343400);
  });

  it('emits 4 createImage for 4-step mobile_flow', () => {
    const yamlStr = v2Yaml(`
      - id: s1
        layout: mobile_flow
        title: App Flow
        steps:
          - image: "@screen1"
            caption: Step 1
          - image: "@screen2"
            caption: Step 2
          - image: "@screen3"
            caption: Step 3
          - image: "@screen4"
            caption: Step 4
    `);
    const spec = parseTrainingSpec(yamlStr);
    const opts = v2Opts(yamlStr);
    const reqs = buildSlidesRequestsV2(spec, opts);

    const imgs = reqs.filter((r: any) => r.createImage);
    expect(imgs).toHaveLength(4);
  });

  it('emits stats replacements with unused slots cleared', () => {
    const yamlStr = v2Yaml(`
      - id: s1
        layout: stats
        title: Impact
        stats:
          - big: "95%"
            label: Completion
    `);
    const spec = parseTrainingSpec(yamlStr);
    const opts = v2Opts(yamlStr);
    const reqs = buildSlidesRequestsV2(spec, opts);

    // Stat 1 should be populated
    const stat1 = reqs.find(
      (r: any) =>
        r.replaceAllText?.containsText.text === '{{STAT1}}' &&
        r.replaceAllText?.pageObjectIds?.[0] === 'ace_slide_1',
    );
    expect(stat1).toBeTruthy();
    expect((stat1 as any).replaceAllText.replaceText).toBe('95%');

    const stat1Label = reqs.find(
      (r: any) =>
        r.replaceAllText?.containsText.text === '{{STAT1_LABEL}}' &&
        r.replaceAllText?.pageObjectIds?.[0] === 'ace_slide_1',
    );
    expect(stat1Label).toBeTruthy();
    expect((stat1Label as any).replaceAllText.replaceText).toBe('Completion');

    // Stats 2 and 3 should be cleared (empty string)
    const stat2 = reqs.find(
      (r: any) =>
        r.replaceAllText?.containsText.text === '{{STAT2}}' &&
        r.replaceAllText?.pageObjectIds?.[0] === 'ace_slide_1',
    );
    expect(stat2).toBeTruthy();
    expect((stat2 as any).replaceAllText.replaceText).toBe('');

    const stat3 = reqs.find(
      (r: any) =>
        r.replaceAllText?.containsText.text === '{{STAT3}}' &&
        r.replaceAllText?.pageObjectIds?.[0] === 'ace_slide_1',
    );
    expect(stat3).toBeTruthy();
    expect((stat3 as any).replaceAllText.replaceText).toBe('');
  });

  it('emits deleteObject for all 14 stencils at the end', () => {
    const yamlStr = v2Yaml(`
      - id: s1
        layout: cover
        title: Welcome
    `);
    const spec = parseTrainingSpec(yamlStr);
    const opts = v2Opts(yamlStr);
    const reqs = buildSlidesRequestsV2(spec, opts);

    const deletes = reqs.filter((r: any) => r.deleteObject);
    expect(deletes).toHaveLength(14);

    // All 14 stencil objectIds should appear in delete requests
    const deletedIds = new Set(deletes.map((r: any) => r.deleteObject.objectId));
    for (const stencilId of Object.values(STENCILS)) {
      expect(deletedIds.has(stencilId)).toBe(true);
    }
  });

  it('emits updateSlidesPosition to reorder slides before stencil deletion', () => {
    const yamlStr = v2Yaml(`
      - id: s1
        layout: cover
        title: First
      - id: s2
        layout: content
        title: Second
        body: hi
      - id: s3
        layout: closing
        title: Third
        body: bye
    `);
    const spec = parseTrainingSpec(yamlStr);
    const opts = v2Opts(yamlStr);
    const reqs = buildSlidesRequestsV2(spec, opts);

    const reorders = reqs.filter((r: any) => r.updateSlidesPosition);
    expect(reorders).toHaveLength(3);
    expect((reorders[0] as any).updateSlidesPosition.slideObjectIds).toEqual(['ace_slide_1']);
    expect((reorders[1] as any).updateSlidesPosition.slideObjectIds).toEqual(['ace_slide_2']);
    expect((reorders[2] as any).updateSlidesPosition.slideObjectIds).toEqual(['ace_slide_3']);

    // Reorders come before deletes
    const firstReorder = reqs.findIndex((r: any) => r.updateSlidesPosition);
    const firstDelete = reqs.findIndex((r: any) => r.deleteObject);
    expect(firstReorder).toBeLessThan(firstDelete);
  });

  it('emits checklist body with checkbox characters', () => {
    const yamlStr = v2Yaml(`
      - id: s1
        layout: checklist
        title: Before You Go
        items:
          - Phone charged
          - App installed
    `);
    const spec = parseTrainingSpec(yamlStr);
    const opts = v2Opts(yamlStr);
    const reqs = buildSlidesRequestsV2(spec, opts);

    const bodyRepl = reqs.find(
      (r: any) =>
        r.replaceAllText?.containsText.text === '{{BODY}}' &&
        r.replaceAllText?.pageObjectIds?.[0] === 'ace_slide_1',
    );
    expect(bodyRepl).toBeTruthy();
    expect((bodyRepl as any).replaceAllText.replaceText).toBe(
      '☐ Phone charged\n☐ App installed',
    );
  });

  it('throws if layout has no matching stencil', () => {
    const yamlStr = v2Yaml(`
      - id: s1
        layout: content
        title: Test
        body: Test body
    `);
    const spec = parseTrainingSpec(yamlStr);
    const manifest = resolveManifest(spec.manifest);
    // Pass stencils with missing 'content' key
    const brokenStencils = { ...v2Opts(yamlStr).stencils };
    delete (brokenStencils as any).content;

    expect(() =>
      buildSlidesRequestsV2(spec, { stencils: brokenStencils as any, manifest }),
    ).toThrow(/no matching stencil/i);
  });
});

// ============================================================================
// resolveModuleRefs — load + inline _common module templates with overrides
// ============================================================================

function unexpandedYaml(modulesYaml: string): string {
  return `
slug: test-opp
name: Test Training
program: Test Program
archetype: atomic-visit
template_id: tmpl_abc
generated_at: "2026-05-25T00:00:00Z"
source:
  pdd_doc_id: doc_123
  run_id: run_456
manifest:
  common:
    logo: drive:logo123
voice:
  audience: flw
  estimated_duration_minutes: 15
  language: en
modules:
${modulesYaml}
`;
}

describe('parseUnexpandedTrainingSpec', () => {
  it('accepts spec with a ref module that ModuleSpecSchema would reject', () => {
    const yamlStr = unexpandedYaml(`
  - id: shared-intro
    ref: _common/platform-setup
    overrides:
      LLO_CONTACT: "Your manager"
`);
    const spec = parseUnexpandedTrainingSpec(yamlStr);
    expect(spec.modules).toHaveLength(1);
    const m = spec.modules[0] as { id: string; ref: string; overrides?: Record<string, string> };
    expect(m.ref).toBe('_common/platform-setup');
    expect(m.overrides?.LLO_CONTACT).toBe('Your manager');
  });

  it('accepts a mix of inline and ref modules', () => {
    const yamlStr = unexpandedYaml(`
  - id: welcome
    title: Welcome
    slides:
      - id: cover
        layout: cover
        title: Hello
  - id: shared-resources
    ref: _common/resources
`);
    const spec = parseUnexpandedTrainingSpec(yamlStr);
    expect(spec.modules).toHaveLength(2);
    expect((spec.modules[0] as { title: string }).title).toBe('Welcome');
    expect((spec.modules[1] as { ref: string }).ref).toBe('_common/resources');
  });
});

describe('resolveModuleRefs', () => {
  it('inlines a ref module from the loader', async () => {
    const yamlStr = unexpandedYaml(`
  - id: platform-setup
    ref: _common/platform-setup
`);
    const spec = parseUnexpandedTrainingSpec(yamlStr);

    const loader = async (ref: string): Promise<string> => {
      if (ref !== '_common/platform-setup') throw new Error(`unexpected ref: ${ref}`);
      return `
id: original-id
title: Connect Setup
slides:
  - id: intro
    layout: content
    title: "What is Connect?"
    body: "Connect matches you with paid work."
`;
    };

    const expanded = await resolveModuleRefs(spec, loader);
    expect(expanded.modules).toHaveLength(1);
    expect(expanded.modules[0].id).toBe('platform-setup');
    expect(expanded.modules[0].title).toBe('Connect Setup');
    expect(expanded.modules[0].slides).toHaveLength(1);
    expect(expanded.modules[0].slides[0].title).toBe('What is Connect?');
  });

  it('substitutes {{KEY}} tokens from overrides recursively', async () => {
    const yamlStr = unexpandedYaml(`
  - id: resources
    ref: _common/resources
    overrides:
      LLO_CONTACT: "Your DFHF coordinator"
      CHAT_URL: "https://chat.example.com"
`);
    const spec = parseUnexpandedTrainingSpec(yamlStr);

    const loader = async (_ref: string): Promise<string> => `
id: resources
title: Resources
slides:
  - id: help
    layout: content
    title: "Where to Get Help"
    body: "Your coordinator: {{LLO_CONTACT}}. Chat: {{CHAT_URL}}."
  - id: closing
    layout: closing
    title: "Thanks"
    body: "Talk to {{LLO_CONTACT}} for support."
`;

    const expanded = await resolveModuleRefs(spec, loader);
    const helpSlide = expanded.modules[0].slides[0] as { body: string };
    expect(helpSlide.body).toContain('Your DFHF coordinator');
    expect(helpSlide.body).toContain('https://chat.example.com');
    expect(helpSlide.body).not.toContain('{{LLO_CONTACT}}');

    const closingSlide = expanded.modules[0].slides[1] as { body: string };
    expect(closingSlide.body).toContain('Your DFHF coordinator');
  });

  it('leaves unmatched tokens in place', async () => {
    const yamlStr = unexpandedYaml(`
  - id: oops
    ref: _common/foo
    overrides:
      KNOWN: "filled"
`);
    const spec = parseUnexpandedTrainingSpec(yamlStr);

    const loader = async (_ref: string): Promise<string> => `
id: foo
title: Foo
slides:
  - id: s1
    layout: content
    title: "Known: {{KNOWN}}; Unknown: {{MISSING}}"
    body: "Just {{KNOWN}}."
`;

    const expanded = await resolveModuleRefs(spec, loader);
    const slide = expanded.modules[0].slides[0] as { title: string };
    expect(slide.title).toBe('Known: filled; Unknown: {{MISSING}}');
  });

  it('passes inline modules through unchanged', async () => {
    const yamlStr = unexpandedYaml(`
  - id: welcome
    title: Welcome
    slides:
      - id: cover
        layout: cover
        title: Hello
        subtitle: World
  - id: shared
    ref: _common/x
`);
    const spec = parseUnexpandedTrainingSpec(yamlStr);

    const loader = async (_ref: string): Promise<string> => `
id: x
title: Shared
slides:
  - id: s1
    layout: content
    title: From Template
    body: Template body
`;

    const expanded = await resolveModuleRefs(spec, loader);
    expect(expanded.modules).toHaveLength(2);
    expect(expanded.modules[0].id).toBe('welcome');
    expect(expanded.modules[0].title).toBe('Welcome');
    expect(expanded.modules[1].id).toBe('shared');
    expect(expanded.modules[1].title).toBe('Shared');
  });

  it('throws if loaded template is malformed', async () => {
    const yamlStr = unexpandedYaml(`
  - id: bad
    ref: _common/broken
`);
    const spec = parseUnexpandedTrainingSpec(yamlStr);

    const loader = async (_ref: string): Promise<string> => `
id: broken
slides:
  - id: s1
    layout: bogus
    title: Bad
`;

    await expect(resolveModuleRefs(spec, loader)).rejects.toThrow();
  });

  it('propagates loader errors', async () => {
    const yamlStr = unexpandedYaml(`
  - id: missing
    ref: _common/does-not-exist
`);
    const spec = parseUnexpandedTrainingSpec(yamlStr);

    const loader = async (ref: string): Promise<string> => {
      throw new Error(`no such template: ${ref}`);
    };

    await expect(resolveModuleRefs(spec, loader)).rejects.toThrow(/no such template/);
  });
});

// ============================================================================
// Speaker notes — schema accepts notes; builder emits {{NOTES}} replaceAllText
// ============================================================================

describe('speaker notes', () => {
  it('accepts notes on any slide layout', () => {
    const withNotes = SlideSpecSchema.parse({
      id: 's1', layout: 'content', title: 'Test', body: 'Body',
      notes: 'Speaker notes: emphasize the key word.',
    });
    expect(withNotes.layout).toBe('content');
    if (withNotes.layout !== 'content') throw new Error('expected content');
    expect(withNotes.notes).toBe('Speaker notes: emphasize the key word.');
  });

  it('treats notes as optional (existing slides without notes still parse)', () => {
    const withoutNotes = SlideSpecSchema.parse({
      id: 's1', layout: 'cover', title: 'Hello',
    });
    if (withoutNotes.layout !== 'cover') throw new Error('expected cover');
    expect(withoutNotes.notes).toBeUndefined();
  });

  it('emits replaceAllText for {{NOTES}} on notes page when slide.notes is set', () => {
    const stencils = Object.fromEntries(
      Object.entries(STENCILS).map(([k, v]) => [k, v]),
    ) as Record<StencilKey, string>;
    const manifest = resolveManifest({ common: {}, opp: {} });

    const yamlStr = minimalYaml(`
      - id: s1
        layout: content
        title: Test
        body: Body content
        notes: |
          Talking points:
          - Emphasize sync importance
          - Pause for questions
    `);
    const spec = parseTrainingSpec(yamlStr);
    const requests = buildSlidesRequestsV2(spec, { stencils, manifest });

    // Find the notes replaceAllText request
    const notesReq = requests.find(
      (r: any) =>
        r.replaceAllText?.containsText?.text === '{{NOTES}}' &&
        r.replaceAllText?.pageObjectIds?.[0]?.endsWith(':notes'),
    );
    expect(notesReq).toBeDefined();
    expect((notesReq as any).replaceAllText.replaceText).toContain('Emphasize sync importance');
    expect((notesReq as any).replaceAllText.pageObjectIds[0]).toBe('ace_slide_1:notes');
  });

  it('skips notes emission when notes is undefined or empty', () => {
    const stencils = Object.fromEntries(
      Object.entries(STENCILS).map(([k, v]) => [k, v]),
    ) as Record<StencilKey, string>;
    const manifest = resolveManifest({ common: {}, opp: {} });

    // Without notes
    const yamlStr1 = minimalYaml(`
      - id: s1
        layout: content
        title: Test
        body: Body
    `);
    const spec1 = parseTrainingSpec(yamlStr1);
    const requests1 = buildSlidesRequestsV2(spec1, { stencils, manifest });
    expect(requests1.find((r: any) => r.replaceAllText?.containsText?.text === '{{NOTES}}')).toBeUndefined();

    // With empty notes
    const yamlStr2 = minimalYaml(`
      - id: s1
        layout: content
        title: Test
        body: Body
        notes: ""
    `);
    const spec2 = parseTrainingSpec(yamlStr2);
    const requests2 = buildSlidesRequestsV2(spec2, { stencils, manifest });
    expect(requests2.find((r: any) => r.replaceAllText?.containsText?.text === '{{NOTES}}')).toBeUndefined();
  });
});

// ============================================================================
// mobile_flow caption alignment — programmatic caption boxes centered under
// each dynamically-centered phone (stencil's fixed boxes are blanked)
// ============================================================================

describe('mobile_flow caption alignment', () => {
  const PHONE_W = 1828800; // builder's phoneWidth

  /** Build requests for a mobile_flow slide with N steps. */
  function buildMobileFlow(n: number): Array<Record<string, unknown>> {
    const stepsYaml = Array.from({ length: n }, (_, i) => `
          - image: "@screen${i + 1}"
            caption: Step ${i + 1}`).join('');
    const yamlStr = v2Yaml(`
      - id: s1
        layout: mobile_flow
        title: App Flow
        steps:${stepsYaml}
    `);
    const spec = parseTrainingSpec(yamlStr);
    return buildSlidesRequestsV2(spec, v2Opts(yamlStr));
  }

  function captionShape(reqs: Array<Record<string, unknown>>, i: number): any {
    return reqs.find((r: any) => r.createShape?.objectId === `ace_slide_1_cap_${i}`);
  }

  function imageReq(reqs: Array<Record<string, unknown>>, i: number): any {
    return reqs.find((r: any) => r.createImage?.objectId === `ace_slide_1_img_${i}`);
  }

  function centerX(props: any): number {
    return props.elementProperties.transform.translateX +
      props.elementProperties.size.width.magnitude / 2;
  }

  for (const n of [2, 3, 4]) {
    it(`centers one caption box under each of ${n} phones (within 1000 EMU)`, () => {
      const reqs = buildMobileFlow(n);
      for (let i = 0; i < n; i++) {
        const cap = captionShape(reqs, i);
        const img = imageReq(reqs, i);
        expect(cap, `caption ${i}`).toBeTruthy();
        expect(img, `image ${i}`).toBeTruthy();
        const capCenter = centerX(cap.createShape);
        const imgCenter =
          img.createImage.elementProperties.transform.translateX + PHONE_W / 2;
        expect(Math.abs(capCenter - imgCenter)).toBeLessThanOrEqual(1000);
      }
      // No caption boxes beyond the step count.
      expect(captionShape(reqs, n)).toBeUndefined();
    });

    it(`blanks all four {{STEP_i_CAPTION}} stencil tokens at ${n} steps`, () => {
      const reqs = buildMobileFlow(n);
      for (let i = 0; i < 4; i++) {
        const blank = reqs.find(
          (r: any) =>
            r.replaceAllText?.containsText?.text === `{{STEP_${i}_CAPTION}}` &&
            r.replaceAllText?.pageObjectIds?.[0] === 'ace_slide_1',
        );
        expect(blank, `blank token ${i}`).toBeTruthy();
        expect((blank as any).replaceAllText.replaceText).toBe('');
      }
    });
  }

  it('styles caption boxes Work Sans 11pt gray (matching the stencil boxes)', () => {
    const reqs = buildMobileFlow(3);
    for (let i = 0; i < 3; i++) {
      const style = reqs.find(
        (r: any) => r.updateTextStyle?.objectId === `ace_slide_1_cap_${i}`,
      ) as any;
      expect(style, `style ${i}`).toBeTruthy();
      expect(style.updateTextStyle.style.fontFamily).toBe('Work Sans');
      expect(style.updateTextStyle.style.fontSize).toEqual({ magnitude: 11, unit: 'PT' });
      expect(style.updateTextStyle.style.foregroundColor.opaqueColor.rgbColor).toEqual(COLOR_GRAY);
    }
  });

  it('4-step regression: caption centers stay within 30000 EMU of the stencil grid', () => {
    // The stencil's fixed boxes sit at x = MARGIN + i*captionCol, width
    // captionCol - 50000 (buildMobileFlowTextBoxes). The programmatic boxes
    // center under each phone instead; at N=4 the two grids differ by a
    // constant 25000 EMU (~2pt) — assert the 4-up look didn't shift
    // materially (tolerance 30000 EMU ≈ 2.4pt).
    const captionCol = Math.round((9144000 - MARGIN * 2) / 4); // 2057400
    const reqs = buildMobileFlow(4);
    for (let i = 0; i < 4; i++) {
      const cap = captionShape(reqs, i);
      const oldFixedCenter = MARGIN + i * captionCol + (captionCol - 50000) / 2;
      expect(Math.abs(centerX(cap.createShape) - oldFixedCenter)).toBeLessThanOrEqual(30000);
    }
  });
});

// ============================================================================
// STENCIL_TEXT_BUILDERS — the canonical per-stencil geometry map
// ============================================================================

describe('STENCIL_TEXT_BUILDERS', () => {
  it('has exactly the 14 StencilKeys', () => {
    expect(Object.keys(STENCIL_TEXT_BUILDERS).sort()).toEqual(
      Object.keys(STENCILS).sort(),
    );
    expect(Object.keys(STENCIL_TEXT_BUILDERS)).toHaveLength(14);
  });

  it('each builder returns requests including a createShape whose objectId starts with the pageId', () => {
    for (const [key, builder] of Object.entries(STENCIL_TEXT_BUILDERS)) {
      const pageId = `test_page_${key}`;
      const reqs = builder(pageId);
      expect(reqs.length, key).toBeGreaterThan(0);
      const shapes = reqs.filter((r: any) => r.createShape);
      expect(shapes.length, key).toBeGreaterThan(0);
      for (const s of shapes as any[]) {
        expect(s.createShape.objectId.startsWith(pageId), `${key}: ${s.createShape.objectId}`).toBe(true);
        expect(s.createShape.elementProperties.pageObjectId).toBe(pageId);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Regression: the shipped spec skeleton must itself be schema-shaped.
//
// dimagi-internal/ace#1049 — `spec.template.yaml` carried scalar, quoted
// placeholders for three fields the schema requires to be non-strings
// (`manifest.common`/`opp` maps, `estimated_duration_minutes` number, agenda
// `items` objects). The skeleton is the generator's worked example, so it
// actively taught the wrong shape; specs filled from it failed parse only at
// RENDER time, leaving Phase 6 with no deck and a failing products fence.
// ---------------------------------------------------------------------------
describe('spec.template.yaml skeleton shape (ace#1049)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const skeletonPath = path.join(
    here,
    '../../templates/training-deck/connect-training-atomic/spec.template.yaml',
  );
  const raw = fs.readFileSync(skeletonPath, 'utf8');
  const doc = YAML.parse(raw) as any;

  it('declares manifest.common and manifest.opp as maps, not scalars', () => {
    expect(typeof doc.manifest.common).toBe('object');
    expect(Array.isArray(doc.manifest.common)).toBe(false);
    expect(typeof doc.manifest.opp).toBe('object');
    expect(Array.isArray(doc.manifest.opp)).toBe(false);
  });

  it('declares estimated_duration_minutes as a number, not a quoted string', () => {
    expect(typeof doc.voice.estimated_duration_minutes).toBe('number');
  });

  it('declares agenda items as {label, duration} objects, not bare strings', () => {
    const welcome = doc.modules.find((m: any) => m.id === 'welcome');
    const agenda = welcome.slides.find((s: any) => s.layout === 'agenda');
    expect(Array.isArray(agenda.items)).toBe(true);
    expect(agenda.items.length).toBeGreaterThan(0);
    for (const item of agenda.items) {
      expect(typeof item).toBe('object');
      expect(typeof item.label).toBe('string');
      expect(typeof item.duration).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Visual coverage — dimagi-internal/ace#856 / #873
// ---------------------------------------------------------------------------

describe('computeVisualCoverage', () => {
  const mod = (slides: any[]) => ({ id: 'm', title: 'M', slides });

  it('THE REGRESSION: a hollow deck reads 0, not 100%', () => {
    // hh-poverty-targeting/20260702-1456, reconstructed. The invite was wedged
    // server-side (#855) so ZERO per-opp screenshots were capturable. Generate
    // downgraded all 6 Deliver walkthrough slides to `content` layout and
    // shipped the 4 pool-backed platform-setup images.
    //
    // Emitted-slot arithmetic on that deck: 4 images in 4 image slots = 1.0.
    // It scored 9.5 "visually spot-checked" and was emailed to the operator,
    // who opened it and said "almost nothing in it". True opp coverage: 0/6.
    //
    // This assertion is the whole point of taking the denominator from the app
    // summaries instead of from what the deck emitted.
    const spec = {
      manifest: {
        common: {
          'play-store-search': 'f1',
          'commcare-install': 'f2',
          'commcare-open': 'f3',
          'commcare-welcome': 'f4',
        },
        opp: {},
      },
      modules: [
        mod([
          {
            id: 'install',
            layout: 'mobile_flow',
            title: 'Download CommCare',
            steps: [
              { image: '@play-store-search', caption: 'a' },
              { image: '@commcare-install', caption: 'b' },
              { image: '@commcare-open', caption: 'c' },
              { image: '@commcare-welcome', caption: 'd' },
            ],
          },
          // The six downgraded slides. Schematically indistinguishable from
          // slides that were always meant to be text-only — which is exactly
          // why they cannot be the denominator.
          ...Array.from({ length: 6 }, (_, i) => ({
            id: `deliver-${i}`,
            layout: 'content',
            title: `Deliver step ${i + 1}`,
            body: 'Text stood in for the screen.',
          })),
        ]),
      ],
    } as any;

    const cov = computeVisualCoverage(spec, { expectedOppVisualSlides: 6 });
    expect(cov.ratio).toBe(0);
    expect(cov.filled).toBe(0);
    expect(cov.expected).toBe(6);
    // The pool images ARE there — reported, never gated on.
    expect(cov.pool_filled).toBe(4);
  });

  it('counts only per-opp captures in the numerator', () => {
    const spec = {
      manifest: { common: { 'connect-home': 'c1' }, opp: { 'journey-deliver-1': 'o1' } },
      modules: [
        mod([
          { id: 'a', layout: 'walkthrough', title: 'A', image: '@journey-deliver-1', body: 'b' },
          { id: 'b', layout: 'walkthrough', title: 'B', image: '@connect-home', body: 'b' },
        ]),
      ],
    } as any;
    const cov = computeVisualCoverage(spec, { expectedOppVisualSlides: 2 });
    expect(cov.filled).toBe(1);
    expect(cov.pool_filled).toBe(1);
    expect(cov.ratio).toBe(0.5);
  });

  it('template artwork never enters the ratio (#873)', () => {
    // The PersonalID completion half is committed deck-template art, not a
    // capture. A gate that counted it would fire on 100% of runs forever,
    // because those surfaces are structurally uncapturable with the demo user.
    const spec = {
      manifest: {
        template: { 'personal-id-photo': 't1', 'personal-id-done': 't2' },
        opp: { 'journey-deliver-1': 'o1' },
      },
      modules: [
        mod([
          {
            id: 'pid',
            layout: 'mobile_flow',
            title: 'Complete Your Profile',
            steps: [
              { image: '@personal-id-photo', caption: 'a' },
              { image: '@personal-id-done', caption: 'b' },
            ],
          },
          { id: 'd', layout: 'walkthrough', title: 'D', image: '@journey-deliver-1', body: 'b' },
        ]),
      ],
    } as any;
    const cov = computeVisualCoverage(spec, { expectedOppVisualSlides: 1 });
    expect(cov.template_filled).toBe(2);
    expect(cov.filled).toBe(1);
    expect(cov.ratio).toBe(1);
  });

  it('counts every image-bearing layout, including both two_column halves', () => {
    const spec = {
      manifest: { opp: { a: '1', b: '2', c: '3', d: '4', e: '5' } },
      modules: [
        mod([
          { id: '1', layout: 'walkthrough', title: 'T', image: '@a', body: 'x' },
          { id: '2', layout: 'web_screen', title: 'T', image: '@b' },
          { id: '3', layout: 'mobile_zoom', title: 'T', image: '@c' },
          {
            id: '4',
            layout: 'two_column',
            title: 'T',
            left: { heading: 'L', body: 'x', image: '@d' },
            right: { heading: 'R', body: 'y', image: '@e' },
          },
        ]),
      ],
    } as any;
    const cov = computeVisualCoverage(spec, { expectedOppVisualSlides: 5 });
    expect(cov.filled).toBe(5);
    expect(cov.ratio).toBe(1);
  });

  it('a two_column half with no image contributes nothing', () => {
    const spec = {
      manifest: { opp: { a: '1' } },
      modules: [
        mod([
          {
            id: '1',
            layout: 'two_column',
            title: 'T',
            left: { heading: 'L', body: 'x', image: '@a' },
            right: { heading: 'R', body: 'y' },
          },
        ]),
      ],
    } as any;
    const cov = computeVisualCoverage(spec, { expectedOppVisualSlides: 2 });
    expect(cov.filled).toBe(1);
    expect(cov.ratio).toBe(0.5);
  });

  it('an unresolvable alias counts in no bucket', () => {
    const spec = {
      manifest: { opp: {} },
      modules: [mod([{ id: '1', layout: 'walkthrough', title: 'T', image: '@ghost', body: 'x' }])],
    } as any;
    const cov = computeVisualCoverage(spec, { expectedOppVisualSlides: 1 });
    expect(cov.filled).toBe(0);
    expect(cov.pool_filled).toBe(0);
    expect(cov.template_filled).toBe(0);
  });

  it('expecting nothing is vacuously complete, not a divide-by-zero', () => {
    const spec = { manifest: { opp: {} }, modules: [mod([])] } as any;
    expect(computeVisualCoverage(spec, { expectedOppVisualSlides: 0 }).ratio).toBe(1);
  });

  it('reusing one capture twice cannot push coverage above 1', () => {
    const spec = {
      manifest: { opp: { a: '1' } },
      modules: [
        mod([
          { id: '1', layout: 'walkthrough', title: 'T', image: '@a', body: 'x' },
          { id: '2', layout: 'walkthrough', title: 'T', image: '@a', body: 'x' },
        ]),
      ],
    } as any;
    const cov = computeVisualCoverage(spec, { expectedOppVisualSlides: 1 });
    expect(cov.ratio).toBe(1);
    expect(cov.filled).toBe(1);
  });
});

describe('resolveManifest — template precedence (#873)', () => {
  it('opp beats common beats template', () => {
    const m = resolveManifest({
      template: { x: 'template' },
      common: { x: 'common' },
      opp: { x: 'opp' },
    });
    expect(m.get('x')).toBe('opp');
    expect(resolveManifest({ template: { x: 'template' }, common: { x: 'common' } }).get('x')).toBe(
      'common',
    );
    expect(resolveManifest({ template: { x: 'template' } }).get('x')).toBe('template');
  });
});

// ============================================================================
// Stencil / builder placeholder parity (dimagi-internal/ace#1503)
// ============================================================================

describe('stencil/builder placeholder parity (#1503)', () => {
  // One minimal-but-valid slide per layout. Image refs resolve against the
  // manifest v2Yaml() already declares.
  const SLIDE_FIXTURES: Record<string, string> = {
    cover: `- id: s1
        layout: cover
        title: T
        subtitle: S
        date: "2026-08-18"`,
    section: `- id: s1
        layout: section
        title: T`,
    agenda: `- id: s1
        layout: agenda
        title: T
        items:
          - { label: One, duration: 5m }`,
    content: `- id: s1
        layout: content
        title: T
        body: B`,
    walkthrough: `- id: s1
        layout: walkthrough
        title: T
        image: 'drive:scr1'
        body: B`,
    mobile_flow: `- id: s1
        layout: mobile_flow
        title: T
        steps:
          - { image: 'drive:scr1', caption: C1 }
          - { image: 'drive:scr2', caption: C2 }`,
    web_screen: `- id: s1
        layout: web_screen
        title: T
        image: 'drive:web1'
        caption: C`,
    mobile_zoom: `- id: s1
        layout: mobile_zoom
        title: T
        image: 'drive:zoom1'
        callouts: [A, B]`,
    two_column: `- id: s1
        layout: two_column
        title: T
        left: { heading: LH, body: LB }
        right: { heading: RH, body: RB }`,
    stats: `- id: s1
        layout: stats
        title: T
        stats:
          - { big: "90%", label: L1 }`,
    timeline: `- id: s1
        layout: timeline
        title: T
        steps:
          - { label: Day 1, detail: Arrive }
          - { label: Day 2, detail: Begin }`,
    checklist: `- id: s1
        layout: checklist
        title: T
        items: [A, B]`,
    exercise: `- id: s1
        layout: exercise
        title: T
        duration: 10m
        body: B`,
    closing: `- id: s1
        layout: closing
        title: T
        body: B`,
  };

  /** Tokens the builder targets on the SLIDE body (notes-page ones excluded). */
  function targetedTokens(layout: string): string[] {
    const yamlStr = v2Yaml('      ' + SLIDE_FIXTURES[layout]);
    const spec = parseTrainingSpec(yamlStr);
    const reqs = buildSlidesRequestsV2(spec, v2Opts(yamlStr));
    return reqs
      .filter((r: any) => r.replaceAllText)
      .filter((r: any) =>
        // {{NOTES}} lives on <pageId>:notes, not on the stencil body.
        !(r.replaceAllText.pageObjectIds ?? []).some((id: string) => id.endsWith(':notes')),
      )
      .map((r: any) => r.replaceAllText.containsText.text);
  }

  it.each(Object.keys(SLIDE_FIXTURES))(
    '%s: every token the builder targets exists on its stencil',
    (layout) => {
      const declared = new Set(STENCIL_PLACEHOLDERS[layout as StencilKey]);
      const orphans = [...new Set(targetedTokens(layout))].filter((t) => !declared.has(t));
      expect(
        orphans,
        `${layout} fills ${JSON.stringify(orphans)}, which ${STENCILS[layout as StencilKey]} ` +
          `does not contain. Those replacements are no-ops, and any stencil token left unfilled ` +
          `renders as literal text on the slide (#1503).`,
      ).toEqual([]);
    },
  );

  it('timeline fills BODY — the specific regression from #1503', () => {
    const tokens = targetedTokens('timeline');
    expect(tokens).toContain('{{BODY}}');
    expect(tokens.filter((t) => t.startsWith('{{STEP'))).toEqual([]);
  });

  it('timeline BODY carries every declared step', () => {
    const yamlStr = v2Yaml('      ' + SLIDE_FIXTURES.timeline);
    const spec = parseTrainingSpec(yamlStr);
    const reqs = buildSlidesRequestsV2(spec, v2Opts(yamlStr));
    const body = (reqs as any[]).find(
      (r) => r.replaceAllText?.containsText?.text === '{{BODY}}',
    );
    expect(body).toBeTruthy();
    expect(body.replaceAllText.replaceText).toContain('Day 1');
    expect(body.replaceAllText.replaceText).toContain('Arrive');
    expect(body.replaceAllText.replaceText).toContain('Day 2');
    expect(body.replaceAllText.replaceText).toContain('Begin');
  });

  it('every stencil key has a declared placeholder set', () => {
    expect(Object.keys(STENCIL_PLACEHOLDERS).sort()).toEqual(Object.keys(STENCILS).sort());
  });
});
