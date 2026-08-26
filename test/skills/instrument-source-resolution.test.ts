/**
 * dimagi-internal/ace#1648 — the skip that disabled a correctness check.
 *
 * `pdd-to-deliver-app` § 4k is the only gate on the Phase-3 path that can see
 * a wrong CONSTANT. Its trigger ANDed two conditions into ONE silent skip:
 *
 *   > This step fires iff BOTH hold: the PDD marks an instrument `[FIXED]`,
 *   > AND `inputs-manifest.yaml` carries a source file for it.
 *
 * So "no [FIXED] instrument on this opp" and "the [FIXED] instrument's source
 * is unreachable" were indistinguishable — both a clean skip, both a green
 * phase. And they were not equally rare: the manifest's `inputs[]` records
 * direct child FILES only, so a published instrument bundle sitting in a
 * SUBFOLDER of `inputs/` — the natural shape for a vendor download — always
 * took the second branch. On `hh-poverty-targeting/20260824-1404` the workbook
 * was in `official-nigeria-ppi-2020 (povertyindex.org)/` and none of the five
 * `inputs[]` entries was it.
 *
 * That is the check whose absence let `hh-poverty-targeting/20260819-1435`
 * ship 9 of 17 scorecard point values wrong and all 101 poverty-likelihood
 * values invented, with every other gate green.
 *
 * This file pins BOTH halves as text, because both live in prose that an
 * editor can quietly re-AND:
 *   1. the source is resolvable through ids the manifest already records;
 *   2. an unresolvable `[FIXED]` source HALTS rather than skipping.
 *
 * Scoping matters: § 4k says "HALT" in its extraction and diff sub-steps, so a
 * whole-section grep for "HALT" passes on the BROKEN text. The assertions below
 * are scoped to the trigger sub-step, which is where the split has to live.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD_SKILL = path.join(REPO_ROOT, 'skills/pdd-to-deliver-app/SKILL.md');
const ORCHESTRATOR = path.join(REPO_ROOT, 'agents/ace-orchestrator.md');

const skill = fs.readFileSync(BUILD_SKILL, 'utf8');
const orchestrator = fs.readFileSync(ORCHESTRATOR, 'utf8');

/** The body of § 4k, up to the next top-level `4x.` / `N.` step. */
function step4kBody(): string {
  const start = skill.search(/^4k\.\s+\*\*/m);
  expect(start, '§ 4k (fixed-instrument constant fidelity) is missing from the skill').toBeGreaterThan(-1);
  const rest = skill.slice(start + 1);
  const next = rest.search(/^(?:4[a-z]|\d+)\.\s+\*\*/m);
  return next < 0 ? rest : rest.slice(0, next);
}

/** The trigger sub-step (`1.`) inside § 4k — where the skip/halt split lives. */
function triggerBlock(): string {
  const body = step4kBody();
  const start = body.search(/^ {4}1\.\s+\*\*/m);
  expect(start, '§ 4k has no `1.` trigger sub-step').toBeGreaterThan(-1);
  const rest = body.slice(start + 1);
  const next = rest.search(/^ {4}2\.\s+\*\*/m);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Orchestrator Step 5c — where the manifest's shape is specified. */
function step5cBlock(): string {
  const start = orchestrator.search(/^ {3}- \*\*5c\./m);
  expect(start, 'Orchestrator Step 5c is missing').toBeGreaterThan(-1);
  const rest = orchestrator.slice(start + 1);
  const next = rest.search(/^ {3}- \*\*5d\./m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('§ 4k fixed-instrument source resolution (ace#1648)', () => {
  it('does NOT AND "[FIXED]" with "manifest carries a source" into one silent skip', () => {
    expect(
      /fires iff BOTH hold/.test(triggerBlock()),
      'The ANDed trigger is back. "No [FIXED] instrument" and "the [FIXED] instrument is ' +
        'unreachable" must not share an outcome — the second one must halt.',
    ).toBe(false);
  });

  it('HALTS when a [FIXED] instrument\'s source cannot be resolved', () => {
    const trigger = triggerBlock();
    expect(
      /HALT/.test(trigger),
      '§ 4k\'s trigger sub-step must name HALT as the outcome for a [FIXED] instrument whose ' +
        'source does not resolve. A skip there disables the only gate that can see a wrong ' +
        'constant, and the run still reports green.',
    ).toBe(true);
    expect(
      /[Nn]ever (a )?skip/.test(trigger),
      'The trigger must say explicitly that the unresolvable case is never a skip.',
    ).toBe(true);
  });

  it('still skips silently — and only — when no instrument is [FIXED]', () => {
    expect(/skip cleanly/.test(triggerBlock())).toBe(true);
    expect(/instrument_constants: skipped/.test(step4kBody())).toBe(true);
  });

  it('resolves through ids the manifest already records, one level, not by name', () => {
    const body = step4kBody();
    expect(
      /subfolders_not_listed/.test(body),
      '§ 4k must be able to reach a workbook published as a SUBFOLDER of inputs/, via the ' +
        'folder ids the manifest itself records.',
    ).toBe(true);
    expect(/drive_list_folder/.test(body)).toBe(true);
    expect(
      /one level/i.test(body),
      'The walk must be bounded to one level — a recursive crawl of inputs/ is a different ' +
        'contract than "resolve a recorded id".',
    ).toBe(true);
    expect(
      /compose a path/.test(body),
      'Walking a recorded id is not guessing; composing a path by name still is, and the ' +
        'prohibition must survive this change.',
    ).toBe(true);
  });

  it('routes the skip-vs-halt decision through the tested helper', () => {
    expect(
      /resolveInstrumentSource/.test(step4kBody()),
      'The split must be delegated to lib/instrument-constants.ts so it is covered by a unit ' +
        'test rather than by prose alone.',
    ).toBe(true);
  });
});

describe('orchestrator Step 5c records subfolder ids (ace#1648)', () => {
  it('mandates capturing each direct-child subfolder as {folder_id, name}', () => {
    const block = step5cBlock();
    expect(
      /subfolders_not_listed/.test(block),
      'Step 5c must record direct-child subfolder ids. Without them the [FIXED] instrument ' +
        'workbook is unaddressable from the manifest and § 4k cannot resolve it.',
    ).toBe(true);
    expect(/folder_id/.test(block)).toBe(true);
    expect(
      /mandatory/i.test(block),
      'Recording the ids must be mandatory, not an optional nicety a future run can drop.',
    ).toBe(true);
  });

  // NOTE: green before AND after the #1648 fix — a carried-forward invariant,
  // not a preventer. It is here so the fix's widening of the manifest cannot
  // creep into inputs[] itself in a later edit.
  it('keeps inputs[] to direct child FILES — the evidence set stays frozen', () => {
    expect(
      /direct child file/i.test(step5cBlock()),
      'inputs[] must stay files-only; widening it would change what Phase 1 treats as evidence.',
    ).toBe(true);
  });
});
