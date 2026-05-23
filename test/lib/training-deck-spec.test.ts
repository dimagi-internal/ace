import { describe, it, expect } from 'vitest';
import {
  parseDeckOutline,
  buildSlidesRequests,
  buildSpeakerNotesRequests,
  STENCIL_TITLE_OBJECT_ID,
  STENCIL_CONTENT_OBJECT_ID,
  parseTrainingSpec,
  TrainingDeckSpecSchema,
  SlideSpecSchema,
  resolveManifest,
  STENCILS,
  buildSlidesRequestsV2,
  type BuildOptsV2,
  type StencilKey,
} from '../../lib/training-deck-spec.js';

const STENCILS_V1 = {
  title: STENCIL_TITLE_OBJECT_ID,
  content: STENCIL_CONTENT_OBJECT_ID,
};

describe('parseDeckOutline', () => {
  it('parses title + subtitle + slides with bullets, paragraphs, images, notes', () => {
    const md = `# Turmeric Survey FLW Training

A 5-minute walkthrough for new field workers.

---

## Slide: Welcome

Welcome to the turmeric survey program.

- You will visit ~5 markets per week
- Each visit takes ~10 minutes

> Speaker notes: Open with a smile and introduce the program.

---

## Slide: Taking the photo

![turmeric+MTN card](drive:1abcDEF)

> Speaker notes: Show the card flat next to the turmeric pile.
> Hold the phone steady for ~2 seconds.
`;
    const spec = parseDeckOutline(md);
    expect(spec.title).toBe('Turmeric Survey FLW Training');
    expect(spec.subtitle).toBe('A 5-minute walkthrough for new field workers.');
    expect(spec.slides).toHaveLength(2);

    const s1 = spec.slides[0];
    expect(s1.title).toBe('Welcome');
    expect(s1.body).toEqual([
      { kind: 'paragraph', text: 'Welcome to the turmeric survey program.' },
      { kind: 'bullets', items: ['You will visit ~5 markets per week', 'Each visit takes ~10 minutes'] },
    ]);
    expect(s1.speakerNotes).toBe('Open with a smile and introduce the program.');

    const s2 = spec.slides[1];
    expect(s2.title).toBe('Taking the photo');
    expect(s2.body).toHaveLength(1);
    expect(s2.body[0]).toEqual({
      kind: 'image',
      alt: 'turmeric+MTN card',
      ref: { kind: 'driveFileId', fileId: '1abcDEF' },
    });
    expect(s2.speakerNotes).toBe(
      'Show the card flat next to the turmeric pile.\nHold the phone steady for ~2 seconds.',
    );
  });

  it('parses image refs from HTTPS URLs as kind=url', () => {
    const md = `# Title

---

## Slide: Logo

![](https://example.com/logo.png)
`;
    const spec = parseDeckOutline(md);
    expect(spec.slides[0].body[0]).toEqual({
      kind: 'image',
      alt: '',
      ref: { kind: 'url', url: 'https://example.com/logo.png' },
    });
  });

  it('rejects markdown with no leading "# Title"', () => {
    expect(() => parseDeckOutline('## Slide: foo\nhi')).toThrow(/missing leading "# Title"/);
  });

  it('rejects a section that does not start with "## Slide:"', () => {
    expect(() =>
      parseDeckOutline(`# Deck

---

# Wrong heading
content
`),
    ).toThrow(/does not start with "## Slide:/);
  });

  it('omits empty separator-only sections', () => {
    const md = `# Deck

---

---

## Slide: Real

content
`;
    const spec = parseDeckOutline(md);
    expect(spec.slides).toHaveLength(1);
    expect(spec.slides[0].title).toBe('Real');
  });
});

describe('buildSlidesRequests (template-based)', () => {
  it('emits replaceAllText for title slide + duplicateObject + per-slide replacements', () => {
    const spec = parseDeckOutline(`# Hello Deck

Subtitle line.

---

## Slide: One

- bullet a
- bullet b

> Speaker notes: say hi
`);
    const { mainRequests, speakerNotes } = buildSlidesRequests(spec, { stencils: STENCILS_V1 });

    // First two requests: replace {{TITLE}} and {{SUBTITLE}} on the title stencil.
    expect((mainRequests[0] as any).replaceAllText.containsText.text).toBe('{{TITLE}}');
    expect((mainRequests[0] as any).replaceAllText.replaceText).toBe('Hello Deck');
    expect((mainRequests[0] as any).replaceAllText.pageObjectIds).toEqual([STENCIL_TITLE_OBJECT_ID]);

    expect((mainRequests[1] as any).replaceAllText.containsText.text).toBe('{{SUBTITLE}}');
    expect((mainRequests[1] as any).replaceAllText.replaceText).toBe('Subtitle line.');

    // Then a duplicateObject of the content stencil with our deterministic objectId.
    const dup = mainRequests.find((r: any) => r.duplicateObject);
    expect(dup).toBeTruthy();
    expect((dup as any).duplicateObject.objectIds[STENCIL_CONTENT_OBJECT_ID]).toBe('ace_slide_1');

    // Per-slide replaceAllText scoped to the duplicate.
    const titleRepl = mainRequests.find(
      (r: any) =>
        r.replaceAllText?.containsText.text === '{{TITLE}}' &&
        r.replaceAllText?.pageObjectIds?.[0] === 'ace_slide_1',
    );
    expect((titleRepl as any).replaceAllText.replaceText).toBe('One');

    const bodyRepl = mainRequests.find(
      (r: any) =>
        r.replaceAllText?.containsText.text === '{{BODY}}' &&
        r.replaceAllText?.pageObjectIds?.[0] === 'ace_slide_1',
    );
    expect((bodyRepl as any).replaceAllText.replaceText).toBe('• bullet a\n• bullet b');

    // Stencil_content gets deleted at the end.
    const del = mainRequests[mainRequests.length - 1];
    expect((del as any).deleteObject?.objectId).toBe(STENCIL_CONTENT_OBJECT_ID);

    // Speaker notes are returned separately for the second-phase batch.
    expect(speakerNotes).toEqual([{ slideObjectId: 'ace_slide_1', text: 'say hi' }]);
  });

  it('emits createImage with Drive view URL for fileId refs', () => {
    const spec = parseDeckOutline(`# X

---

## Slide: Photo

![](drive:abc123)
`);
    const { mainRequests } = buildSlidesRequests(spec, { stencils: STENCILS_V1 });
    const img = mainRequests.find((r: any) => r.createImage);
    expect((img as any).createImage.url).toBe(
      'https://drive.google.com/uc?export=view&id=abc123',
    );
    expect((img as any).createImage.elementProperties.pageObjectId).toBe('ace_slide_1');
  });

  it('passes raw HTTPS URLs through unchanged', () => {
    const spec = parseDeckOutline(`# X

---

## Slide: P

![](https://x.test/foo.png)
`);
    const { mainRequests } = buildSlidesRequests(spec, { stencils: STENCILS_V1 });
    const img = mainRequests.find((r: any) => r.createImage);
    expect((img as any).createImage.url).toBe('https://x.test/foo.png');
  });

  it('handles empty subtitle with empty replacement', () => {
    const spec = parseDeckOutline(`# Title only

---

## Slide: A

text
`);
    const { mainRequests } = buildSlidesRequests(spec, { stencils: STENCILS_V1 });
    const subRepl = mainRequests.find(
      (r: any) => r.replaceAllText?.containsText.text === '{{SUBTITLE}}',
    );
    expect((subRepl as any).replaceAllText.replaceText).toBe('');
  });
});

describe('buildSpeakerNotesRequests', () => {
  it('builds insertText against resolved speakerNotesObjectIds', () => {
    const reqs = buildSpeakerNotesRequests(
      [
        { slideObjectId: 's1', text: 'hi' },
        { slideObjectId: 's2', text: 'world' },
      ],
      { s1: 'notes_s1_obj', s2: 'notes_s2_obj' },
    );
    expect(reqs).toEqual([
      { insertText: { objectId: 'notes_s1_obj', text: 'hi', insertionIndex: 0 } },
      { insertText: { objectId: 'notes_s2_obj', text: 'world', insertionIndex: 0 } },
    ]);
  });

  it('throws if a slide has no resolved speakerNotesObjectId', () => {
    expect(() =>
      buildSpeakerNotesRequests(
        [{ slideObjectId: 'unknown', text: 'x' }],
        { s1: 'notes_s1' },
      ),
    ).toThrow(/no speakerNotesObjectId/);
  });
});

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
    expect(result.subtitle).toBe('World');
  });

  it('validates cover layout without optional fields', () => {
    const result = SlideSpecSchema.parse({ id: 's1', layout: 'cover', title: 'Hello' });
    expect(result.layout).toBe('cover');
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
    expect(result.body).toBe('Some markdown content here.');
  });

  it('validates walkthrough layout', () => {
    const result = SlideSpecSchema.parse({
      id: 's1', layout: 'walkthrough', title: 'Step-by-step',
      image: 'drive:img1', body: 'Follow along with the screenshot.',
    });
    expect(result.layout).toBe('walkthrough');
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
    expect(result.caption).toBe('The main dashboard view');
  });

  it('validates web_screen layout without optional caption', () => {
    const result = SlideSpecSchema.parse({
      id: 's1', layout: 'web_screen', title: 'Dashboard',
      image: 'drive:dash',
    });
    expect(result.caption).toBeUndefined();
  });

  it('validates mobile_zoom layout', () => {
    const result = SlideSpecSchema.parse({
      id: 's1', layout: 'mobile_zoom', title: 'Zoom In',
      image: 'drive:zoom',
      callouts: ['Notice the sync icon', 'Tap the submit button'],
    });
    expect(result.layout).toBe('mobile_zoom');
    expect(result.callouts).toEqual(['Notice the sync icon', 'Tap the submit button']);
  });

  it('validates mobile_zoom layout without optional callouts', () => {
    const result = SlideSpecSchema.parse({
      id: 's1', layout: 'mobile_zoom', title: 'Zoom In',
      image: 'drive:zoom',
    });
    expect(result.callouts).toBeUndefined();
  });

  it('validates two_column layout', () => {
    const result = SlideSpecSchema.parse({
      id: 's1', layout: 'two_column', title: 'Comparison',
      left: { heading: 'Before', body: 'Old process', image: 'drive:before' },
      right: { heading: 'After', body: 'New process' },
    });
    expect(result.layout).toBe('two_column');
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
    expect(result.items).toEqual(['Phone charged', 'App installed', 'ID card ready']);
  });

  it('validates exercise layout', () => {
    const result = SlideSpecSchema.parse({
      id: 's1', layout: 'exercise', title: 'Practice',
      duration: '10 minutes',
      body: 'Open the app and register a test case.',
    });
    expect(result.layout).toBe('exercise');
    expect(result.duration).toBe('10 minutes');
  });

  it('validates closing layout', () => {
    const result = SlideSpecSchema.parse({
      id: 's1', layout: 'closing', title: 'Thank You',
      body: 'Questions? Contact support@example.com',
    });
    expect(result.layout).toBe('closing');
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

  it('get returns undefined for missing alias', () => {
    const resolved = resolveManifest(manifest);
    expect(resolved.get('missing')).toBeUndefined();
  });

  it('handles empty manifest (both fields undefined)', () => {
    const resolved = resolveManifest({});
    expect(resolved.get('anything')).toBeUndefined();
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
    // Verify right-half positioning
    expect((img as any).createImage.elementProperties.transform.translateX).toBe(4572000);
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
