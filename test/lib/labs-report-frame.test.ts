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
  framingFromCaptures,
  inLabsReportFrame,
  isInLabsReportFrame,
  isLabsReportSurface,
  outOfLabsReportFrame,
  recorderTargetToSelector,
  type SurfaceFraming,
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

// Every scene observed with one shape.
const all = (n: number, shape: SurfaceFraming) => new Map(Array.from({ length: n }, (_, i) => [i + 1, shape] as const));

// The 2026-10-16 probe of workflow 10049 run 10369 (smallholder-seasonal/20261015-1402):
// {"iframes":[],"topPageHasReportText":true,"frames":[<the run page>, <the canopy chat-widget embed>]}; the embed's host is stubbed here.
const UNFRAMED_10049 = [{ url: 'https://chat-widget.example/embed/chat?app=connect-labs', text: 'chat' }];

describe('outOfLabsReportFrame', () => {
  it('undoes inLabsReportFrame for every recorder prefix, and leaves an unframed target alone', () => {
    for (const t of ['css:tr:has-text("Kuunika")', 'role:tab:Benchmarks', 'text:From the programme report', 'testid:kpi-row']) {
      const out = outOfLabsReportFrame(inLabsReportFrame(t));
      expect(isInLabsReportFrame(out)).toBe(false);
      expect(out).toBe(`css:${recorderTargetToSelector(t)}`);
      expect(inLabsReportFrame(out)).toBe(inLabsReportFrame(t));
    }
    expect(outOfLabsReportFrame('role:tab:Benchmarks')).toBe('role:tab:Benchmarks');
  });
});

describe('framingFromCaptures', () => {
  it('reads framed from a sandbox frame, unframed from its absence, and nothing from a top-page-only capture', () => {
    const m = framingFromCaptures([
      { scene_index: 1, frame_texts: [{ url: 'https://labs.connect.dimagi.com/labs/sandbox/render/?run_id=7705', text: 'x' }] },
      { scene_index: 2, frame_texts: UNFRAMED_10049 },
      { scene_index: 3, frame_texts: [] },
      { scene_index: 4 },
    ]);
    expect([...m.entries()]).toEqual([
      [1, 'framed'],
      [2, 'unframed'],
      [3, 'unframed'],
    ]);
  });
});

