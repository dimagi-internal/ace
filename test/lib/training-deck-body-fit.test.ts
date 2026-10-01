/**
 * Slide 53 of spark-facilitator/20260926-1800 — "Learn More About Connect" —
 * failed the render eval's hard gate: its body text printed OVER its title.
 *
 * Mechanism, read off the rendered slide and the stencil geometry: the body
 * carried four bare ~90-character help-site URLs; each wrapped onto a second
 * line mid-word (~18 lines at 16pt ≈ 330pt) in a middle-anchored frame 274pt
 * tall, so the block grew past BOTH edges and its first line landed on the
 * title band. The spec passed every formatting budget (it was 583 chars, 9
 * non-empty lines — under 700 / 9), because no budget measured HEIGHT.
 *
 * Fixed twice over, and both halves are pinned here against the real slide
 * (`test/fixtures/training-deck/spark-20260926-1800/training-deck-spec.yaml`):
 *   - URLs render as LINK TEXT (`renderBodyText`), with the URL attached to
 *     the label by the renderer;
 *   - `lintDeckFormatting` measures the rendered body's height against the
 *     stencil's own frame (`bodyFit`) and `parseTrainingSpec` refuses an
 *     overflow — so the next way a body outgrows its frame fails at generate
 *     time, not in front of a room.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  TrainingDeckSpecSchema,
  bodyFit,
  buildSlidesRequestsV2,
  lintDeckFormatting,
  parseTrainingSpec,
  renderBodyText,
  shortLinkLabel,
  STENCILS,
  resolveManifest,
  type TrainingDeckSpec,
  type StencilKey,
} from '../../lib/training-deck-spec';
import { estimateTextHeightPt } from '../../lib/deck-visual-checks';
import {
  SLIDE_H,
  SLIDE_W,
  WALKTHROUGH_IMAGE,
  MIN_PHONE_HEIGHT_FRAC,
  PHONE_ASPECT,
  CHROME,
  buildWalkthroughTextBoxes,
  BODY_PT,
} from '../../lib/training-deck-stencil-geometry';

const FIX = join(__dirname, '../fixtures/training-deck/spark-20260926-1800');
const SPEC: TrainingDeckSpec = TrainingDeckSpecSchema.parse(yaml.load(readFileSync(join(FIX, 'training-deck-spec.yaml'), 'utf8')));
const slide = (id: string) => SPEC.modules.flatMap((m) => m.slides).find((s) => s.id === id)!;
const LEARN_MORE = slide('learn-more') as { id: string; layout: 'content'; title: string; body: string };

describe('slide 53 — the overlap the eval failed', () => {
  it('as it SHIPPED (raw URLs) the body needs more height than its frame has', () => {
    const fit = bodyFit(LEARN_MORE)!;
    // What the old renderer wrote: the body verbatim.
    const rawPt = estimateTextHeightPt(LEARN_MORE.body, BODY_PT, (SLIDE_W - 2 * 457_200) / 12_700);
    expect(rawPt).toBeGreaterThan(fit.boxPt);
  });

  it('rendered as link text it fits, with every URL attached to its label', () => {
    const fit = bodyFit(LEARN_MORE)!;
    expect(fit.neededPt).toBeLessThan(fit.boxPt);
    const { text, links } = renderBodyText(LEARN_MORE.body);
    expect(text).not.toMatch(/https?:\/\//);
    expect(links).toHaveLength(4);
    expect(text.slice(links[1].start, links[1].end)).toBe('Connect Mobile Application');
    expect(links[1].url).toBe('https://dimagi.atlassian.net/wiki/spaces/connectpublic/pages/3146907771/Connect+Mobile+Application');
  });

  it('the render styles each label as a link on the slide\'s own body frame', () => {
    const one: TrainingDeckSpec = { ...SPEC, modules: [{ id: 'resources', title: 'r', slides: [LEARN_MORE] }] };
    const reqs = buildSlidesRequestsV2(one, {
      stencils: STENCILS as unknown as Record<StencilKey, string>,
      manifest: resolveManifest(SPEC.manifest),
    });
    const dup = reqs.find((r: any) => r.duplicateObject) as any;
    // The body frame's copy is NAMED, so the link styling below can find it.
    expect(dup.duplicateObject.objectIds).toEqual({
      ace_stencil_content_v2: 'ace_slide_1',
      ace_stencil_content_v2_body: 'ace_slide_1_body',
    });
    const linkStyles = reqs.filter((r: any) => r.updateTextStyle?.style?.link) as any[];
    expect(linkStyles).toHaveLength(4);
    expect(linkStyles.every((r) => r.updateTextStyle.objectId === 'ace_slide_1_body')).toBe(true);
    const body = reqs.find((r: any) => r.replaceAllText?.containsText?.text === '{{BODY}}') as any;
    expect(body.replaceAllText.replaceText).toContain('Setting up your account: ConnectID Signup');
  });

  it('a slide with no link does not name a child (the duplicate is unchanged)', () => {
    const plain = slide('opp-overview');
    const reqs = buildSlidesRequestsV2({ ...SPEC, modules: [{ id: 'x', title: 'x', slides: [plain] }] }, {
      stencils: STENCILS as unknown as Record<StencilKey, string>,
      manifest: resolveManifest(SPEC.manifest),
    });
    expect((reqs.find((r: any) => r.duplicateObject) as any).duplicateObject.objectIds).toEqual({
      ace_stencil_content_v2: 'ace_slide_1',
    });
  });
});

describe('bodyFit as a formatting budget', () => {
  it('every slide of the real deck fits its frame once links render as labels', () => {
    expect(lintDeckFormatting(SPEC).filter((f) => f.rule === 'bodyFit')).toEqual([]);
  });

  it('REFUSES a body taller than its frame — the real verify / review / safety slides crammed onto one', () => {
    // A generator that merges slides instead of splitting them: each body is
    // real, each fits alone, together they cannot.
    const crammed = {
      id: 'crammed',
      layout: 'content' as const,
      title: 'Verify, Review and Safety',
      body: ['verify-rules', 'verify-review', 'safety-ethics'].map((id) => (slide(id) as { body: string }).body).join('\n\n'),
    };
    const spec = { ...SPEC, modules: [{ id: 'x', title: 'x', slides: [crammed] }] };
    const findings = lintDeckFormatting(spec).filter((f) => f.rule === 'bodyFit');
    expect(findings).toHaveLength(1);
    expect(() => parseTrainingSpec(yaml.dump(spec))).toThrow(/bodyFit/);
  });
});

describe('shortLinkLabel', () => {
  it('uses a Confluence page\'s own title, else the host', () => {
    expect(shortLinkLabel('https://dimagi.atlassian.net/wiki/spaces/connectpublic/pages/3146940710/Verify+Approve+Visits+by+a+Connect+Worker')).toBe(
      'Verify Approve Visits by a Connect Worker',
    );
    expect(shortLinkLabel('https://www.example.org/')).toBe('example.org');
  });
});

describe('walkthrough phone geometry — legible when projected', () => {
  const phoneH = Math.min(WALKTHROUGH_IMAGE.h, WALKTHROUGH_IMAGE.w / PHONE_ASPECT);

  it('a phone capture fills at least MIN_PHONE_HEIGHT_FRAC of the slide height', () => {
    // Was 4_229_100 / 5_143_500 = 0.82; the eval read slide 6's three-up at
    // ~0.54 as unreadable.
    expect(phoneH / SLIDE_H).toBeGreaterThanOrEqual(MIN_PHONE_HEIGHT_FRAC);
  });

  it('stays on the slide, clear of the walkthrough text column, the corner mark and the right rule', () => {
    const { x, y, w, h } = WALKTHROUGH_IMAGE;
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y + h).toBeLessThanOrEqual(SLIDE_H);
    const text = buildWalkthroughTextBoxes('p')
      .map((r: any) => r.createShape)
      .filter(Boolean)
      .map((s: any) => s.elementProperties.transform.translateX + s.elementProperties.size.width.magnitude);
    for (const right of text) expect(x).toBeGreaterThan(right);
    expect(x + w).toBeLessThan(CHROME.logo.x);
    expect(x + w).toBeLessThan(CHROME.rightRule.x);
  });
});
