/**
 * ace#1907 — should `drive_create_file` / `drive_create_doc_from_markdown`
 * REFUSE an oversized inline payload, and if so, above what?
 *
 * ace#1780 shipped `localFilePath` on both (purely additive) and deliberately
 * held back the refusal half, because the obvious number — the 40,000 that
 * `drive_update_file` already uses — is BELOW that issue's own 51,951-char
 * repro PDD. Shipping it blind would have broken Phase 1 on the very run that
 * produced the issue.
 *
 * This file is the measurement, made executable. It drives the REAL resolver
 * with payloads of the REAL measured lengths, so "a 40,000 ceiling refuses
 * these six producers" is a thing CI evaluates rather than a claim in a PR
 * body that goes stale.
 *
 * ── The corpus ────────────────────────────────────────────────────────────
 * Measured 2026-09-02 by walking ACE's live Drive root, exporting every Google
 * Doc under `ACE/<opp>/` and `ACE/<opp>/runs/<run>/` to text/plain and counting
 * characters. 1,588 artifacts; 16 binaries excluded (those go via
 * `drive_upload_binary`, not these atoms), leaving 1,572 candidates across 20
 * opportunities and 49 run-scopes.
 *
 * The conversion this decision is sequenced behind is tracked as ace#1918.
 *
 * ── NEGATIVE-CONTROL NOTE ─────────────────────────────────────────────────
 * This change adds no new source symbol — there is no fix to revert — so the
 * usual "revert the source, watch it go red" does not apply to most of it.
 * Two things stand in:
 *   - the atom-description assertions in the last describe() DO go red against
 *     pre-change `mcp/google-drive-server.ts`, on assertions;
 *   - `CONTROL:` below runs UNTOUCHED `resolveUpdateFileContent` against the
 *     issue's own repro and shows the sibling ceiling refusing it. That is the
 *     assertion that actually decides the question, and nothing in this PR
 *     modifies the code it exercises.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveInlineOrLocalFile,
  resolveUpdateFileContent,
  UPDATE_FILE_INLINE_CEILING,
  AtomArgUsageError,
} from '../../lib/atom-payload-resolver.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Percentiles over the 1,572 measured text artifacts. */
const CORPUS = {
  n: 1572,
  opps: 20,
  runScopes: 49,
  p50: 5_448,
  p75: 11_052,
  p90: 20_222,
  p95: 29_772,
  p99: 60_671,
  max: 224_003,
  over40k: 55,
} as const;

/**
 * Every artifact NAME measured above 40,000 chars, with the producer that
 * writes it and whether that write is actually exposed to a ceiling on these
 * two atoms.
 *
 * `exposed: false` is the correction worth carrying: `run_state.yaml` and
 * `decisions.yaml` are the two largest YAMLs in the corpus and neither is at
 * risk — both are CREATED nearly empty here and grown by `update_yaml_file` /
 * `decisions_append_rows`, which do not route through this resolver.
 */
const OVER_40K = [
  { name: 'ocs-chatbot-qa_transcript-deep.md', max: 224_003, seen: 3, producer: 'ocs-chatbot-qa', exposed: true, converted: false },
  { name: 'audit_matrix.json', max: 193_788, seen: 1, producer: '(ad-hoc, not a manifest artifact)', exposed: false, converted: false },
  { name: 'run_state.yaml', max: 146_907, seen: 8, producer: 'ace-orchestrator (grown by update_yaml_file)', exposed: false, converted: false },
  { name: 'decisions.yaml', max: 73_096, seen: 8, producer: 'ace-orchestrator (grown by decisions_append_rows)', exposed: false, converted: false },
  { name: 'idea-to-pdd.md', max: 71_074, seen: 10, producer: 'idea-to-pdd', exposed: true, converted: true },
  { name: 'decisions.gdoc', max: 63_142, seen: 5, producer: 'decisions-render', exposed: true, converted: false },
  { name: 'pdd-to-test-prompts.md', max: 59_737, seen: 5, producer: 'pdd-to-test-prompts', exposed: true, converted: false },
  { name: 'training-deck-spec.yaml', max: 55_719, seen: 1, producer: 'training-deck-generate', exposed: true, converted: false },
  { name: 'idea-to-pdd.source.md', max: 52_427, seen: 3, producer: 'idea-to-pdd', exposed: true, converted: true },
  { name: 'solicitation-create_published.md', max: 51_920, seen: 3, producer: 'solicitation-create', exposed: true, converted: false },
  { name: 'solicitation-create_draft.md', max: 49_531, seen: 3, producer: 'solicitation-create', exposed: true, converted: false },
  { name: 'pdd-to-deliver-app-eval_verdict.yaml', max: 44_716, seen: 2, producer: 'pdd-to-deliver-app-eval', exposed: true, converted: false },
  { name: 'app-screenshot-capture_manifest.yaml', max: 43_778, seen: 3, producer: 'app-screenshot-capture', exposed: true, converted: false },
] as const;

