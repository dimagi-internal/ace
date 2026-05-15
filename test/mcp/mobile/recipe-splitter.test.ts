import { describe, it, expect } from 'vitest';
import { splitRecipeAtScreenshots } from '../../../mcp/mobile/recipe-splitter.js';

describe('splitRecipeAtScreenshots', () => {
  it('returns a single chunk when the recipe has no takeScreenshot steps', () => {
    const body = `appId: x
---
- launchApp
- tapOn: "Login"
- assertVisible: "Home"
`;
    const chunks = splitRecipeAtScreenshots(body);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].screenshotName).toBeUndefined();
    expect(chunks[0].yaml).toContain('appId: x');
    expect(chunks[0].yaml).toContain('tapOn: "Login"');
  });

  it('splits at each top-level takeScreenshot, preserving the metadata header', () => {
    const body = `appId: org.commcare.dalvik
---
- launchApp
- tapOn: "Start"
- takeScreenshot: "home"
- tapOn: "Continue"
- takeScreenshot: "next"
- tapOn: "Finish"
`;
    const chunks = splitRecipeAtScreenshots(body);
    expect(chunks).toHaveLength(3);

    expect(chunks[0].screenshotName).toBe('home');
    expect(chunks[0].yaml).toContain('appId: org.commcare.dalvik');
    expect(chunks[0].yaml).toContain('takeScreenshot: "home"');
    expect(chunks[0].yaml).not.toContain('takeScreenshot: "next"');

    expect(chunks[1].screenshotName).toBe('next');
    expect(chunks[1].yaml).toContain('appId: org.commcare.dalvik');
    expect(chunks[1].yaml).toContain('takeScreenshot: "next"');
    expect(chunks[1].yaml).not.toContain('takeScreenshot: "home"');

    // Tail chunk: no screenshot name (the recipe ends with tapOn, not takeScreenshot).
    expect(chunks[2].screenshotName).toBeUndefined();
    expect(chunks[2].yaml).toContain('tapOn: "Finish"');
  });

  it('does NOT split on a takeScreenshot nested inside a runFlow.commands block', () => {
    // The nested takeScreenshot is inside the runFlow's child commands;
    // splitting there would tear the runFlow apart. The whole runFlow
    // (and its nested screenshot) stays inside the surrounding chunk.
    const body = `appId: x
---
- runFlow:
    when:
      visible: "Maybe-dialog"
    commands:
      - tapOn: "Dismiss"
      - takeScreenshot: "after-dismiss"
- tapOn: "Continue"
- takeScreenshot: "top-screenshot"
- tapOn: "Done"
`;
    const chunks = splitRecipeAtScreenshots(body);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].screenshotName).toBe('top-screenshot');
    // The nested screenshot is folded into chunk 0 along with its
    // surrounding runFlow.
    expect(chunks[0].yaml).toContain('after-dismiss');
    expect(chunks[0].yaml).toContain('top-screenshot');
    // Chunk 1 is the tail with `- tapOn: "Done"`.
    expect(chunks[1].screenshotName).toBeUndefined();
    expect(chunks[1].yaml).toContain('tapOn: "Done"');
  });

  it('accepts both quoted and unquoted screenshot names', () => {
    const body = `appId: x
---
- takeScreenshot: "double-quoted"
- tapOn: a
- takeScreenshot: 'single-quoted'
- tapOn: b
- takeScreenshot: bare-token
`;
    const chunks = splitRecipeAtScreenshots(body);
    expect(chunks.map((c) => c.screenshotName)).toEqual([
      'double-quoted',
      'single-quoted',
      'bare-token',
    ]);
  });

  it('rejects recipes with more than one top-level `---` separator', () => {
    const body = `appId: x
---
- one
---
- two
`;
    expect(() => splitRecipeAtScreenshots(body)).toThrow(/more than one `---` separator/);
  });

  it('returns a single passthrough chunk when no `---` separator exists', () => {
    // Maestro will reject this — but the splitter passes it through so
    // Maestro's own validator surfaces the error (not the splitter
    // pretending the recipe was malformed).
    const body = `appId: x\n# no separator and no flow\n`;
    const chunks = splitRecipeAtScreenshots(body);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].yaml).toBe(body);
  });

  it('preserves the header verbatim across every chunk', () => {
    const body = `appId: org.commcare.dalvik
name: my-recipe
tags:
  - smoke
  - learn
---
- tapOn: a
- takeScreenshot: s1
- tapOn: b
- takeScreenshot: s2
`;
    const chunks = splitRecipeAtScreenshots(body);
    for (const chunk of chunks) {
      expect(chunk.yaml).toContain('appId: org.commcare.dalvik');
      expect(chunk.yaml).toContain('name: my-recipe');
      expect(chunk.yaml).toContain('tags:');
      expect(chunk.yaml).toContain('  - smoke');
    }
  });

  it('assigns sequential `index` values to chunks in order', () => {
    const body = `appId: x
---
- tapOn: a
- takeScreenshot: s1
- tapOn: b
- takeScreenshot: s2
- tapOn: c
`;
    const chunks = splitRecipeAtScreenshots(body);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it('filters out empty chunks (recipe ending exactly on a screenshot)', () => {
    const body = `appId: x
---
- tapOn: a
- takeScreenshot: s1
`;
    const chunks = splitRecipeAtScreenshots(body);
    // Two physical chunks split at the screenshot, but the tail chunk
    // is empty and gets filtered.
    expect(chunks).toHaveLength(1);
    expect(chunks[0].screenshotName).toBe('s1');
  });
});
