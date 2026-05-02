import { describe, it, expect } from 'vitest';
import {
  parseDeckOutline,
  buildSlidesRequests,
  buildSpeakerNotesRequests,
  STENCIL_TITLE_OBJECT_ID,
  STENCIL_CONTENT_OBJECT_ID,
} from '../../lib/training-deck-spec.js';

const STENCILS = {
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
    const { mainRequests, speakerNotes } = buildSlidesRequests(spec, { stencils: STENCILS });

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
    const { mainRequests } = buildSlidesRequests(spec, { stencils: STENCILS });
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
    const { mainRequests } = buildSlidesRequests(spec, { stencils: STENCILS });
    const img = mainRequests.find((r: any) => r.createImage);
    expect((img as any).createImage.url).toBe('https://x.test/foo.png');
  });

  it('handles empty subtitle with empty replacement', () => {
    const spec = parseDeckOutline(`# Title only

---

## Slide: A

text
`);
    const { mainRequests } = buildSlidesRequests(spec, { stencils: STENCILS });
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