describe('checkLabsReportFrameTargets', () => {
  it('iframe PRESENT: flags the unprefixed scene-1 gate that missed on smallholder-seasonal/20261012-1549, with the fix', () => {
    const f = checkLabsReportFrameTargets(
      [{ title: 'programme', url: '${programme_par_url}', actions: [{ kind: 'wait_for', target: 'css:tr:has-text("Chitipa")' }] }],
      all(1, 'framed'),
    );
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('labs-report-target-outside-frame');
    expect(f[0].detail).toContain(`css:${FRAME}tr:has-text("Chitipa")`);
  });

  it('iframe ABSENT: accepts the unprefixed target and flags a framed one, with the unframed fix', () => {
    const scenes = (target: string) => [{ title: 'programme', url: '${programme_par_url}', actions: [{ kind: 'wait_for', target }] }];
    expect(checkLabsReportFrameTargets(scenes('css:tr:has-text("Chitipa")'), all(1, 'unframed'))).toEqual([]);
    const f = checkLabsReportFrameTargets(scenes(inLabsReportFrame('css:tr:has-text("Chitipa")')), all(1, 'unframed'));
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('labs-report-target-in-absent-frame');
    expect(f[0].detail).toContain('"css:tr:has-text("Chitipa")"');
  });

  it('UNOBSERVED: says nothing either way, because the URL cannot tell (the 2026-10-16 misfire)', () => {
    const s = [
      { title: 'a', url: 'https://labs.connect.dimagi.com/labs/workflow/10049/run/?run_id=10369&program_id=10142', actions: [{ kind: 'click', target: 'role:tab:Benchmarks' }] },
      { title: 'b', actions: [{ kind: 'click', target: inLabsReportFrame('role:tab:Benchmarks') }] },
    ];
    expect(checkLabsReportFrameTargets(s)).toEqual([]);
    expect(checkSceneActions(s).findings.filter((x) => x.kind.startsWith('labs-report-target'))).toEqual([]);
  });

  it('decides per scene: one framed report and one unframed in the same spec', () => {
    const f = checkLabsReportFrameTargets(
      [
        { title: 'framed', url: '${programme_par_url}', actions: [{ kind: 'click', target: 'role:tab:Benchmarks' }] },
        { title: 'unframed', url: '${worker_review_url}', actions: [{ kind: 'click', target: 'role:tab:Benchmarks' }] },
      ],
      new Map<number, SurfaceFraming>([
        [1, 'framed'],
        [2, 'unframed'],
      ]),
    );
    expect(f.map((x) => [x.scene, x.kind])).toEqual([['framed', 'labs-report-target-outside-frame']]);
  });

  it('follow-on scenes inherit the surface; goto, hold and pause waits are not element targets', () => {
    const f = checkLabsReportFrameTargets(
      [
        { title: 'a', url: '${programme_par_url}', actions: [{ kind: 'wait_for', target: '1500' }, { kind: 'hold' }] },
        { title: 'b', actions: [{ kind: 'click', target: 'role:tab:Benchmarks' }, { kind: 'goto', target: 'https://x' }] },
      ],
      all(2, 'framed'),
    );
    expect(f.map((x) => x.scene)).toEqual(['b']);
  });

  it('accepts a framed target and ignores scenes before any url', () => {
    expect(
      checkLabsReportFrameTargets(
        [
          { title: 'pre', actions: [{ kind: 'click', target: 'css:#x' }] },
          { title: 'in', url: '${programme_par_url}', actions: [{ kind: 'click', target: inLabsReportFrame('css:#x') }] },
        ],
        all(2, 'framed'),
      ),
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
  const FRAMED = all(SPEC.scenes.length, 'framed');
  const UNFRAMED = all(SPEC.scenes.length, 'unframed');

  it('iframe present: every report target enters the sandbox frame', () => {
    expect(checkLabsReportFrameTargets(SPEC.scenes, FRAMED)).toEqual([]);
    const r = checkSceneActions(SPEC.scenes, { framing: FRAMED });
    expect(r.findings.filter((f) => f.kind === 'labs-report-target-outside-frame')).toEqual([]);
  });

  it('iframe present: the 2026-10-04 original is flagged on every element target', () => {
    expect(TARGETED).toBeGreaterThan(20);
    expect(checkLabsReportFrameTargets(ORIGINAL, FRAMED)).toHaveLength(TARGETED);
    const r = checkSceneActions(ORIGINAL, { framing: FRAMED });
    expect(r.findings.filter((f) => f.kind === 'labs-report-target-outside-frame')).toHaveLength(TARGETED);
  });

  it('iframe absent: the original passes and the framed fixture is flagged on every element target', () => {
    expect(checkLabsReportFrameTargets(ORIGINAL, UNFRAMED)).toEqual([]);
    const f = checkLabsReportFrameTargets(SPEC.scenes, UNFRAMED);
    expect(f).toHaveLength(TARGETED);
    expect(new Set(f.map((x) => x.kind))).toEqual(new Set(['labs-report-target-in-absent-frame']));
    const r = checkSceneActions(SPEC.scenes, { framing: UNFRAMED });
    expect(r.findings.filter((x) => x.kind === 'labs-report-target-in-absent-frame')).toHaveLength(TARGETED);
  });

  it('rewriting the original through inLabsReportFrame reproduces the fixture exactly', () => {
    const rewritten = ORIGINAL.map((s) => ({ ...s, actions: s.actions.map((a) => ({ ...a, target: a.target && inLabsReportFrame(a.target) })) }));
    expect(rewritten).toEqual(SPEC.scenes.map((s) => ({ ...s, actions: s.actions ?? [] })));
  });

  it('rewriting the fixture through outOfLabsReportFrame clears every absent-frame finding', () => {
    const out = SPEC.scenes.map((s) => ({ ...s, actions: (s.actions ?? []).map((a) => ({ ...a, target: a.target && outOfLabsReportFrame(a.target) })) }));
    expect(checkLabsReportFrameTargets(out, UNFRAMED)).toEqual([]);
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

  it('iframe absent: a top-page-only capture that prints the figures passes', () => {
    const top = `Opportunities: 5 selected\n${CAPTURE.frame_texts[0].text}`;
    expect(checkNarratedFiguresAgainstScreenText(scenes, [{ scene_index: 1, page_text: top }])).toEqual({ ok: true, findings: [] });
    expect(checkNarratedFiguresAgainstScreenText(scenes, [{ scene_index: 1, page_text: top, frame_texts: UNFRAMED_10049 }])).toEqual({
      ok: true,
      findings: [],
    });
  });

  it('iframe absent: a frame-recording capture flags a missing figure plainly, not as outer-page-only', () => {
    const r = checkNarratedFiguresAgainstScreenText(scenes, [{ scene_index: 1, page_text: 'Meeting regularity 86.5%', frame_texts: [] }]);
    expect(r.findings.map((f) => [f.kind, f.figure])).toEqual([
      ['figure-not-on-screen', '80.0%'],
      ['figure-not-on-screen', '65.0%'],
    ]);
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

  it('checks report targets against the shape each capture saw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ace-2885-'));
    const spec = join(dir, 'spec.yaml');
    const framedTarget = inLabsReportFrame('role:tab:Benchmarks');
    writeFileSync(
      spec,
      `scenes:\n  - title: framed\n    url: \${programme_par_url}\n    narrative: The tabs.\n    actions:\n      - kind: click\n        target: 'role:tab:Benchmarks'\n` +
        `  - title: unframed\n    url: \${worker_review_url}\n    narrative: The tabs.\n    actions:\n      - kind: click\n        target: ${JSON.stringify(framedTarget)}\n` +
        `  - title: unobserved\n    url: \${opp_review_url}\n    narrative: The tabs.\n    actions:\n      - kind: click\n        target: 'role:tab:Benchmarks'\n`,
    );
    const sandbox = [{ url: 'https://labs.connect.dimagi.com/labs/sandbox/render/?run_id=1', text: 'Benchmarks' }];
    writeFileSync(join(dir, 'scene_1_page_text.json'), JSON.stringify({ scene_index: 1, page_text: '', frame_texts: sandbox }));
    writeFileSync(join(dir, 'scene_2_page_text.json'), JSON.stringify({ scene_index: 2, page_text: 'Benchmarks', frame_texts: UNFRAMED_10049 }));
    const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), join(ROOT, 'scripts/narration-claims.ts'), '--spec', spec, '--check', '--screen-text', dir], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    const kinds = JSON.parse(r.stdout).findings.map((f: { kind: string; scene: string }) => [f.scene, f.kind]);
    expect(kinds).toEqual([
      ['framed', 'labs-report-target-outside-frame'],
      ['unframed', 'labs-report-target-in-absent-frame'],
    ]);
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
