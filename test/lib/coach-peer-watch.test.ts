import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  renderSelectionBriefing,
  selectCoachingWorkers,
  selectNamedWorkers,
  selectPeerWatch,
  type RunIndicatorWorker,
} from '../../lib/coach-peer-watch.js';
import type { RegistryMeasure } from '../../lib/coach-briefing.js';

/**
 * ace#3053. Grounded on a captured report: kaduna-graduation/20261015-1411's
 * programme report (labs run 11139), read with `workflow_run_indicators`, and its
 * registry 10510's measures. The PDD sets no targets, so every cell is `unbanded`
 * and Labs' own selection (`band: "red"`) is empty.
 */
const fixture = JSON.parse(
  readFileSync(
    new URL('../fixtures/cascade/kaduna-graduation-20261015-1411-run-indicators.json', import.meta.url),
    'utf8',
  ),
) as { measures: RegistryMeasure[]; run_indicators: { workers: RunIndicatorWorker[] } };
const workers = fixture.run_indicators.workers;
const measures = fixture.measures;
const partner = (opp: string) => workers.filter((w) => w.key.startsWith(`${opp}::`));

/** Labs' parser for a briefing topic line (`connect_labs/workflow/coach_briefing.py` `_TOPIC_LINE`). */
const LABS_TOPIC_LINE = /^\d+\.\s+(.*?)\s+\[([^\]]+)\]\s+—\s+(.*),\s+band\s+(\S+)\s*$/;

describe('the captured target-less report (premise)', () => {
  it('has no red or yellow worker, so Labs alone can coach nobody', () => {
    expect(workers).toHaveLength(60);
    expect(workers.every((w) => !w.reds && !w.yellows)).toBe(true);
    expect(workers.every((w) => Object.values(w.indicators).every((c) => c.band === 'unbanded'))).toBe(true);
  });
});

describe('selectCoachingWorkers — peer watch (a)', () => {
  const sel = selectCoachingWorkers({ workers, measures });

  it('finds the mentor whose short-visit flags are far above her peers (53.5% vs a 0.7% median)', () => {
    expect(sel.mode).toBe('peer_watch');
    const hk04 = sel.workers.find((w) => w.key === '10154::kg_hk04');
    expect(hk04?.topics.map((t) => t.key)).toEqual(['KG_SV']);
    expect(hk04!.topics[0].value).toBeCloseTo(53.5, 1);
    expect(hk04!.topics[0].peerMedian).toBeLessThan(1);
    expect(hk04!.topics[0].peerCount).toBe(59);
  });

  it('leaves a worker in the middle of the pack out', () => {
    expect(sel.workers.map((w) => w.key)).not.toContain('10152::kg_hm01');
    expect(sel.workers.length).toBeLessThan(workers.length / 4);
  });

  it('never raises an indicator with no direction or not applicable to a worker', () => {
    const keys = new Set(sel.workers.flatMap((w) => w.topics.map((t) => t.key)));
    expect(keys.has('KG_EX')).toBe(false); // direction none
    expect(keys.has('KG_MC')).toBe(false); // flw_applicable false
  });

  it('selects nobody on a partner whose mentors all look alike (negative control)', () => {
    // Haske Mata's twelve mentors: every coachable figure within a few points of each other.
    expect(selectPeerWatch(partner('10152'), measures)).toEqual([]);
  });

  it('does not compare against fewer peers than Labs’ cohort floor', () => {
    const five = [...partner('10154').slice(0, 4), workers.find((w) => w.key === '10154::kg_hk04')!];
    expect(selectPeerWatch(five, measures)).toEqual([]);
    expect(selectPeerWatch(partner('10154'), measures).map((w) => w.key)).toContain('10154::kg_hk04');
  });

  it('speaks only for target-less indicators: a banded registry is Labs’ to grade', () => {
    const banded = measures.map((m) => ({ ...m, meta: { ...m.meta, bands: [80, 60], target: 80 } }));
    const s = selectCoachingWorkers({ workers, measures: banded });
    expect(s.mode).toBe('none');
    expect(s.reasons.join(' ')).toMatch(/without a target/);
  });

  it('defers to Labs when any worker is graded red or yellow', () => {
    const graded = workers.map((w) => (w.key === '10152::kg_hm03' ? { ...w, reds: 1 } : w));
    const s = selectCoachingWorkers({ workers: graded, measures });
    expect(s.mode).toBe('band');
    expect(s.workers.map((w) => w.key)).toEqual(['10152::kg_hm03']);
  });
});

