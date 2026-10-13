// ace#2885 — labs draws a report's body in the /labs/sandbox/render/ iframe
// (dimagi-internal/connect-labs#2449, #2466, #2470). On
// smallholder-seasonal/20261012-1549 scene 1's wait_for missed on the first
// render because canopy's recorder resolves targets on the TOP page, and the
// narrated-figure checks read only the top page's 270 characters of text.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LABS_SANDBOX_FRAME_PREFIX,
  checkLabsReportFrameTargets,
  combineFrameTexts,
  inLabsReportFrame,
  isInLabsReportFrame,
  isLabsReportSurface,
  recorderTargetToSelector,
} from '../../lib/labs-report-frame';
import { checkSceneActions, type DddScene } from '../../lib/ddd-scene-actions';
import { checkNarratedFiguresAgainstScreenText, type NarratedScene } from '../../lib/narration-on-screen';

const ROOT = join(__dirname, '../..');
const FIXTURE = join(ROOT, 'test/fixtures/demo-arc/spark-facilitator-20261004-1706-spec.json');
const FRAME = 'iframe[src*="/labs/sandbox/render/"] >> internal:control=enter-frame >> ';

describe('inLabsReportFrame', () => {
  it('uses the exact prefix the DDD agent fixed smallholder-seasonal/20261012-1549 with', () => {
    expect(LABS_SANDBOX_FRAME_PREFIX).toBe(FRAME);
  });

  it('rewrites each recorder prefix into a css: chain that enters the frame', () => {
    expect(inLabsReportFrame('css:tr:has-text("Kuunika")')).toBe(`css:${FRAME}tr:has-text("Kuunika")`);
    expect(inLabsReportFrame('role:tab:Benchmarks')).toBe(`css:${FRAME}internal:role=tab[name="Benchmarks"s]`);
    expect(inLabsReportFrame('role:table')).toBe(`css:${FRAME}internal:role=table`);
    expect(inLabsReportFrame('text:From the programme report')).toBe(`css:${FRAME}internal:text="From the programme report"i`);
    expect(inLabsReportFrame('testid:kpi-row')).toBe(`css:${FRAME}internal:testid=[data-testid="kpi-row"s]`);
    expect(inLabsReportFrame('aria:Sort by Meeting regularity')).toBe(`css:${FRAME}internal:label="Sort by Meeting regularity"i`);
  });

  it('reads a bare target the way canopy targets.py does', () => {
    expect(recorderTargetToSelector('tr.is-lagging td')).toBe('tr.is-lagging td');
    expect(recorderTargetToSelector('Benchmarks')).toBe('internal:text="Benchmarks"i');
  });

  it('is idempotent', () => {
    const once = inLabsReportFrame('role:tab:Benchmarks');
    expect(inLabsReportFrame(once)).toBe(once);
    expect(isInLabsReportFrame(once)).toBe(true);
  });
});

describe('isLabsReportSurface', () => {
  it('counts realized vars and labs workflow/page URLs, not other hosts', () => {
    expect(isLabsReportSurface('${programme_par_url}')).toBe(true);
    expect(isLabsReportSurface('https://labs.connect.dimagi.com/labs/workflow/8529/run/?run_id=8894&program_id=10115')).toBe(true);
    expect(isLabsReportSurface('https://connect.dimagi.com/a/x/opportunity/1/')).toBe(false);
    expect(isLabsReportSurface(undefined)).toBe(false);
  });
});

describe('checkLabsReportFrameTargets', () => {
  it('flags the unprefixed scene-1 gate that missed on smallholder-seasonal/20261012-1549, with the fix in the detail', () => {
    const f = checkLabsReportFrameTargets([
      { title: 'programme', url: '${programme_par_url}', actions: [{ kind: 'wait_for', target: 'css:tr:has-text("Chitipa")' }] },
    ]);
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('labs-report-target-outside-frame');
    expect(f[0].detail).toContain(`css:${FRAME}tr:has-text("Chitipa")`);
  });

  it('follow-on scenes inherit the surface; goto, hold and pause waits are not element targets', () => {
    const f = checkLabsReportFrameTargets([
      { title: 'a', url: '${programme_par_url}', actions: [{ kind: 'wait_for', target: '1500' }, { kind: 'hold' }] },
      { title: 'b', actions: [{ kind: 'click', target: 'role:tab:Benchmarks' }, { kind: 'goto', target: 'https://x' }] },
    ]);
    expect(f.map((x) => x.scene)).toEqual(['b']);
  });

  it('accepts a framed target and ignores scenes before any url', () => {
    expect(
      checkLabsReportFrameTargets([
        { title: 'pre', actions: [{ kind: 'click', target: 'css:#x' }] },
        { title: 'in', url: '${programme_par_url}', actions: [{ kind: 'click', target: inLabsReportFrame('css:#x') }] },
      ]),
    ).toEqual([]);
  });
});

