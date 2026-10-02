/**
 * `lib/build-memo-compose.ts` — the deterministic half of the run's build memo,
 * driven by the run that exposed every defect it covers.
 *
 * Fixtures (`test/fixtures/build-memo/spark-facilitator-20260926-1800/`), all
 * captured from that run on 2026-10-01 (read-only):
 *   - `run_state.yaml`      — the run's run_state (OCS embed key redacted);
 *   - `decisions.yaml`      — the run-root decisions.yaml (117 rows; CRLF→LF);
 *   - `build-memo.source.md`— the memo build-memo-eval graded 6.2 `warn`,
 *                             verbatim. Its section 4 is connect-opp-setup's
 *                             own memo section, quoted verbatim;
 *   - `pdd.txt`             — the PDD as a text/plain export;
 *   - `regenerated-build-memo.md` — what the FIXED generator produces for the
 *                             same inputs: `scripts/build-memo-compose.ts
 *                             --frame` output, a plain-language account of the
 *                             build's choices written per the new SKILL.md, and
 *                             the producers' sections moved to the appendix.
 *                             build-memo-eval re-graded it (see the PR).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  checkEnforcementScope,
  checkMemoReviewerFrame,
  checkMemoRunLabel,
  checkReviewerLanguage,
  composeMemoFrame,
  decisionsYouOwn,
  enforcementPoints,
  glossaryFromPdd,
  isGlossed,
  knownLimitations,
  memoEnforcementRows,
  parsePhase4RuleTable,
  renderFrameHead,
  renderMemoTitle,
  rescopeRuleRow,
  ruleRowsFromDecisions,
  ruleScope,
  runMemoChecks,
} from '../../lib/build-memo-compose';

const FIX = join(__dirname, '../fixtures/build-memo/spark-facilitator-20260926-1800');
const RUN_STATE = parseYaml(readFileSync(join(FIX, 'run_state.yaml'), 'utf8')) as Record<string, any>;
const DECISIONS = (parseYaml(readFileSync(join(FIX, 'decisions.yaml'), 'utf8')) as { decisions: unknown[] }).decisions;
const OLD_MEMO = readFileSync(join(FIX, 'build-memo.source.md'), 'utf8');
const NEW_MEMO = readFileSync(join(FIX, 'regenerated-build-memo.md'), 'utf8');
const PDD = readFileSync(join(FIX, 'pdd.txt'), 'utf8');
const RULES = parsePhase4RuleTable(OLD_MEMO);
const FRAME = composeMemoFrame({
  runState: RUN_STATE,
  decisions: DECISIONS,
  phase4Section: OLD_MEMO,
  pddText: PDD,
  displayName: 'Spark Facilitator',
});
const FRAME_MEMO = `${renderFrameHead(FRAME)}\n\n${FRAME.appendix}\n`;
const LIM = knownLimitations(RUN_STATE, RULES);
const ASKS = decisionsYouOwn(RUN_STATE, DECISIONS, LIM);

describe('(a) the title and every run label come from run_state.run_id', () => {
  it('renders the CURRENT run, never the fork source', () => {
    expect(renderMemoTitle(RUN_STATE, 'Spark Facilitator')).toBe('# Build memo — Spark Facilitator · run 20260926-1800');
    expect(FRAME.title).not.toContain('20260925-1536');
  });

  it('refuses to title a memo with no run id', () => {
    expect(() => renderMemoTitle({ ...RUN_STATE, run_id: undefined }, 'Spark Facilitator')).toThrow(/run_id/);
  });

  it('fails the carried-over memo: titled with the fork source, and a producer header naming it', () => {
    const r = checkMemoRunLabel(OLD_MEMO, RUN_STATE);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('title-wrong-run');
    expect(r.findings.some((f) => f.detail.includes('spark-facilitator/20260925-1536'))).toBe(true);
  });

  it('passes the regenerated memo, whose one mention of the source says it is the fork source', () => {
    const r = checkMemoRunLabel(NEW_MEMO, RUN_STATE);
    expect(r.ok).toBe(true);
    expect(NEW_MEMO).toContain('copy (fork) of run 20260925-1536');
  });

  it('does not mistake the opportunity NAME, which embeds the source id, for a run label', () => {
    const name = RUN_STATE.phases['connect-setup'].products.connect.opportunity.name as string;
    expect(name).toContain('20260925-1536');
    expect(checkMemoRunLabel(`${FRAME.title}\n\nOpportunity: ${name}\n`, RUN_STATE).ok).toBe(true);
  });
});

describe('(b) each rule is credited to an enforcement point at the right scope', () => {
  it('reads the scope off the rule text', () => {
    const byRule = Object.fromEntries(RULES.map((r) => [r.rule, ruleScope(r.rule)]));
    expect(byRule['At most 1 payable meeting per CBF per day']).toBe('per-worker');
    expect(byRule['total cap 21 per CBF']).toBe('per-worker');
    expect(byRule['each community earns at most 3 paid meetings per FCAP step']).toBe('per-case');
  });

  it('classifies the producer cells it was given', () => {
    const daily = RULES.find((r) => r.rule.startsWith('At most 1 payable'))!;
    expect(enforcementPoints(daily.whereApplied).map((p) => p.kind)).toEqual(['app-form', 'connect-payment-unit']);
  });

  it("fails connect-opp-setup's table as the run wrote it: both per-worker caps credited to app checks", () => {
    const r = checkEnforcementScope(RULES);
    expect(r.ok).toBe(false);
    expect(r.findings).toHaveLength(2);
    expect(r.findings.map((f) => f.kind)).toEqual([
      'per-worker-rule-credited-to-app-check',
      'per-worker-rule-credited-to-app-check',
    ]);
  });

  it('fails the same two rules where the run recorded them as decision rows ("CCZ constraint")', () => {
    const r = checkEnforcementScope(ruleRowsFromDecisions(DECISIONS));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.detail).join(' ')).toMatch(/per CBF per day[\s\S]*total cap 21 per CBF/);
  });

  it('passes every row once rescoped, and records what it corrected', () => {
    const fixed = RULES.map((r) => rescopeRuleRow(r, 'community'));
    expect(checkEnforcementScope(fixed.map((f) => f.row)).ok).toBe(true);
    expect(fixed.filter((f) => f.correction)).toHaveLength(2);
    expect(fixed.find((f) => f.row.rule.startsWith('At most 1'))!.row.whereApplied).toMatch(
      /^Connect payment unit .*\(per worker\)\. Supporting only: .*keyed on one community/,
    );
  });

  it("the regenerated memo's own enforcement table leads each per-worker cap with Connect's payment limit", () => {
    const rows = memoEnforcementRows(NEW_MEMO);
    expect(rows).toHaveLength(14);
    expect(checkEnforcementScope(rows).ok).toBe(true);
    // and the same table with the lead/support order swapped back is caught
    const swapped = NEW_MEMO.replace(
      /Connect payment limit — pays at most 1 per worker per day\. Also: A check in the app \(per community\)/,
      'A check in the app (per community). Also: Connect payment limit — pays at most 1 per worker per day',
    );
    expect(swapped).not.toBe(NEW_MEMO);
    expect(checkEnforcementScope(memoEnforcementRows(swapped)).ok).toBe(false);
  });
});

describe('(e) known limitations separate the real gap from rules off Connect by design', () => {
  it('finds the two verification rules Connect refused, and the four placed off-platform on purpose', () => {
    expect(LIM.gaps.map((g) => g.rule)).toEqual(['meeting_conducted = yes', 'meeting_type = community_meeting']);
    expect(LIM.byDesign).toHaveLength(4);
    expect(LIM.rulesSaved).toBe(0);
    expect(LIM.rulesIntended).toBe(2);
    expect(LIM.gaps[0].text).toMatch(/same organisation that runs the programme/);
  });

  it('falls back to run_state alone when the producer table is missing', () => {
    const lim = knownLimitations(RUN_STATE, []);
    expect(lim.gaps.map((g) => g.rule)).toEqual(['meeting_conducted = yes', 'meeting_type = community_meeting']);
  });

  it('renders "Connect saved 0 of the 2" and a separate by-design list', () => {
    expect(FRAME.knownLimitations).toContain('Connect saved 0 of the 2 verification rules');
    expect(FRAME.knownLimitations).toMatch(/real gaps[\s\S]*Checked outside Connect by design — not gaps/);
  });
});

describe('(d) decisions you own', () => {
  it('pulls the placeholder rate, the proposed terms, the enforcement gap and the translation sign-off', () => {
    const asks = ASKS.map((a) => a.ask);
    expect(asks[0]).toBe('Accept or replace the worker payment of 7,500 MWK per verified community meeting.');
    expect(asks.some((a) => /organisation of 3,000 MWK/.test(a))).toBe(true);
    expect(asks.some((a) => /total budget of 3,276,000 MWK/.test(a))).toBe(true);
    expect(asks.some((a) => /2026-11-02 to 2027-02-26/.test(a))).toBe(true);
    expect(asks.some((a) => /"meeting_conducted = yes" and "meeting_type = community_meeting" will be enforced/.test(a))).toBe(true);
    expect(asks.some((a) => /machine-translated Chichewa and Tumbuka/.test(a))).toBe(true);
    expect(ASKS).toHaveLength(6);
  });

  it("folds the run's OPEN verification decision into the gap ask instead of asking twice", () => {
    const gapAsk = ASKS.find((a) => /will be enforced/.test(a.ask))!;
    expect(gapAsk.refs).toContain('connect-ambiguity-form-field-rules-unreachable');
    expect(ASKS.filter((a) => /^Resolve:/.test(a.ask))).toHaveLength(0);
  });
});

describe('superseded decision rows do not drive the memo (ace#2578)', () => {
  // A fork inherits its source's Phase 4 rows and corrects them with
  // `supersedes:`; the write boundary stamps `superseded_by` on the old row.
  const OPEN_ROW = {
    id: 'connect-ambiguity-stale-open',
    phase: '4-connect',
    skill: 'connect-opp-setup',
    question: 'Is the stale verification question still open?',
    'ai-default': 'OPEN — apply on Phase 9 LLO opp',
    reasoning: 'OPEN — pending.',
  };
  const RULE_ROW = {
    id: 'connect-rule-stale',
    phase: '4-connect',
    skill: 'connect-opp-setup',
    question: "Where is the PDD verification rule 'stale rule' enforced?",
    'ai-default': 'CCZ constraint',
    reasoning: 'old placement',
  };
  const NO_GAPS = { ...LIM, gaps: [] };

  it('asks the reviewer to resolve a LIVE open row', () => {
    const asks = decisionsYouOwn(RUN_STATE, [OPEN_ROW], NO_GAPS).map((a) => a.ask);
    expect(asks).toContain(`Resolve: ${OPEN_ROW.question}`);
  });

  it('drops the same row once a later row superseded it', () => {
    const superseded = { ...OPEN_ROW, superseded_by: 'connect-ambiguity-resolved' };
    const asks = decisionsYouOwn(RUN_STATE, [superseded], NO_GAPS).map((a) => a.ask);
    expect(asks.some((a) => a.startsWith('Resolve:'))).toBe(false);
  });

  it('builds rule rows only from live rows', () => {
    expect(ruleRowsFromDecisions([RULE_ROW]).map((r) => r.rule)).toEqual(['stale rule']);
    expect(ruleRowsFromDecisions([{ ...RULE_ROW, superseded_by: 'connect-rule-new' }])).toEqual([]);
  });
});

describe('(c) plain language in the body', () => {
  it('fails the graded memo on internal references and un-glossed abbreviations', () => {
    const r = checkReviewerLanguage(OLD_MEMO, { decisionIds: DECISIONS.map((d: any) => d.id) });
    expect(r.ok).toBe(false);
    const kinds = new Set(r.findings.map((f) => f.kind));
    for (const k of ['issue-reference', 'decision-id', 'code-identifier', 'run-folder-path', 'unexplained-abbreviation']) {
      expect(kinds.has(k), k).toBe(true);
    }
    const abbr = r.findings.filter((f) => f.kind === 'unexplained-abbreviation').map((f) => f.detail);
    for (const a of ['CCZ', 'CBF', 'FCAP', 'DU', 'PU', 'LLO']) expect(abbr.some((d) => d.endsWith(` ${a}`)), a).toBe(true);
  });

  it('passes the frame and the regenerated memo; the appendix may name what the body may not', () => {
    expect(checkReviewerLanguage(FRAME_MEMO, { decisionIds: DECISIONS.map((d: any) => d.id) }).ok).toBe(true);
    const r = checkReviewerLanguage(NEW_MEMO, { decisionIds: DECISIONS.map((d: any) => d.id) });
    expect(r.ok).toBe(true);
    expect(NEW_MEMO.slice(NEW_MEMO.indexOf('## Appendix'))).toContain('connect-ambiguity-form-field-rules-unreachable');
  });

  it('takes the glossary from the PDD, in the partner’s words', () => {
    const g = glossaryFromPdd(PDD);
    expect(g.FCAP).toBe('Facilitated Collective Action Process');
    expect(g.CBF).toBe('Community Based Facilitator');
    expect(FRAME.intro).toContain('CBF — Community Based Facilitator');
  });

  it('does not count a bare parenthetical citation as a gloss', () => {
    expect(isGlossed(OLD_MEMO, 'CCZ')).toBe(false);
    expect(isGlossed(PDD, 'FCAP')).toBe(true);
  });
});

describe('(d)+(e) the reviewer frame leads the memo', () => {
  it('fails the graded memo: no limitations section, no decisions-you-own', () => {
    const r = checkMemoReviewerFrame(OLD_MEMO, LIM, ASKS);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind).sort()).toEqual(['no-decisions-you-own', 'no-known-limitations']);
  });

  it('fails a memo that states only some of the decisions, or buries them', () => {
    const short = NEW_MEMO.replace(/^6\. \*\*Have a native speaker[^\n]*\n/m, '');
    expect(checkMemoReviewerFrame(short, LIM, ASKS).ok).toBe(false);
    const buried = NEW_MEMO.replace('## Decisions you own', '## Notes\n\n## More notes\n\n## Decisions you own');
    expect(checkMemoReviewerFrame(buried, LIM, ASKS).findings.map((f) => f.kind)).toContain('decisions-you-own-buried');
  });

  it('passes the regenerated memo', () => {
    expect(checkMemoReviewerFrame(NEW_MEMO, LIM, ASKS).ok).toBe(true);
  });
});

describe('the whole gate, as scripts/build-memo-compose.ts --check runs it', () => {
  it('the graded memo fails all four checks', () => {
    const r = runMemoChecks({ memo: OLD_MEMO, runState: RUN_STATE, decisions: DECISIONS, phase4Section: OLD_MEMO });
    expect(Object.entries(r).filter(([, v]) => !v.ok).map(([k]) => k).sort()).toEqual(
      ['enforcement_scope', 'reviewer_frame', 'reviewer_language', 'run_label'],
    );
  });

  it('the regenerated memo passes all four', () => {
    const r = runMemoChecks({ memo: NEW_MEMO, runState: RUN_STATE, decisions: DECISIONS, phase4Section: OLD_MEMO });
    for (const [k, v] of Object.entries(r)) expect(v.ok, `${k}: ${v.detail}`).toBe(true);
  });

  it('the regenerated memo keeps the facts build-memo-eval anchors on (hard gate inputs)', () => {
    const body = NEW_MEMO.slice(0, NEW_MEMO.indexOf('## Appendix'));
    // payment, caps, dates, budget — as Connect holds them
    for (const fact of ['7,500 MWK', '3,000 MWK', 'at most 1 per worker per day', '21 per worker in total', '2026-11-02', '2027-02-26', '3,276,000 MWK', 'version 22', 'version 14']) {
      expect(body, fact).toContain(fact);
    }
    // the verification rules Connect did NOT save are never described as enforced
    expect(body).toMatch(/\| "meeting_conducted = yes" \| each record \| \*\*Not enforced\*\*/);
  });
});