/** Would this payload length be accepted by the create atoms at `ceiling`? */
function accepts(len: number, ceiling?: number): boolean {
  try {
    resolveInlineOrLocalFile({
      atom: 'drive_create_file',
      inlineParam: 'content',
      inline: 'x'.repeat(len),
      inlineCeiling: ceiling,
    });
    return true;
  } catch (e) {
    if (e instanceof AtomArgUsageError) return false;
    throw e;
  }
}

describe('the corpus fixture is internally consistent', () => {
  it('every enumerated name is above 40,000', () => {
    for (const a of OVER_40K) expect(a.max, a.name).toBeGreaterThan(40_000);
  });

  it('the enumerated occurrences account for the measured >40k count', () => {
    expect(OVER_40K.reduce((n, a) => n + a.seen, 0)).toBe(CORPUS.over40k);
  });

  it('the distribution is monotonic and the max is the deep transcript', () => {
    expect(CORPUS.p50).toBeLessThan(CORPUS.p90);
    expect(CORPUS.p90).toBeLessThan(CORPUS.p95);
    expect(CORPUS.p95).toBeLessThan(CORPUS.p99);
    expect(CORPUS.p99).toBeLessThan(CORPUS.max);
    expect(Math.max(...OVER_40K.map((a) => a.max))).toBe(CORPUS.max);
  });
});

describe('today: the create atoms impose NO ceiling (ace#1780, upheld by ace#1907)', () => {
  it('accepts every artifact size measured in the corpus', () => {
    for (const a of OVER_40K) expect(accepts(a.max), a.name).toBe(true);
    expect(accepts(CORPUS.max)).toBe(true);
  });

  it('still refuses both-or-neither, so the contract is not weakened by the absence', () => {
    // The ceiling is the only thing left unset; exactly-one is enforced.
    expect(() => resolveInlineOrLocalFile({ atom: 'a', inlineParam: 'content' }))
      .toThrow(AtomArgUsageError);
    expect(() => resolveInlineOrLocalFile({
      atom: 'a', inlineParam: 'content', inline: 'x', localFilePath: '/tmp/y',
    })).toThrow(AtomArgUsageError);
  });
});

