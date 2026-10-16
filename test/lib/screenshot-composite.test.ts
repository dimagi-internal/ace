// Composited common-pool frames (dimagi-internal/ace#3060): illustration only.
// The UI dump below is synthetic. The real 2.64.0 dumps carry run names, which is
// exactly why they stay out of the repo.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  CompositeCoverageError,
  compositeProvenance,
  isComposited,
  parseUiTextNodes,
  planComposite,
  type CompositeFrameSpec,
} from '../../lib/screenshot-composite.js';
import { collectCaptureEntries } from '../../lib/capture-manifest.js';
import { classifyCommonPool, REQUIRED_LIVE_ALIASES } from '../../lib/common-screenshot-pool.js';

const node = (id: string, text: string, b: string) =>
  `<node index="0" text="${text}" resource-id="${id ? `org.commcare.dalvik:id/${id}` : ''}" class="android.widget.TextView" bounds="${b}" />`;
const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
  ${node('', 'Connect', '[189,174][388,245]')}
  ${node('action_sync', '', '[953,146][1080,272]')}
  ${node('tvTitle', '20261015-1129 · Real Program One', '[89,608][735,715]')}
  ${node('tvDate', 'Task ends on May 2, 2027', '[100,739][469,782]')}
  ${node('tvTitle', '20261015-1402 · Real Program Two', '[89,1050][735,1157]')}
  ${node('btn_resume', 'Resume', '[89,835][320,914]')}
</hierarchy>`;

const SPEC: CompositeFrameSpec = {
  base: { recipe: '00-connect-home.yaml', step: 'connect-home', sha256: 'abc' },
  keep: [
    { id: '', text: 'Connect' },
    { id: 'tvDate', text: 'Task (ends|ended) on .*' },
    { id: 'btn_resume', text: 'Resume' },
  ],
  replace: [{ id: 'tvTitle', text: ['Sample A', 'Sample B'], font_px: 37, weight: 700, line_px: 56 }],
};

describe('parseUiTextNodes', () => {
  it('returns only text-bearing nodes, with per-id occurrence indexes and integer bounds', () => {
    const n = parseUiTextNodes(DUMP);
    expect(n.map((x) => `${x.id}#${x.index}`)).toEqual(['#0', 'tvTitle#0', 'tvDate#0', 'tvTitle#1', 'btn_resume#0']);
    expect(n[1].bounds).toEqual([89, 608, 735, 715]);
  });
});

describe('planComposite', () => {
  it('plans one op per replaced element, in dump order, with the spec font', () => {
    const ops = planComposite(parseUiTextNodes(DUMP), SPEC);
    expect(ops).toEqual([
      { id: 'tvTitle', index: 0, rect: [89, 608, 735, 715], text: 'Sample A', fontPx: 37, weight: 700, linePx: 56 },
      { id: 'tvTitle', index: 1, rect: [89, 1050, 735, 1157], text: 'Sample B', fontPx: 37, weight: 700, linePx: 56 },
    ]);
  });

  it('REFUSES a text element no rule covers, so a new string cannot leak unseen', () => {
    const spec = { ...SPEC, keep: SPEC.keep.filter((k) => k.id !== 'tvDate') };
    expect(() => planComposite(parseUiTextNodes(DUMP), spec)).toThrow(CompositeCoverageError);
    expect(() => planComposite(parseUiTextNodes(DUMP), spec)).toThrow(/id=tvDate index=0/);
  });

  it('a keep rule is a WHOLE-string match: an opp name inside a generic-looking string is refused', () => {
    const dump = DUMP.replace('Task ends on May 2, 2027', 'Resume Real Program One');
    const spec = { ...SPEC, keep: [...SPEC.keep, { id: 'tvDate', text: 'Resume' }] };
    expect(() => planComposite(parseUiTextNodes(dump), spec)).toThrow(/id=tvDate/);
  });

  it('never echoes more than a 24-char prefix of an uncovered string', () => {
    const spec = { ...SPEC, replace: [] };
    try {
      planComposite(parseUiTextNodes(DUMP), spec);
      throw new Error('should have refused');
    } catch (e) {
      expect((e as Error).message).not.toContain('Real Program One');
    }
  });

  it('REFUSES a stale replace rule that matches nothing', () => {
    const spec = { ...SPEC, replace: [...SPEC.replace, { id: 'tv_job_title', index: 0, text: 'x', font_px: 59 }] };
    expect(() => planComposite(parseUiTextNodes(DUMP), spec)).toThrow(/matched nothing: id=tv_job_title/);
  });

  it('REFUSES an all-occurrence rule whose replacement count differs from the matches', () => {
    const spec = { ...SPEC, replace: [{ id: 'tvTitle', text: ['only one'], font_px: 37 }] };
    expect(() => planComposite(parseUiTextNodes(DUMP), spec)).toThrow(/matches 2 elements but gives 1/);
  });
});

describe('provenance', () => {
  it('labels the output composited, pins the base hash, and records ids but not original text', () => {
    const p = compositeProvenance(SPEC, planComposite(parseUiTextNodes(DUMP), SPEC));
    expect(p).toEqual({
      source: 'composited',
      composited_from: { recipe: '00-connect-home.yaml', step: 'connect-home', sha256: 'abc' },
      replaced: [{ id: 'tvTitle', index: 0 }, { id: 'tvTitle', index: 1 }],
    });
    expect(JSON.stringify(p)).not.toContain('Real Program');
  });
});

describe('composited frames are illustration, never evidence', () => {
  it('collectCaptureEntries (the one evidence-manifest reader) throws on a composited entry', () => {
    expect(isComposited({ source: 'composited' })).toBe(true);
    expect(() => collectCaptureEntries({ captures: [{ step: 'connect-home', file_id: 'f', source: 'composited' }] })).toThrow(
      /source: composited/,
    );
    expect(collectCaptureEntries({ captures: [{ step: 's', file_id: 'f' }] })).toHaveLength(1);
  });

  it('the common pool counts a composited frame as usable on a deck', () => {
    const shots = REQUIRED_LIVE_ALIASES.map(
      (a) => `  ${a}:\n    drive: "id-${a}"\n    source: ${a === 'claim-opp' || a === 'connect-home' ? 'composited' : 'live'}\n`,
    ).join('');
    const v = classifyCommonPool({ pinnedVersion: '2.64.0', versionsPresent: ['2.64.0'], manifestText: `screenshots:\n${shots}` });
    expect(v).toMatchObject({ status: 'pass', missingLive: [] });
  });
});

describe('committed specs', () => {
  const dir = 'templates/training-deck/_common/composites';
  it.each(fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')))('%s is well-formed', (f) => {
    const s = parseYaml(fs.readFileSync(`${dir}/${f}`, 'utf8')) as {
      apk_version: string;
      font: { sha256: string };
      frames: Record<string, CompositeFrameSpec>;
    };
    expect(f).toBe(`connect-${s.apk_version}.yaml`);
    expect(s.font.sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const [alias, fr] of Object.entries(s.frames)) {
      expect(fr.base.sha256, alias).toMatch(/^[0-9a-f]{64}$/);
      for (const k of fr.keep) expect(() => new RegExp(k.text), `${alias} keep ${k.id}`).not.toThrow();
      for (const r of fr.replace) {
        expect(r.font_px, `${alias} ${r.id}`).toBeGreaterThan(0);
        // Replacement copy is generic by construction: it says "Sample", never a run id.
        const texts = Array.isArray(r.text) ? r.text : [r.text];
        for (const t of texts) expect(t, `${alias} ${r.id}`).not.toMatch(/\d{8}-\d{4}/);
      }
    }
  });
});
