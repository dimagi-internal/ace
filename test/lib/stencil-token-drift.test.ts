import { describe, it, expect } from 'vitest';
import {
  scanStencilTokenDrift,
  formatStencilTokenDrift,
  extractTokens,
  type StencilPageText,
} from '../../lib/stencil-token-drift';
import { STENCILS, STENCIL_PLACEHOLDERS, type StencilKey } from '../../lib/training-deck-spec';
import {
  harvestStencilPages,
  parseArgs,
  repairRequests,
} from '../../scripts/check-stencil-token-drift';

/**
 * dimagi-internal/ace#2429 — the builder and the live Slides template are two
 * halves of one placeholder contract, kept in different places, and they drift
 * both ways. This is the scan that compares them at the point where both are in
 * hand: the copied deck, read back, versus STENCIL_PLACEHOLDERS.
 *
 * The two directions and the shipped bug for each:
 *
 *   orphaned — template has it, builder never replaces it. Renders LITERALLY.
 *              ace#2429: 13 exercise slides of poverty-graduation/20260915-1518
 *              showed a partner `{{DURATION}}`, with 0 unmatchedReplacements.
 *   missing  — builder replaces it, template lacks it. Silently DROPPED.
 *              ace#1503 / ace#2126.
 */

/** A clean deck: every stencil page carries exactly its declared tokens. */
function cleanPages(): StencilPageText[] {
  return (Object.keys(STENCILS) as StencilKey[]).map((key) => ({
    pageId: STENCILS[key],
    // One shape per token, which is how the bootstrap actually lays them out.
    texts: [...STENCIL_PLACEHOLDERS[key]].map((t) => `${t}\n`),
  }));
}

function pageFor(pages: StencilPageText[], key: StencilKey): StencilPageText {
  const page = pages.find((p) => p.pageId === STENCILS[key]);
  if (!page) throw new Error(`no page for ${key}`);
  return page;
}

/**
 * Verbatim text harvested from the LIVE template
 * (1SEm0qRjTBpYgl28OhrLkU-ZKGlKyhBWgcvoMSKpNuZQ) on 2026-09-16, before and
 * after the in-place repair. Real template content rather than a hand-typed
 * approximation of it — the shape ids and trailing newlines are what the
 * Slides API actually returned.
 */
const LIVE_EXERCISE_BEFORE = ['{{TITLE}}\n', '{{DURATION}}\n', '{{BODY}}\n'];
const LIVE_EXERCISE_AFTER = ['{{TITLE}}\n', '{{BODY}}\n'];

describe('extractTokens', () => {
  it('finds tokens that contain digits', () => {
    // The repo's other sweep is /\{\{[A-Z_]+\}\}/, which matches NONE of these
    // — and they are a third of the live contract (stats + mobile_flow).
    expect(extractTokens('{{STAT1}} {{STAT1_LABEL}} {{STEP_0_CAPTION}}')).toEqual([
      '{{STAT1}}',
      '{{STAT1_LABEL}}',
      '{{STEP_0_CAPTION}}',
    ]);
  });

  it('de-duplicates and ignores non-token braces', () => {
    expect(extractTokens('{{TITLE}} x {{TITLE}} {{lower}} {not a token}')).toEqual(['{{TITLE}}']);
  });
});