describe('a 40,000 ceiling: does the job, and breaks six producers', () => {
  const refused = OVER_40K.filter((a) => !accepts(a.max, 40_000));

  it('refuses every artifact the corpus measured above 40,000', () => {
    expect(refused.map((a) => a.name).sort()).toEqual(OVER_40K.map((a) => a.name).sort());
  });

  it('the refusal reaches SIX unconverted producers, across five phases', () => {
    // These are recurring per-run artifacts, not outliers: each was measured
    // on multiple runs. A refusal here is a hard failure in a phase that works
    // today, which is why ace#1780 held this half back.
    const broken = [...new Set(
      refused.filter((a) => a.exposed && !a.converted).map((a) => a.producer),
    )].sort();
    expect(broken).toEqual([
      'app-screenshot-capture',
      'decisions-render',
      'ocs-chatbot-qa',
      'pdd-to-deliver-app-eval',
      'pdd-to-test-prompts',
      'solicitation-create',
      'training-deck-generate',
    ]);
  });

  it('the largest files in the corpus are NOT among them — they are grown, not created', () => {
    // The tempting reading is "the orchestrator writes a 147 KB run_state.yaml
    // through drive_create_file". It does not: the create is nearly empty and
    // update_yaml_file / decisions_append_rows grow it, neither of which goes
    // through this resolver. Getting this wrong inflates the blast radius.
    const notExposed = OVER_40K.filter((a) => !a.exposed).map((a) => a.name);
    expect(notExposed).toContain('run_state.yaml');
    expect(notExposed).toContain('decisions.yaml');
  });

  it('when it does fire, the refusal is TYPED and names the remedy', () => {
    // A refusal an agent can act on is recoverable; one that just fails is not.
    let err: unknown;
    try {
      resolveInlineOrLocalFile({
        atom: 'drive_create_file', inlineParam: 'content',
        inline: 'x'.repeat(50_000), inlineCeiling: 40_000,
      });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AtomArgUsageError);
    expect((err as Error).message).toMatch(/oversized_inline_content/);
    expect((err as Error).message).toMatch(/localFilePath/);
  });
});

describe('a 100,000 ceiling: nearly safe, and therefore does not do the job', () => {
  it('exposes only ONE recurring skill producer', () => {
    const broken = OVER_40K
      .filter((a) => a.exposed && !a.converted && !accepts(a.max, 100_000))
      .map((a) => a.producer);
    expect(broken).toEqual(['ocs-chatbot-qa']);
  });

  it('but lets the documents the issue was FILED about go inline', () => {
    // ace#1780's repro is a 51,951-char PDD; ace#1907 exists because a
    // preference in prose runs well under 100%. A ceiling that does not cover
    // the PDD or the test prompts leaves that preference exactly as advisory.
    expect(accepts(51_951, 100_000)).toBe(true);
    expect(accepts(59_737, 100_000)).toBe(true);   // pdd-to-test-prompts
  });
});

describe('CONTROL: the sibling number, on untouched code, refuses the issue’s own repro', () => {
  it('resolveUpdateFileContent (40,000, unmodified by this PR) rejects the 51,951-char PDD', () => {
    // This is the assertion that decides the question, and it runs against
    // code this change does not touch. `drive_update_file` survives its 40,000
    // ceiling only because ACE's largest writers do not use it —
    // `update_yaml_file` builds its body server-side. The create atoms have no
    // such escape: their callers hand over the whole document.
    expect(UPDATE_FILE_INLINE_CEILING).toBe(40_000);
    expect(UPDATE_FILE_INLINE_CEILING).toBeLessThan(CORPUS.p99);
    expect(() => resolveUpdateFileContent({ content: 'x'.repeat(51_951) }))
      .toThrow(/oversized_inline_content/);
  });

  it('40,000 is below the corpus p99, so it is not a tail-only guard', () => {
    // A ceiling above p99 would refuse rare outliers. This one refuses 3.50%
    // of everything ACE writes, and the refused set is its primary artifacts.
    expect(UPDATE_FILE_INLINE_CEILING).toBeLessThan(CORPUS.p99);
    expect(CORPUS.over40k / CORPUS.n).toBeGreaterThan(0.03);
  });
});

describe('the atom descriptions state a measurable threshold, not "large"', () => {
  const server = readFileSync(
    join(__dirname, '../../mcp/google-drive-server.ts'), 'utf8',
  );

  it.each(['drive_create_file', 'drive_create_doc_from_markdown'])(
    '%s tells a caller WHERE the preference starts',
    (tool) => {
      const at = server.indexOf(`'${tool}',`);
      expect(at, `${tool} is not registered`).toBeGreaterThan(-1);
      const src = server.slice(at, server.indexOf('server.tool(', at));
      // "Prefer localFilePath for anything large" is unactionable — every
      // caller decides "large" differently, which is how a preference runs
      // under 100%. Name the measured number instead.
      expect(src).toMatch(/40,000 characters/);
      expect(src).toMatch(/ace#1907/);
    },
  );
});
