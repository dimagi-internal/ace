import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Class-level preventer for ace#1212: calibration anchors point at MUTABLE
// live artifacts, so they drift silently.
//
// An anchor is the regression test for a rubric revision ("any revision must
// still score that bank <=3"). But Nova apps get repaired, runs get re-run,
// and — worst of all — a score that is a ratio over a judge-built denominator
// moves when the NEXT grader enumerates differently. All three fired on
// pdd-to-learn-app-eval's positive control, which carries three different
// recorded readings of the same app: 0.78 (denominator 32) in the rubric,
// 0.767 in that run's own prior verdict, and 0.904 (denominator 52) live.
//
// This test cannot detect semantic drift — nothing static can. It forces the
// `measured_on:` date that makes drift VISIBLE, per
// `skills/eval-calibration/SKILL.md § Step 3c`.
//
// Scope: anchors, not provenance. A section qualifies only when it BOTH
// speaks in anchor language AND cites a concrete artifact. Change Log
// sections are provenance by construction and are excluded — see the Step 3c
// scope note for why dating provenance is noise rather than rigor.

const SKILLS_DIR = join(__dirname, '..', '..', 'skills');

// Language that means "something checks itself against this".
const ANCHOR_PHRASES = [
  'negative control',
  'positive control',
  'deployable bar',
  'expert reference',
  'calibration target',
  'ground truth',
  'calibrated against',
];

// A concrete, mutable artifact: an ACE run id (YYYYMMDD-HHMM) or a Nova/HQ
// app UUID. An anchor with neither cites nothing that can drift.
const RUN_ID = /\b\d{8}-\d{4}\b/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

interface Section {
  heading: string;
  body: string;
}

/**
 * Split a markdown doc into heading-delimited sections (## and deeper).
 *
 * Headings may be INDENTED — the app-eval rubrics nest `### The negative
 * control` inside a numbered Process step. Matching only column-0 headings
 * folds both controls into one enclosing section, which would let a dated
 * anchor cover for an undated sibling.
 */
export function splitSections(source: string): Section[] {
  const lines = source.split('\n');
  const out: Section[] = [];
  let heading = '(preamble)';
  let buf: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const m = !inFence && /^\s*(#{2,6})\s+(.*)$/.exec(line);
    if (m) {
      out.push({ heading, body: buf.join('\n') });
      heading = m[2].trim();
      buf = [];
      continue;
    }
    buf.push(line);
  }
  out.push({ heading, body: buf.join('\n') });
  return out;
}

export function isChangeLog(heading: string): boolean {
  return /change\s*log/i.test(heading);
}

export function isAnchorSection(section: Section): boolean {
  if (isChangeLog(section.heading)) return false;
  const haystack = `${section.heading}\n${section.body}`.toLowerCase();
  const speaksAnchor = ANCHOR_PHRASES.some((p) => haystack.includes(p));
  if (!speaksAnchor) return false;
  return RUN_ID.test(section.body) || UUID.test(section.body);
}

export function hasMeasuredOn(section: Section): boolean {
  return /measured_on:\s*\d{4}-\d{2}-\d{2}/.test(section.body);
}

function evalSkillFiles(): { name: string; path: string }[] {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.endsWith('-eval'))
    .map((d) => ({ name: d.name, path: join(SKILLS_DIR, d.name, 'SKILL.md') }))
    .filter((f) => existsSync(f.path));
}

describe('eval calibration anchors carry measured_on (ace#1212)', () => {
  const files = evalSkillFiles();

  it('finds the -eval skills to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    it(`${file.name}: every calibration anchor records measured_on`, () => {
      const source = readFileSync(file.path, 'utf8');
      const anchors = splitSections(source).filter(isAnchorSection);
      const undated = anchors.filter((s) => !hasMeasuredOn(s));

      expect(
        undated.map((s) => s.heading),
        `${file.name}/SKILL.md has calibration anchor section(s) citing a ` +
          `mutable run id or app UUID with no "measured_on: YYYY-MM-DD". ` +
          `An undated anchor cannot be told apart from a drifted one. ` +
          `See skills/eval-calibration/SKILL.md § Step 3c — record the date, ` +
          `the evidence the score came from, and a mutability notice. ` +
          `If the section is provenance rather than a regression gate, it ` +
          `belongs in the Change Log.`,
      ).toEqual([]);
    });
  }

  it('the methodology reference documents the rule it enforces', () => {
    const methodology = readFileSync(
      join(SKILLS_DIR, 'eval-calibration', 'SKILL.md'),
      'utf8',
    );
    expect(methodology).toMatch(/measured_on/);
    expect(methodology).toMatch(/Step 3c/);
  });
});

describe('anchor-section detection', () => {
  it('ignores Change Log sections (provenance, not anchors)', () => {
    const doc = [
      '## Change Log',
      '',
      '| 2026-08-13 | Negative control `hh-poverty/20260722-1341` unchanged. |',
    ].join('\n');
    expect(splitSections(doc).filter(isAnchorSection)).toEqual([]);
  });

  it('ignores anchor language with no concrete artifact cited', () => {
    const doc = ['## Calibration', '', 'Calibrated against per-opp ground truth.'].join('\n');
    expect(splitSections(doc).filter(isAnchorSection)).toEqual([]);
  });

  it('flags an undated anchor citing a run id', () => {
    const doc = [
      '### The negative control',
      '',
      'Run `hh-poverty-targeting/20260722-1341` must still score <=3.',
    ].join('\n');
    const anchors = splitSections(doc).filter(isAnchorSection);
    expect(anchors).toHaveLength(1);
    expect(hasMeasuredOn(anchors[0])).toBe(false);
  });

  it('accepts an anchor that records measured_on', () => {
    const doc = [
      '### The negative control',
      '',
      '`measured_on: 2026-08-12`. Run `hh-poverty-targeting/20260722-1341`.',
    ].join('\n');
    const anchors = splitSections(doc).filter(isAnchorSection);
    expect(anchors).toHaveLength(1);
    expect(hasMeasuredOn(anchors[0])).toBe(true);
  });

  it('splits INDENTED headings so a dated anchor cannot cover an undated sibling', () => {
    const doc = [
      '## Process',
      '',
      '5. Do the thing.',
      '',
      '   ### The negative control',
      '',
      '   `measured_on: 2026-08-12`. Run `hh-poverty-targeting/20260722-1341`.',
      '',
      '   ### The positive control',
      '',
      '   Learn app `036c2c60-be0e-447d-862f-fe14d1dbcbb1` scored 0.78.',
    ].join('\n');
    const anchors = splitSections(doc).filter(isAnchorSection);
    expect(anchors).toHaveLength(2);
    expect(anchors.filter((s) => !hasMeasuredOn(s)).map((s) => s.heading)).toEqual([
      'The positive control',
    ]);
  });

  it('flags an undated anchor citing a Nova app UUID', () => {
    const doc = [
      '### The positive control',
      '',
      'Learn app `036c2c60-be0e-447d-862f-fe14d1dbcbb1` scored 0.78.',
    ].join('\n');
    expect(splitSections(doc).filter(isAnchorSection)).toHaveLength(1);
  });
});