describe('scanStencilTokenDrift', () => {
  it('passes a deck whose stencils match the declared contract exactly', () => {
    const report = scanStencilTokenDrift(cleanPages(), STENCILS, STENCIL_PLACEHOLDERS);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.absentPages).toEqual([]);
    expect(report.scannedPages).toBe(Object.keys(STENCILS).length);
    expect(formatStencilTokenDrift(report)).toContain('OK');
  });

  it('flags ace#2429: a token the template carries and the builder dropped', () => {
    const pages = cleanPages();
    pageFor(pages, 'exercise').texts = LIVE_EXERCISE_BEFORE;

    const report = scanStencilTokenDrift(pages, STENCILS, STENCIL_PLACEHOLDERS);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([
      {
        stencil: 'exercise',
        pageId: 'ace_stencil_exercise',
        orphaned: ['{{DURATION}}'],
        missing: [],
      },
    ]);

    const text = formatStencilTokenDrift(report);
    expect(text).toContain('{{DURATION}}');
    expect(text).toContain('LITERALLY');
    // The remedy must name the TEMPLATE repair, not a patch of the rendered
    // deck — patching the deck is what happened on the run that filed #2429,
    // and it left the next render to reproduce the bug.
    expect(text).toContain('--repair');
  });

  it('passes the same stencil once the live template is repaired', () => {
    const pages = cleanPages();
    pageFor(pages, 'exercise').texts = LIVE_EXERCISE_AFTER;
    expect(scanStencilTokenDrift(pages, STENCILS, STENCIL_PLACEHOLDERS).ok).toBe(true);
  });

  it('flags ace#1503: a token the builder replaces and the template lacks', () => {
    const pages = cleanPages();
    // The shipped shape: the timeline stencil carries TITLE but not BODY, so
    // every timeline slide rendered a literal {{BODY}} and dropped its steps.
    pageFor(pages, 'timeline').texts = ['{{TITLE}}\n'];

    const report = scanStencilTokenDrift(pages, STENCILS, STENCIL_PLACEHOLDERS);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([
      { stencil: 'timeline', pageId: 'ace_stencil_timeline', orphaned: [], missing: ['{{BODY}}'] },
    ]);
    expect(formatStencilTokenDrift(report)).toContain('DROPPED');
  });

  it('reports both directions on one page', () => {
    const pages = cleanPages();
    pageFor(pages, 'exercise').texts = ['{{TITLE}}\n', '{{DURATION}}\n'];

    const [finding] = scanStencilTokenDrift(pages, STENCILS, STENCIL_PLACEHOLDERS).findings;
    expect(finding.orphaned).toEqual(['{{DURATION}}']);
    expect(finding.missing).toEqual(['{{BODY}}']);
  });

  it('exempts {{NOTES}}, which lives on the notes page, not the stencil body', () => {
    const pages = cleanPages();
    pageFor(pages, 'content').texts = [...LIVE_EXERCISE_AFTER, '{{NOTES}}\n'];
    expect(scanStencilTokenDrift(pages, STENCILS, STENCIL_PLACEHOLDERS).ok).toBe(true);
  });

  it('never manufactures a token by joining two adjacent shapes', () => {
    const pages = cleanPages();
    // Per-shape text is why this is safe: joined, these would read "{{TITLE}}".
    pageFor(pages, 'section').texts = ['{{TIT', 'LE}}'];
    const [finding] = scanStencilTokenDrift(pages, STENCILS, STENCIL_PLACEHOLDERS).findings;
    expect(finding.missing).toEqual(['{{TITLE}}']);
    expect(finding.orphaned).toEqual([]);
  });

  it('fails when a stencil page is missing from the deck entirely', () => {
    const report = scanStencilTokenDrift(
      cleanPages().filter((p) => p.pageId !== STENCILS.closing),
      STENCILS,
      STENCIL_PLACEHOLDERS,
    );
    expect(report.ok).toBe(false);
    expect(report.absentPages).toEqual([{ stencil: 'closing', pageId: 'ace_stencil_closing' }]);
    expect(formatStencilTokenDrift(report)).toContain('is not in the deck at all');
  });
});

describe('harvestStencilPages', () => {
  const stencilPageIds = new Set<string>(Object.values(STENCILS));

  it('concatenates textRuns so a split token is still one token', () => {
    // Slides splits a run at every style change, so a hand-edited placeholder
    // routinely arrives as several runs. Matching per-run would miss it.
    const pres = {
      data: {
        slides: [
          {
            objectId: 'ace_stencil_exercise',
            pageElements: [
              {
                objectId: 'ace_stencil_exercise_title',
                shape: {
                  text: {
                    textElements: [
                      { textRun: { content: '{{TIT' } },
                      { textRun: { content: 'LE}}\n' } },
                    ],
                  },
                },
              },
            ],
          },
        ],
      },
    };
    const { pages, textShapeIdsByPageId } = harvestStencilPages(pres, stencilPageIds);
    expect(pages).toEqual([{ pageId: 'ace_stencil_exercise', texts: ['{{TITLE}}\n'] }]);
    expect(textShapeIdsByPageId.get('ace_stencil_exercise')).toEqual([
      'ace_stencil_exercise_title',
    ]);
  });

  it('ignores non-stencil pages and non-text elements (chrome, images)', () => {
    const pres = {
      data: {
        slides: [
          { objectId: 'ace_slide_1', pageElements: [{ objectId: 'x', shape: { text: { textElements: [{ textRun: { content: '{{NOPE}}' } }] } } }] },
          {
            objectId: 'ace_stencil_closing',
            pageElements: [
              { objectId: 'ace_stencil_closing_chrome_logo', image: { contentUrl: 'https://x' } },
              { objectId: 'ace_stencil_closing_chrome_bar', shape: { shapeType: 'RECTANGLE' } },
              { objectId: 'ace_stencil_closing_title', shape: { text: { textElements: [{ textRun: { content: '{{TITLE}}\n' } }] } } },
            ],
          },
        ],
      },
    };
    const { pages, textShapeIdsByPageId } = harvestStencilPages(pres, stencilPageIds);
    expect(pages.map((p) => p.pageId)).toEqual(['ace_stencil_closing']);
    expect(pages[0].texts).toEqual(['{{TITLE}}\n']);
    // Only text-bearing shapes are repair candidates — chrome must survive.
    expect(textShapeIdsByPageId.get('ace_stencil_closing')).toEqual(['ace_stencil_closing_title']);
  });
});