describe('selectCoachingWorkers — the named-list fallback (b)', () => {
  const quiet = partner('10152');

  it('uses the supervisor’s names when nobody stands out, and reports a name it cannot place', () => {
    const s = selectCoachingWorkers({ workers: quiet, measures, named: ['Rabi Abubakar', 'KG_HM02', 'Nobody Here'] });
    expect(s.mode).toBe('named');
    expect(s.workers.map((w) => w.key)).toEqual(['10152::kg_hm01', '10152::kg_hm02']);
    expect(s.unmatched).toEqual(['Nobody Here']);
    expect(s.workers[0].topics.length).toBeGreaterThan(0);
  });

  it('prefers peer watch over a named list when someone does stand out', () => {
    expect(selectCoachingWorkers({ workers, measures, named: ['Rabi Abubakar'] }).mode).toBe('peer_watch');
  });

  it('returns none with the reason — never an empty success — when nobody stands out and nobody is named', () => {
    const s = selectCoachingWorkers({ workers: quiet, measures });
    expect(s.mode).toBe('none');
    expect(s.workers).toEqual([]);
    expect(s.reasons.join(' ')).toMatch(/supervisor/);
  });

  it('refuses a name two workers share rather than guess', () => {
    const twins = quiet.map((w) => (w.key === '10152::kg_hm02' ? { ...w, name: 'Rabi Abubakar' } : w));
    const r = selectNamedWorkers(twins, measures, ['Rabi Abubakar']);
    expect(r.workers).toEqual([]);
    expect(r.unmatched).toEqual(['Rabi Abubakar']);
  });
});

describe('renderSelectionBriefing', () => {
  const sel = selectCoachingWorkers({ workers, measures });
  const hk04 = sel.workers.find((w) => w.key === '10154::kg_hk04')!;
  const text = renderSelectionBriefing({ programName: 'Kaduna Graduation', workerPlural: 'mentors', worker: hk04, mode: 'peer_watch' });

  it('is a briefing Labs keeps as-is and whose topics Labs can read back', () => {
    expect(text.startsWith('BRIEFING (system text')).toBe(true);
    const topicLines = text.split('\n').filter((l) => /^\d+\./.test(l));
    expect(topicLines).toHaveLength(1);
    const m = LABS_TOPIC_LINE.exec(topicLines[0]);
    expect(m?.[2]).toBe('KG_SV');
    expect(m?.[4]).toBe('peer-watch');
    expect(m?.[3]).toMatch(/^53\.5% \(median of 59 other mentors: 0\.7%\)$/);
  });

  it('labels the comparison as peers and never as a programme target', () => {
    expect(text).toMatch(/comparison with peers/);
    expect(text).toMatch(/sets no target/);
    expect(text).not.toMatch(/goal of|aims for|below target|off target/i);
  });

  it('marks a named worker’s topics unbanded, not peer-watch', () => {
    const named = selectNamedWorkers(partner('10152'), measures, ['Rabi Abubakar']).workers[0];
    const t = renderSelectionBriefing({ programName: 'Kaduna Graduation', workerPlural: 'mentors', worker: named, mode: 'named' });
    const bands = t
      .split('\n')
      .map((l) => LABS_TOPIC_LINE.exec(l)?.[4])
      .filter(Boolean);
    expect(bands.length).toBeGreaterThan(0);
    expect(new Set(bands)).toEqual(new Set(['unbanded']));
    expect(t).toMatch(/programme team asked/);
  });
});
