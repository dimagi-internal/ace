import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { parseAllDocuments } from 'yaml';
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

// Static-palette paths resolved relative to this test file (not process
// cwd) to match the convention already used by sibling suites in this
// directory (client.test.ts, static-palette-health.test.ts, etc.) — a
// bare 'mcp/mobile/recipes/static/' string only works when vitest's cwd
// is the repo root, which isn't guaranteed.
const STATIC = new URL('../../../mcp/mobile/recipes/static/', import.meta.url);
const windows = (body: string, opts?: { captureAllBoundaries?: boolean }) =>
  splitRecipeAtScreenshots(body, opts).filter((c) => c.screenshotName).length;

describe('recipe-splitter — default path is unchanged (regression guard)', () => {
  it('keeps today window counts when the mode is off', () => {
    expect(windows(readFileSync(new URL('connect-claim-opp.yaml', STATIC), 'utf8'))).toBe(3);
    expect(windows(readFileSync(new URL('deliver-launch.yaml', STATIC), 'utf8'))).toBe(1);
  });
});

describe('recipe-splitter — captureAllBoundaries', () => {
  const opts = { captureAllBoundaries: true };

  it('opens a window at every top-level runFlow boundary', () => {
    // Two effects collapse the naive "2 windows per runFlow" count:
    //
    // 1. Adjacent top-level runFlows (no other top-level step between
    //    them) share ONE window at their seam rather than an
    //    independent -post for the first plus an empty -pre for the
    //    second — see the module-level doc comment on
    //    SplitOptions.captureAllBoundaries for why.
    // 2. The very first top-level step in each of these two recipes is
    //    itself a runFlow, preceded only by comment lines (no real
    //    step) — see each file's `---` separator onward. A `-pre`
    //    window there would finalize a chunk with ZERO actual steps
    //    (comments parse to nothing), which is exactly the empty-flow
    //    case this option must never produce (see the next test). So
    //    the first top-level step's `-pre` is suppressed unconditionally,
    //    and its preamble folds into that runFlow's own `-post` chunk
    //    instead.
    //
    // connect-claim-opp.yaml: 5 top-level runFlows, 2 adjacent pairs (2
    // seams collapse) + 1 suppressed leading `-pre` → 3 existing
    // takeScreenshot windows + 7 runFlow windows = 10.
    // deliver-launch.yaml: 5 top-level runFlows, one run of 3
    // back-to-back (2 internal seams collapse) + 1 suppressed leading
    // `-pre` → 1 existing takeScreenshot window + 7 runFlow windows = 8.
    //
    // deliver-launch dropped from 9 → 8 in ace#869, which removed the
    // already-installed-home branch runFlow (one fewer top-level runFlow,
    // and its removal SHORTENS the back-to-back run from 4 to 3, so one
    // collapsed seam disappears with it). The default-path count is
    // unchanged at 1 — the removed shot was nested inside a runFlow and
    // was never its own window.
    //
    // Verified by running, not by re-deriving the arithmetic — a prior
    // round of this task asserted 13/13, then a corrected 11/10, both of
    // which turned out wrong on inspection (13/13 assumed no adjacency
    // collapsing at all; 11/10 additionally missed that BOTH recipes'
    // very first runFlow is preceded only by comments, so its `-pre`
    // window is itself an empty-flow chunk that the "never emits an
    // empty flow section" test below independently catches). These are
    // the numbers that actually come out of running the splitter with
    // an implementation that also passes that test.
    expect(windows(readFileSync(new URL('connect-claim-opp.yaml', STATIC), 'utf8'), opts)).toBe(
      10,
    );
    expect(windows(readFileSync(new URL('deliver-launch.yaml', STATIC), 'utf8'), opts)).toBe(8);
  });

  it('never emits a chunk with an empty flow section', () => {
    // The invariant that actually matters: no chunk should be a bare
    // header + `---` with zero steps. An empty-flow chunk is (a) a
    // possible hard failure — runRecipeWithDumps treats any non-zero
    // maestro exit as fatal and aborts every remaining chunk, and an
    // empty flow document may not even be valid to `maestro test`; (b)
    // zero diagnostic value even if Maestro tolerates it — nothing runs
    // between two back-to-back runFlows, so a second dump there would
    // just duplicate the screen the first one already captured; and (c)
    // a full `maestro test` startup spent on nothing, the exact expense
    // this option exists to spend deliberately. This is the guard that
    // stops the merged-boundary rule from regressing back into emitting
    // these (e.g. by someone "fixing" the count by un-merging).
    for (const file of ['connect-claim-opp.yaml', 'deliver-launch.yaml']) {
      const chunks = splitRecipeAtScreenshots(readFileSync(new URL(file, STATIC), 'utf8'), opts);
      for (const c of chunks) {
        const docs = parseAllDocuments(c.yaml);
        const flowDoc = docs[1];
        const flow = flowDoc?.toJSON();
        expect(
          Array.isArray(flow) && flow.length > 0,
          `${file} chunk ${c.index} (${c.screenshotName ?? 'unnamed'}) has an empty flow section`,
        ).toBe(true);
      }
    }
  });

  it('never splits inside a runFlow.commands block', () => {
    // The brief's sketch checked this via a regex head-count (`^- runFlow:`
    // opens vs `^\s+commands:` closes, asserting closes <= opens + 1).
    // That heuristic assumes each top-level runFlow has exactly one
    // `commands:` block, which is false for this real palette: several
    // top-level runFlows here contain their OWN nested `runFlow.commands`
    // sub-blocks for multi-branch resume logic (e.g.
    // connect-claim-opp.yaml's "BRANCH A" resume handler at line ~250,
    // which nests two further runFlow/commands pairs for its own
    // sub-branches). That's legitimate content, not a mid-block split —
    // the regex-count heuristic false-positives on it.
    //
    // The property we actually care about — "a chunk boundary never
    // lands inside an indented block" — is verified directly and more
    // rigorously here: every chunk must parse as valid YAML. Splitting
    // mid-`commands:` block would truncate a nested sequence/mapping and
    // produce a parse error; splitting only between top-level `-`
    // entries (which is all `splitRecipeAtScreenshots` ever does) always
    // yields a structurally complete document.
    const chunks = splitRecipeAtScreenshots(
      readFileSync(new URL('connect-claim-opp.yaml', STATIC), 'utf8'),
      opts,
    );
    for (const c of chunks) {
      const docs = parseAllDocuments(c.yaml);
      for (const doc of docs) {
        expect(doc.errors, `chunk ${c.index} (${c.screenshotName ?? 'unnamed'}) parse errors`).toEqual(
          [],
        );
      }
    }
  });

  it('produces deterministic, collision-free boundary names', () => {
    const names = splitRecipeAtScreenshots(
      readFileSync(new URL('deliver-launch.yaml', STATIC), 'utf8'),
      opts,
    )
      .map((c) => c.screenshotName)
      .filter(Boolean) as string[];
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((n) => /^branch\d+-pre$/.test(n))).toBe(true);
    // No name may start with a hyphen — `<screenshotName>.xml` becomes a
    // literal filename (captureUiDump in backends/maestro.ts), and a
    // leading `-` there reads as a CLI flag to every shell tool.
    for (const n of names) expect(n.startsWith('-')).toBe(false);
  });
});