describe('repairRequests', () => {
  it('deletes the drifted text shapes BEFORE re-creating the builder boxes', () => {
    const reqs = repairRequests('exercise', 'ace_stencil_exercise', [
      'ace_stencil_exercise_title',
      'ace_stencil_exercise_duration',
      'ace_stencil_exercise_body',
    ]);
    const deletes = reqs.filter((r) => 'deleteObject' in r);
    expect(deletes).toHaveLength(3);
    // Order is load-bearing: the builder re-uses `<pageId>_title` / `_body`, so
    // a create that ran first would collide with the live element.
    expect(reqs.slice(0, 3)).toEqual(deletes);
    expect(reqs.length).toBeGreaterThan(3);
  });

  it('rebuilds the exercise stencil with no duration box and a full-width title', () => {
    const reqs = repairRequests('exercise', 'ace_stencil_exercise', []);
    const json = JSON.stringify(reqs);
    expect(json).not.toContain('{{DURATION}}');
    expect(json).not.toContain('_duration');
    expect(json).toContain('{{TITLE}}');
    expect(json).toContain('{{BODY}}');
  });

  it('leaves chrome and images alone — only text-bearing shapes are deleted', () => {
    // The caller passes only text-bearing ids (see harvestStencilPages), so the
    // accent bar, right rule and corner mark survive a repair. If this ever
    // regressed, a repaired stencil would ship bare — the v5.8 failure.
    const reqs = repairRequests('exercise', 'ace_stencil_exercise', [
      'ace_stencil_exercise_duration',
    ]);
    const deleted = reqs
      .map((r) => (r as { deleteObject?: { objectId: string } }).deleteObject?.objectId)
      .filter(Boolean);
    expect(deleted).toEqual(['ace_stencil_exercise_duration']);
  });

  it('produces a page that the scanner then passes', () => {
    // Close the loop: the repair's own output, fed back through the scan, is
    // clean. A repair that satisfied the API but not the contract is the class
    // this whole module exists to catch.
    const reqs = repairRequests('exercise', 'ace_stencil_exercise', []);
    const texts = reqs
      .map((r) => (r as { insertText?: { text?: string } }).insertText?.text)
      .filter((t): t is string => typeof t === 'string');
    const pages = cleanPages();
    pageFor(pages, 'exercise').texts = texts;
    expect(scanStencilTokenDrift(pages, STENCILS, STENCIL_PLACEHOLDERS).ok).toBe(true);
  });
});

describe('parseArgs', () => {
  it('defaults the deck to ACE_TRAINING_DECK_TEMPLATE_ID', () => {
    // The operator repair command must NOT interpolate that var in the shell:
    // ACE's env is loaded into MCP subprocesses, not the calling shell, so
    // "$ACE_TRAINING_DECK_TEMPLATE_ID" expands to EMPTY in a Bash tool call and
    // would silently send an empty id (ace#1147). The script reads it itself,
    // after loadPluginEnv.
    expect(parseArgs(['--repair'], { ACE_TRAINING_DECK_TEMPLATE_ID: 'tpl-1' })).toEqual({
      deck: 'tpl-1',
      key: undefined,
      repair: true,
      json: false,
    });
  });

  it('treats --template as an alias for --deck, and an explicit id wins over env', () => {
    expect(
      parseArgs(['--template', 'tpl-2'], { ACE_TRAINING_DECK_TEMPLATE_ID: 'tpl-1' }).deck,
    ).toBe('tpl-2');
  });

  it('refuses an empty env var rather than calling Slides with no id', () => {
    expect(() => parseArgs([], { ACE_TRAINING_DECK_TEMPLATE_ID: '' })).toThrow(
      /ACE_TRAINING_DECK_TEMPLATE_ID is not/,
    );
  });

  it('rejects a flag whose value was swallowed by the next flag', () => {
    expect(() => parseArgs(['--deck', '--repair'], {})).toThrow(/missing value for --deck/);
  });
});
