/**
 * ace#2582 — a forked run must keep the source run's decision history without
 * presenting the rows it re-runs as its own live choices.
 *
 * ace-web's fork (`apps/opps/opp_forker.py::_rewrite_decisions_yaml`) does the
 * marking server-side, where it already copies `decisions.yaml`: a row whose
 * phase is at or after the fork point is moved to `<id>-<source-run-id>`,
 * stamped `superseded_by: <id>` (the plugin's existing supersession field,
 * ace#1421) and `inherited_from_run: <source-run-id>`. This file is the
 * PLUGIN half of that contract: the log ace-web writes must parse, render as
 * history, stay out of the build memo, and let the re-run producer append
 * under the canonical id.
 *
 * Fixtures (`test/fixtures/fork-decisions/spark-facilitator-20261001-2208/`):
 *  - `source-decisions.yaml` — a subset of the real rows 20261001-2208 carried
 *    in from 20260926-1800 when it was forked at `commcare-setup`;
 *  - `forked-decisions.yaml` — that file run through ace-web's actual
 *    `_rewrite_decisions_yaml(fork_ordinal=3, source_run_id="20260926-1800")`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import {
  liveDecisions,
  parseDecisionsYaml,
  resolveDecision,
  type DecisionsLog,
} from '../../lib/decisions-schema';
import { composeAppendedLog } from '../../lib/decisions-write';
import { renderDecisionsLog } from '../../lib/decisions-renderer';
import { liveDecisionRows } from '../../lib/build-memo-compose';

const DIR = join(__dirname, '..', 'fixtures', 'fork-decisions', 'spark-facilitator-20261001-2208');
const SOURCE = readFileSync(join(DIR, 'source-decisions.yaml'), 'utf8');
const FORKED = readFileSync(join(DIR, 'forked-decisions.yaml'), 'utf8');
const SRC_RUN = '20260926-1800';
const NEW_RUN = '20261001-2208';

const ordinal = (phase: string) => Number(phase.split('-')[0]);
const liveAtOrAfter = (log: DecisionsLog, n: number) =>
  liveDecisions(log).filter((d) => ordinal(d.phase) >= n).map((d) => d.id);

const renderedText = (log: DecisionsLog) =>
  renderDecisionsLog(log)
    .map((r) => ('insertText' in r ? r.insertText?.text ?? '' : ''))
    .join('');

/** A fresh row the re-run Phase 3 producer emits under the canonical id. */
const reRunRow = {
  id: 'deliver-latitude-payability-discriminator',
  phase: '3-commcare',
  skill: 'pdd-to-deliver-app',
  question: 'Which field discriminates a payable meeting?',
  'ai-default': 'payable_slot',
  options: ['payable_slot', 'meeting_kind as 4th part'],
  source: 'PDD § Payment',
  status: 'ai-default',
  evidence_basis: 'stated',
  value_set_by: 'ace',
  plain: 'A plain line for a reviewer.',
};

const append = (existing: string, rows: unknown[]) =>
  composeAppendedLog({
    existingYamlText: existing,
    opportunity: 'spark-facilitator',
    run_id: NEW_RUN,
    rows,
    now: () => '2026-10-02T00:00:00.000Z',
  });

describe('the bug, on the un-retired log the fork used to carry (control)', () => {
  const log = parseDecisionsYaml(SOURCE);

  it('presents every Phase 3-8 row as live', () => {
    expect(liveAtOrAfter(log, 3)).toHaveLength(8);
  });

  it('silently skips the re-run producer: the stale row wins', () => {
    const r = append(SOURCE, [reRunRow]);
    expect(r.skipped).toEqual(['deliver-latitude-payability-discriminator']);
    const after = parseDecisionsYaml(r.content);
    expect(resolveDecision(after, reRunRow.id)?.['ai-default']).not.toBe('payable_slot');
  });
});

describe('the retired log ace-web now writes', () => {
  const log = parseDecisionsYaml(FORKED);

  it('keeps every inherited row (the audit trail crosses the fork)', () => {
    expect(log.decisions).toHaveLength(parseDecisionsYaml(SOURCE).decisions.length);
  });

  it('has no live row at or after the fork phase', () => {
    expect(liveAtOrAfter(log, 3)).toEqual([]);
  });

  it('leaves pre-fork rows live and untouched (negative control)', () => {
    const src = parseDecisionsYaml(SOURCE).decisions.filter((d) => d.phase === '1-design');
    expect(log.decisions.filter((d) => d.phase === '1-design')).toEqual(src);
    expect(liveDecisions(log).map((d) => d.id)).toEqual([
      'archetype-selection',
      'pilot-scope-window',
      'llo-payment-per-visit-revised',
    ]);
  });

  it('frees the canonical id: a lookup finds nothing until the phase re-runs', () => {
    expect(resolveDecision(log, 'deliver-latitude-payability-discriminator')).toBeUndefined();
  });

  it("lets the re-run producer append, and the inherited row then chains to it", () => {
    const r = append(FORKED, [reRunRow]);
    expect(r.skipped).toEqual([]);
    expect(r.added).toBe(1);
    const after = parseDecisionsYaml(r.content);
    expect(resolveDecision(after, reRunRow.id)?.['ai-default']).toBe('payable_slot');
    expect(
      resolveDecision(after, `deliver-latitude-payability-discriminator-${SRC_RUN}`)?.id,
    ).toBe(reRunRow.id);
  });

  it('keeps `inherited_from_run` through an append round-trip (schema declares it)', () => {
    const after = parseDecisionsYaml(append(FORKED, [reRunRow]).content);
    const stale = after.decisions.find(
      (d) => d.id === `deliver-latitude-payability-discriminator-${SRC_RUN}`,
    );
    expect(stale?.inherited_from_run).toBe(SRC_RUN);
  });

  it('keeps retired rows out of the build memo', () => {
    const live = liveDecisionRows(log.decisions) as { id: string }[];
    expect(live.map((d) => d.id)).not.toContain(`program-reuse-vs-create-${SRC_RUN}`);
    expect(live).toHaveLength(3);
  });

  it('renders inherited rows as history in the decisions doc, not as live choices', () => {
    const text = renderedText(log);
    expect(text).toContain(`carried in from run ${SRC_RUN}`);
    // A retired row that once corrected another must not claim to be live.
    const verbatim = `learn-ambiguity-step-name-ampersand-${SRC_RUN}\` (this row is the live value)`;
    expect(text).not.toContain(verbatim);
  });
});