describe('the Spark worked example (fixture)', () => {
  const SPEC = JSON.parse(readFileSync(FIXTURE, 'utf8')).spec as { scenes: DddScene[] };
  // The fixture as authored on 2026-10-04, before labs drew reports in the frame.
  const strip = (t?: string) =>
    t
      ? t
          .replace(`css:${FRAME}internal:role=tab[name="Benchmarks"s]`, 'role:tab:Benchmarks')
          .replace(FRAME, '')
          .replace('css:internal:text="From the programme report"i', 'text:From the programme report')
      : t;
  const ORIGINAL = SPEC.scenes.map((s) => ({ ...s, actions: (s.actions ?? []).map((a) => ({ ...a, target: strip(a.target) })) }));
  const TARGETED = ORIGINAL.flatMap((s) => s.actions).filter((a) => a.target).length;

  it('authors every report target inside the sandbox frame', () => {
    expect(checkLabsReportFrameTargets(SPEC.scenes)).toEqual([]);
    const r = checkSceneActions(SPEC.scenes);
    expect(r.findings.filter((f) => f.kind === 'labs-report-target-outside-frame')).toEqual([]);
  });

  it('the 2026-10-04 original, before the frame, is flagged on every element target', () => {
    expect(TARGETED).toBeGreaterThan(20);
    expect(checkLabsReportFrameTargets(ORIGINAL)).toHaveLength(TARGETED);
    const r = checkSceneActions(ORIGINAL);
    expect(r.findings.filter((f) => f.kind === 'labs-report-target-outside-frame')).toHaveLength(TARGETED);
  });

  it('rewriting the original through inLabsReportFrame reproduces the fixture exactly', () => {
    const rewritten = ORIGINAL.map((s) => ({ ...s, actions: s.actions.map((a) => ({ ...a, target: a.target && inLabsReportFrame(a.target) })) }));
    expect(rewritten).toEqual(SPEC.scenes.map((s) => ({ ...s, actions: s.actions ?? [] })));
  });
});

describe('combineFrameTexts', () => {
  it('puts the sandbox frame first and keeps the outer page', () => {
    const t = combineFrameTexts('Opportunities: 5 selected', [
      { url: 'https://widget.example/x', text: 'chat' },
      { url: 'https://labs.connect.dimagi.com/labs/sandbox/render/?run_id=8894', text: 'MEETING REGULARITY 86.5%' },
    ]);
    expect(t.split('\n')).toEqual(['MEETING REGULARITY 86.5%', 'chat', 'Opportunities: 5 selected']);
  });
});

describe('checkNarratedFiguresAgainstScreenText', () => {
  // A live capture of a sandboxed labs report (see the fixture's `source`).
  const CAPTURE = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/labs-sandbox-frame/spark-programme-7705-sandboxed.json'), 'utf8')) as {
    outer_text: string;
    frame_texts: Array<{ url: string; text: string }>;
  };
  const scenes: NarratedScene[] = [
    { title: 'programme', url: '${programme_par_url}', narrative: 'Meeting regularity sits at 86.5% against a target of 80.0%; Step 7 on time is 65.0%.' },
  ];

  it('the captured top page holds none of the report: the frame holds all of it', () => {
    expect(CAPTURE.outer_text).not.toContain('86.5%');
    expect(CAPTURE.frame_texts[0].url).toContain('/labs/sandbox/render/');
    expect(CAPTURE.frame_texts[0].text).toContain('86.5%');
  });

  it('says an outer-page-only capture of a labs report is blind, once, instead of flagging every figure', () => {
    const r = checkNarratedFiguresAgainstScreenText(scenes, [{ scene_index: 1, page_text: CAPTURE.outer_text }]);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toEqual(['screen-text-outer-page-only']);
  });

  it('passes figures the sandbox frame printed', () => {
    const r = checkNarratedFiguresAgainstScreenText(scenes, [
      { scene_index: 1, page_text: CAPTURE.outer_text, frame_texts: CAPTURE.frame_texts },
    ]);
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it('flags a narrated figure the frame does not print', () => {
    const wrong: NarratedScene[] = [{ ...scenes[0], narrative: 'Meeting regularity sits at 91.2%.' }];
    const r = checkNarratedFiguresAgainstScreenText(wrong, [
      { scene_index: 1, page_text: CAPTURE.outer_text, frame_texts: CAPTURE.frame_texts },
    ]);
    expect(r.findings).toMatchObject([{ kind: 'figure-not-on-screen', figure: '91.2%' }]);
  });

  it('puts the sandbox frame first when it combines the texts', () => {
    const t = combineFrameTexts(CAPTURE.outer_text, CAPTURE.frame_texts);
    expect(t.startsWith(CAPTURE.frame_texts[0].text)).toBe(true);
    expect(t.endsWith(CAPTURE.outer_text.trimEnd()) || t.includes(CAPTURE.outer_text)).toBe(true);
  });
});

describe('scripts/narration-claims.ts --screen-text', () => {
  it('reads scene_<N>_page_text.json captures and reports against them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ace-2885-'));
    const spec = join(dir, 'spec.yaml');
    writeFileSync(spec, 'scenes:\n  - title: programme\n    url: ${programme_par_url}\n    narrative: Regularity sits at 86.5%.\n    features:\n      - verify: the regularity tile reads 86.5%\n');
    writeFileSync(join(dir, 'scene_1_page_text.json'), JSON.stringify({ scene_index: 1, page_text: 'Opportunities: 5 selected' }));
    const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), join(ROOT, 'scripts/narration-claims.ts'), '--spec', spec, '--check', '--screen-text', dir], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).findings.map((f: { kind: string }) => f.kind)).toEqual(['screen-text-outer-page-only']);
  });
});

describe('demo-narrative skill', () => {
  const skill = readFileSync(join(ROOT, 'skills/demo-narrative/SKILL.md'), 'utf8');

  it('names the frame helper and the frame-entering capture path', () => {
    expect(skill).toMatch(/inLabsReportFrame/);
    expect(skill).toMatch(/capture-scene-text\.ts/);
    expect(skill).toMatch(/labs-report-target-outside-frame/);
  });

  it('the § 2c ladder carries no unframed report target', () => {
    const c2 = skill.slice(skill.indexOf('2c. **ace-run provider'), skill.indexOf('3. **Author the `UnifiedSpec`'));
    expect(c2).not.toMatch(/click `tr:has-text/);
  });
});
