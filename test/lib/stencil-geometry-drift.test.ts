/**
 * ace#2204: nothing compared the minted template's stencil geometry against
 * `STENCIL_TEXT_BUILDERS`, so a merged stencil fix reached no rendered deck
 * until someone re-minted, and every render check stayed green (ace#1305 re-shipped
 * for three weeks that way). Fixtures only; no live Slides call.
 */
import { describe, it, expect } from 'vitest';
import {
  expectedObjects,
  scanStencilGeometryDrift,
  formatStencilGeometryDrift,
  type LiveElement,
  type StencilPageElements,
} from '../../lib/stencil-geometry-drift.js';
import {
  STENCIL_TEXT_BUILDERS,
  COLOR_WHITE,
  COLOR_AMBER,
} from '../../lib/training-deck-stencil-geometry.js';
import { STENCILS, type StencilKey } from '../../lib/training-deck-spec.js';
import { repairDeleteIds, repairRequests } from '../../scripts/check-stencil-token-drift.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** What a freshly-minted page reads back as: the builder's requests, applied. */
function mintedPage(stencil: StencilKey): StencilPageElements {
  const pageId = STENCILS[stencil];
  const byId = new Map<string, any>();
  for (const req of STENCIL_TEXT_BUILDERS[stencil](pageId) as any[]) {
    if (req.createShape) {
      const ep = req.createShape.elementProperties;
      byId.set(req.createShape.objectId, {
        objectId: req.createShape.objectId,
        size: { width: { magnitude: ep.size.width.magnitude }, height: { magnitude: ep.size.height.magnitude } },
        transform: { ...ep.transform },
        shape: { shapeType: req.createShape.shapeType },
      });
    } else if (req.insertText) {
      const el = byId.get(req.insertText.objectId);
      el.shape.text = { textElements: [{ paragraphMarker: {} }, { textRun: { content: req.insertText.text, style: {} } }] };
    } else if (req.updateTextStyle) {
      const run = byId.get(req.updateTextStyle.objectId).shape.text.textElements[1].textRun;
      run.style = JSON.parse(JSON.stringify(req.updateTextStyle.style));
    } else if (req.updateShapeProperties?.shapeProperties?.shapeBackgroundFill) {
      byId.get(req.updateShapeProperties.objectId).shape.shapeProperties = JSON.parse(
        JSON.stringify(req.updateShapeProperties.shapeProperties),
      );
    }
  }
  // Chrome the builder does not own: must never read as drift.
  const chrome: LiveElement = {
    objectId: `${pageId}_chrome_bar`,
    size: { width: { magnitude: 68_400 }, height: { magnitude: 5_143_500 } },
    transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 },
    shape: { shapeType: 'RECTANGLE' },
  };
  return { pageId, elements: [...byId.values(), chrome] };
}

const allMinted = () => (Object.keys(STENCILS) as StencilKey[]).map(mintedPage);
const scan = (pages: StencilPageElements[]) => scanStencilGeometryDrift(pages, STENCILS, STENCIL_TEXT_BUILDERS);
const el = (pages: StencilPageElements[], id: string) =>
  pages.flatMap((p) => p.elements).find((e) => e.objectId === id) as any;

describe('scanStencilGeometryDrift (ace#2204)', () => {
  it('a freshly-minted template matches the builders on every stencil', () => {
    const r = scan(allMinted());
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.scannedPages).toBe(Object.keys(STENCILS).length);
  });

  it('catches the issue repro: two_column _rhead moved to y=1300000 and coloured navy', () => {
    const pages = allMinted();
    const rhead = el(pages, 'ace_stencil_two_column_rhead');
    rhead.transform.translateY = 1_300_000;
    rhead.shape.text.textElements[1].textRun.style.foregroundColor = {
      opaqueColor: { rgbColor: { red: 0x13 / 255, green: 0x01 / 255, blue: 0x68 / 255 } },
    };
    const r = scan(pages);
    expect(r.ok).toBe(false);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].stencil).toBe('two_column');
    expect(r.findings[0].differences.map((d) => d.kind).sort()).toEqual(['bounds', 'text-colour']);
    const bounds = r.findings[0].differences.find((d) => d.kind === 'bounds')!;
    expect(bounds.actual).toContain('y=1300000');
    expect(formatStencilGeometryDrift(r)).toContain('--repair');
  });

  it('a missing builder box, a theme colour and a changed rule fill are each drift', () => {
    const pages = allMinted();
    const content = pages.find((p) => p.pageId === STENCILS.content)!;
    const bodyId = expectedObjects(STENCIL_TEXT_BUILDERS.content(STENCILS.content))[1].objectId;
    (content as any).elements = content.elements.filter((e) => e.objectId !== bodyId);
    el(pages, 'ace_stencil_cover_title').shape.text.textElements[1].textRun.style.foregroundColor = {
      opaqueColor: { themeColor: 'DARK1' },
    };
    el(pages, 'ace_stencil_stats_stat2_rule').shape.shapeProperties.shapeBackgroundFill.solidFill.color = {
      rgbColor: COLOR_WHITE,
    };
    const kinds = Object.fromEntries(scan(pages).findings.map((f) => [f.stencil, f.differences.map((d) => d.kind)]));
    expect(kinds.content).toEqual(['missing']);
    expect(kinds.cover).toEqual(['text-colour']);
    expect(kinds.stats).toEqual(['fill-colour']);
  });

  it('within tolerance and a flipped transform are not drift', () => {
    const pages = allMinted();
    const t = el(pages, 'ace_stencil_two_column_title');
    t.transform.translateX += 5_000; // < 1pt
    // A negative scaleX with the origin moved to the far edge is the SAME box.
    const s = el(pages, 'ace_stencil_two_column_lhead');
    s.transform.translateX += s.size.width.magnitude;
    s.transform.scaleX = -1;
    expect(scan(pages).ok).toBe(true);
  });

  it('an absent stencil page is listed, not reported as geometry drift', () => {
    const pages = allMinted().filter((p) => p.pageId !== STENCILS.closing);
    const r = scan(pages);
    expect(r.ok).toBe(true);
    expect(r.absentPages).toEqual([{ stencil: 'closing', pageId: STENCILS.closing }]);
  });
});

describe('repair covers geometry drift without colliding on builder-owned rects', () => {
  it('deletes the stats amber rules too, but never chrome', () => {
    const page = mintedPage('stats');
    const textIds = page.elements.filter((e: any) => e.shape?.text).map((e) => e.objectId!);
    const ids = repairDeleteIds('stats', page.pageId, textIds, page.elements.map((e) => e.objectId!));
    expect(ids).toContain('ace_stencil_stats_stat1_rule');
    expect(ids).not.toContain('ace_stencil_stats_chrome_bar');
    // Every object the builder re-creates was deleted first: no duplicate id.
    const created = repairRequests('stats', page.pageId, ids)
      .map((r: any) => r.createShape?.objectId)
      .filter(Boolean);
    const live = new Set(page.elements.map((e) => e.objectId));
    expect(created.filter((id: string) => live.has(id) && !ids.includes(id))).toEqual([]);
  });

  it('expectedObjects reads the stats rule fill as amber', () => {
    const rule = expectedObjects(STENCIL_TEXT_BUILDERS.stats(STENCILS.stats)).find((o) =>
      o.objectId.endsWith('_stat1_rule'),
    );
    expect(rule?.fillColor).toEqual(COLOR_AMBER);
  });
});
