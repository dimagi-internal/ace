/**
 * Readiness staleness by CONTENT, not timestamp.
 *
 * A clone's own rewrites (drive_ids: source Drive ids → copy ids; asset_refs:
 * HQ space, app/build ids, Connect program/opportunity/org) bump every copied
 * artifact's modifiedTime past the verdict graded on it. Judged by timestamp,
 * every eval of a cloned run was `eval-stale` — a re-grade, a waiver or an
 * extra readiness pass per artifact — for content that is exactly what was
 * graded with ids substituted. The content ledger records those pure mapped
 * rewrites; anything it cannot vouch for falls back to the timestamp rule.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  assessGates,
  buildReleaseVerdict,
  canonicalText,
  CONTENT_LEDGER_NAME,
  contentSha,
  effectiveContentTime,
  emptyContentLedger,
  extendIdMap,
  isPureMappedRewrite,
  parseContentLedger,
  readinessAgentWork,
  recordMappedRewrite,
  releaseGate,
  runLastWrite,
  type ContentLedger,
  type RunFile,
} from '../../lib/release-readiness';
import { buildReleasePlan, runStateHash } from '../../lib/release-plan';

const PAIRS = [
  { kind: 'hq_domain', from: 'connect-ace-dimagi', to: 'connect-ace-spark' },
  { kind: 'opportunity', from: 'a1b2c3d4-0000-1111-2222-333344445555', to: 'ffeeddcc-9999-8888-7777-666655554444' },
  { kind: 'drive_id', from: '1SourceDocIdAAAAAAAAAAAAAAAAAAAAAAAA', to: '1CopyDocIdBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
];
const ORIGINAL = [
  '# Build memo',
  'Apps live in connect-ace-dimagi. Opportunity a1b2c3d4-0000-1111-2222-333344445555 (a1b2c3d4).',
  'PDD: https://docs.google.com/document/d/1SourceDocIdAAAAAAAAAAAAAAAAAAAAAAAA/edit',
].join('\n');
const REWRITTEN = ORIGINAL.replace(/connect-ace-dimagi/g, 'connect-ace-spark')
  .replace(/a1b2c3d4-0000-1111-2222-333344445555/g, 'ffeeddcc-9999-8888-7777-666655554444')
  .replace(/1SourceDocIdAAAAAAAAAAAAAAAAAAAAAAAA/g, '1CopyDocIdBBBBBBBBBBBBBBBBBBBBBBBBBBB');

const ledgerWith = (pairs = PAIRS): ContentLedger => ({ ...emptyContentLedger('spark/spark-facilitator/20260926-1800'), id_map: extendIdMap([], pairs) });
const ledgerFile = (l: ContentLedger, modifiedTime = '2026-10-16T10:30:00Z'): RunFile => ({ path: CONTENT_LEDGER_NAME, modifiedTime, text: stringifyYaml(l) });

describe('canonical text — a pure mapped rewrite canonicalises to the original', () => {
  it('equal under the map, whatever direction', () => {
    expect(isPureMappedRewrite(ORIGINAL, REWRITTEN, PAIRS)).toBe(true);
    expect(canonicalText(ORIGINAL, PAIRS)).toBe(canonicalText(REWRITTEN, PAIRS));
  });
  it('any other change is not pure', () => {
    expect(isPureMappedRewrite(ORIGINAL, REWRITTEN + '\nA new paragraph.', PAIRS)).toBe(false);
    expect(isPureMappedRewrite(ORIGINAL, REWRITTEN.replace('Build memo', 'Build note'), PAIRS)).toBe(false);
  });
  it('a target id already present in the original does not break it (symmetric, not a reverse substitution)', () => {
    const before = `${ORIGINAL}\nTarget space will be connect-ace-spark.`;
    const after = `${REWRITTEN}\nTarget space will be connect-ace-spark.`;
    expect(isPureMappedRewrite(before, after, PAIRS)).toBe(true);
  });
  it('tokens match whole: a slug inside a longer slug is untouched', () => {
    const p = [{ from: 'spark-nm', to: 'spark2-nm' }];
    expect(canonicalText('org spark-nm-old', p)).toBe('org spark-nm-old');
    expect(canonicalText('org spark-nm.', p)).not.toBe('org spark-nm.');
  });
  it('CRLF / BOM / trailing blank lines are not content', () => {
    expect(contentSha('﻿a\r\nb\n\n\n')).toBe(contentSha('a\nb'));
  });
});

describe('recordMappedRewrite — the ledger the clone writes', () => {
  it('records content_as_of = the time of the content it rewrote, and chains', () => {
    let l = ledgerWith();
    l = recordMappedRewrite(l, '4-connect/build-memo.md', { modifiedTime: '2026-10-16T10:00:00Z', text: ORIGINAL }, { modifiedTime: '2026-10-16T10:05:00Z', text: REWRITTEN }, 'clone-run:drive_ids');
    const e1 = l.files['4-connect/build-memo.md'];
    expect(e1).toMatchObject({ modified_after: '2026-10-16T10:05:00Z', content_as_of: '2026-10-16T10:00:00Z', origin_hash: contentSha(ORIGINAL), pairs: 3 });
    // A second pure rewrite (asset_refs) of the file as drive_ids left it keeps the original date.
    l = { ...l, id_map: extendIdMap(l.id_map, [{ from: 'Build memo', to: 'Build memo (Spark)' }]) };
    const third = REWRITTEN.replace('Build memo', 'Build memo (Spark)');
    l = recordMappedRewrite(l, '4-connect/build-memo.md', { modifiedTime: '2026-10-16T10:05:00Z', text: REWRITTEN }, { modifiedTime: '2026-10-16T10:40:00Z', text: third });
    expect(l.files['4-connect/build-memo.md']).toMatchObject({ content_as_of: '2026-10-16T10:00:00Z', origin_hash: contentSha(ORIGINAL), pairs: 4 });
    expect(l.files['4-connect/build-memo.md'].chain_hashes).toEqual([contentSha(ORIGINAL), contentSha(REWRITTEN)]);
  });
  it('refuses to vouch for a write that is not a pure rewrite', () => {
    const l = recordMappedRewrite(ledgerWith(), 'x.md', { modifiedTime: '2026-10-16T10:00:00Z', text: ORIGINAL }, { modifiedTime: '2026-10-16T10:05:00Z', text: REWRITTEN + ' and more' });
    expect(l.files['x.md']).toBeUndefined();
  });
  it('round-trips through YAML; a malformed ledger is ignored, never trusted', () => {
    const l = recordMappedRewrite(ledgerWith(), 'x.md', { modifiedTime: '2026-10-16T10:00:00Z', text: ORIGINAL }, { modifiedTime: '2026-10-16T10:05:00Z', text: REWRITTEN });
    expect(parseContentLedger(stringifyYaml(l))).toEqual(l);
    expect(parseContentLedger('schema_version: 2\nfiles: {}\nid_map: []')).toBeNull();
    expect(parseContentLedger('not: [yaml')).toBeNull();
  });
});

describe('effectiveContentTime', () => {
  const l = recordMappedRewrite(ledgerWith(), 'm.md', { modifiedTime: '2026-10-16T10:00:00Z', text: ORIGINAL }, { modifiedTime: '2026-10-16T10:45:00Z', text: REWRITTEN });
  it('mtime match → the content date', () => {
    expect(effectiveContentTime({ path: 'm.md', modifiedTime: '2026-10-16T10:45:00Z' }, l)).toMatchObject({ time: '2026-10-16T10:00:00Z', by: 'ledger-mtime' });
  });
  it('touched again but still canonical-equal (text in hand) → still the content date', () => {
    expect(effectiveContentTime({ path: 'm.md', modifiedTime: '2026-10-16T11:30:00Z', text: REWRITTEN + '\n\n' }, l)).toMatchObject({ time: '2026-10-16T10:00:00Z', by: 'ledger-content' });
  });
  it('really changed since → its own timestamp', () => {
    expect(effectiveContentTime({ path: 'm.md', modifiedTime: '2026-10-16T11:30:00Z', text: REWRITTEN + ' edited' }, l).by).toBe('timestamp');
    expect(effectiveContentTime({ path: 'm.md', modifiedTime: '2026-10-16T11:30:00Z' }, l).by).toBe('timestamp');
    expect(effectiveContentTime({ path: 'other.md', modifiedTime: '2026-10-16T11:30:00Z' }, l).by).toBe('timestamp');
  });
});

describe('assessGates — a clone\'s pure rewrite keeps the eval fresh', () => {
  const verdict = 'verdict: pass\noverall_score: 8.2\ngate:\n  threshold: 7\n';
  const evalFile: RunFile = { path: '4-connect/build-memo-eval_verdict.yaml', modifiedTime: '2026-10-16T10:00:30Z', text: verdict };
  const catalog = { qaSkills: new Set<string>(), evalSkills: new Set(['build-memo']) };
  const rs = { phases: {} };
  const stale = (files: RunFile[]) => assessGates(files, rs, catalog).filter((f) => f.id.startsWith('eval-stale'));

  it('without the ledger the rewrite 45 min later reads stale (the old behaviour)', () => {
    expect(stale([evalFile, { path: '4-connect/build-memo.md', modifiedTime: '2026-10-16T10:45:00Z' }])).toHaveLength(1);
  });
  it('with the asset_refs entry it is fresh', () => {
    const l = recordMappedRewrite(ledgerWith(), '4-connect/build-memo.md', { modifiedTime: '2026-10-16T10:00:00Z', text: ORIGINAL }, { modifiedTime: '2026-10-16T10:45:00Z', text: REWRITTEN });
    expect(stale([evalFile, { path: '4-connect/build-memo.md', modifiedTime: '2026-10-16T10:45:00Z' }, ledgerFile(l)])).toEqual([]);
  });
  it('a real regeneration after the rewrite is stale again', () => {
    const l = recordMappedRewrite(ledgerWith(), '4-connect/build-memo.md', { modifiedTime: '2026-10-16T10:00:00Z', text: ORIGINAL }, { modifiedTime: '2026-10-16T10:45:00Z', text: REWRITTEN });
    expect(stale([evalFile, { path: '4-connect/build-memo.md', modifiedTime: '2026-10-16T12:00:00Z', text: 'a regenerated memo' }, ledgerFile(l)])).toHaveLength(1);
  });
  it('a grade that carries artifact_sha256 of what it graded stays fresh while the content matches', () => {
    const graded: RunFile = { ...evalFile, text: `${verdict}artifact_sha256: ${contentSha(ORIGINAL)}\n` };
    expect(stale([graded, { path: '4-connect/build-memo.md', modifiedTime: '2026-10-16T12:00:00Z', text: ORIGINAL + '\r\n' }])).toEqual([]);
    expect(stale([graded, { path: '4-connect/build-memo.md', modifiedTime: '2026-10-16T12:00:00Z', text: 'changed' }])).toHaveLength(1);
  });
  it('the newest producer file is chosen by content date, not by the rewrite\'s timestamp', () => {
    // build-memo.source.md was really regenerated at 10:20; build-memo.md only rewritten at 10:45.
    const l = recordMappedRewrite(ledgerWith(), '4-connect/build-memo.md', { modifiedTime: '2026-10-16T10:00:00Z', text: ORIGINAL }, { modifiedTime: '2026-10-16T10:45:00Z', text: REWRITTEN });
    const out = stale([evalFile, { path: '4-connect/build-memo.md', modifiedTime: '2026-10-16T10:45:00Z' }, { path: '4-connect/build-memo.source.md', modifiedTime: '2026-10-16T10:20:00Z' }, ledgerFile(l)]);
    expect(out).toHaveLength(1);
    expect(out[0].detail).toMatch(/build-memo\.source\.md/);
  });
});

describe('readinessAgentWork — what `release-readiness.ts run` leaves to the agent', () => {
  const catalog = { qaSkills: new Set<string>(), evalSkills: new Set(['build-memo', 'idea-to-pdd']) };
  const rs = { phases: { 'idea-to-design': { steps: { 'idea-to-pdd': { status: 'done' } } } } };
  const now = '2026-10-16T12:00:00Z';
  const files: RunFile[] = [
    { path: '4-connect/build-memo-eval_verdict.yaml', modifiedTime: '2026-10-16T10:00:00Z', text: 'verdict: pass\n' },
    { path: '4-connect/build-memo.md', modifiedTime: '2026-10-16T11:00:00Z' },
    { path: '3-commcare/previews/apps-learn/01.png', modifiedTime: '2026-10-10T00:00:00Z' },
    { path: '3-commcare/previews/apps-learn/02.png', modifiedTime: '2026-10-11T00:00:00Z' },
    { path: '6-qa-and-training/previews/deck/01.png', modifiedTime: '2026-10-16T09:00:00Z' },
    { path: '6-qa-and-training/previews/deck/02.png', modifiedTime: '2026-10-16T09:01:00Z' },
  ];
  it('re-grades only the gates that are stale or missing, and names each frame to look at', () => {
    const w = readinessAgentWork(files, rs, catalog, now);
    expect(w.regrade.map((r) => r.skill).sort()).toEqual(['build-memo-eval', 'idea-to-pdd-eval']);
    expect(w.look).toEqual(['3-commcare/previews/apps-learn/02.png', '6-qa-and-training/previews/deck/01.png', '6-qa-and-training/previews/deck/02.png']);
  });
  it('a clone\'s pure rewrite asks for no re-grade', () => {
    const l = recordMappedRewrite(ledgerWith(), '4-connect/build-memo.md', { modifiedTime: '2026-10-16T10:00:00Z', text: ORIGINAL }, { modifiedTime: '2026-10-16T11:00:00Z', text: REWRITTEN });
    const w = readinessAgentWork([...files, ledgerFile(l)], { phases: {} }, catalog, now);
    expect(w.regrade).toEqual([]);
  });
});

describe('the release gate tolerates writes that are pure mapped rewrites', () => {
  const FIX = join(__dirname, '../fixtures/release-readiness/spark-20260926-1800');
  const files = JSON.parse(readFileSync(join(FIX, 'inventory.json'), 'utf8')) as RunFile[];
  const rsText = readFileSync(join(FIX, 'run_state.yaml'), 'utf8');
  const opts = { forward_source: false, allow_cross_workspace_forward: false, allow_shared_connect: false };
  const reviewers = [{ email: 'amina@spark.org', role: 'viewer' as const }];
  const { plan } = buildReleasePlan({
    workspace: 'spark', opp: 'spark-facilitator', runId: '20260926-1800', reviewers,
    runState: parseYaml(rsText), tenancy: { hq_domain: 'connect-ace-spark', connect_holding_org: 'spark-nm' },
    driveDocs: [], options: opts, aceWebBase: 'https://labs.connect.dimagi.com/ace', aceWebMembership: { members: [], pending_invites: [] },
  });
  const ready = buildReleaseVerdict({ workspace: 'spark', opp: 'spark-facilitator', runId: '20260926-1800', checkedAt: '2026-10-01T21:00:00Z', files, findings: [], reviewers, runStateHash: runStateHash(rsText), plan });
  const here = { workspace: 'spark', opp: 'spark-facilitator', runId: '20260926-1800', files, runStateHash: runStateHash(rsText), reviewers, options: opts };
  const lastBefore = runLastWrite(files);

  it('a recorded pure rewrite of a document after validation is not "the run changed"', () => {
    const l = recordMappedRewrite(ledgerWith(), '4-connect/build-memo.md', { modifiedTime: lastBefore, text: ORIGINAL }, { modifiedTime: '2026-10-02T00:00:00Z', text: REWRITTEN });
    const after = [...files, { path: '4-connect/build-memo.md', modifiedTime: '2026-10-02T00:00:00Z' }, ledgerFile(l, '2026-10-02T00:00:01Z')];
    expect(releaseGate(ready, { ...here, files: after })).toMatchObject({ ok: true });
  });
  it('the same write unrecorded still refuses', () => {
    const after = [...files, { path: '4-connect/build-memo.md', modifiedTime: '2026-10-02T00:00:00Z' }];
    expect(releaseGate(ready, { ...here, files: after }).reason).toMatch(/changed after the validation/);
  });
  it('run_state rewritten purely after validation passes; changed otherwise refuses', () => {
    const rsFile = files.find((f) => f.path === 'run_state.yaml')!;
    const newRs = rsText.replace(/connect-ace-dimagi/g, 'connect-ace-spark') + '\n';
    const l = recordMappedRewrite(ledgerWith(), 'run_state.yaml', { modifiedTime: rsFile.modifiedTime, originHash: runStateHash(rsText) }, { modifiedTime: '2026-10-02T00:00:00Z' });
    const after = [...files.filter((f) => f.path !== 'run_state.yaml'), { ...rsFile, modifiedTime: '2026-10-02T00:00:00Z' }, ledgerFile(l)];
    expect(releaseGate(ready, { ...here, files: after, runStateHash: runStateHash(newRs + 'x: 1\n') })).toMatchObject({ ok: true });
    // Not recorded → the hash mismatch refuses.
    const unrecorded = [...files.filter((f) => f.path !== 'run_state.yaml'), { ...rsFile, modifiedTime: '2026-10-02T00:00:00Z' }];
    expect(releaseGate(ready, { ...here, files: unrecorded, runStateHash: runStateHash(newRs + 'x: 1\n') }).ok).toBe(false);
  });
});
