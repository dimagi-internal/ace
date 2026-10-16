/**
 * Grades carry `artifact_sha256`, stamped once in ace-gdrive's shared write
 * path (ace#3092 item 1) — so readiness judges every gate by content, not only
 * the files a clone rewrote and recorded.
 */
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { captureSegments, stampGateArtifactSha, type RunTreeReader } from '../../lib/gate-artifact-hash';
import { assessGates, contentSha, type RunFile } from '../../lib/release-readiness';
import { aggregateQAResult, validateQAResult } from '../../lib/qa-types';
import { stringify as stringifyYaml } from 'yaml';

const MEMO = '# Build memo\nApps live in connect-ace-dimagi.\n';

/** run/ ─ 1-design/{idea-to-pdd.md (a Doc), idea-to-pdd-eval_verdict.yaml}, 3-commcare/… */
function tree(over: Partial<Record<string, { mimeType: string; text: string }>> = {}): RunTreeReader & { reads: string[] } {
  const folders: Record<string, { name: string; parents: string[] }> = {
    run: { name: '20261015-1129', parents: ['opp'] },
    design: { name: '1-design', parents: ['run'] },
    commcare: { name: '3-commcare', parents: ['run'] },
  };
  const kids: Record<string, Record<string, { id: string; mimeType: string }>> = {
    run: { '1-design': { id: 'design', mimeType: 'application/vnd.google-apps.folder' }, '3-commcare': { id: 'commcare', mimeType: 'application/vnd.google-apps.folder' } },
    design: { 'idea-to-pdd.md': { id: 'pdd', mimeType: 'application/vnd.google-apps.document' } },
    commcare: { 'app-release_summary.md': { id: 'sum', mimeType: 'text/markdown' }, 'shot.png': { id: 'png', mimeType: 'image/png' } },
  };
  const texts: Record<string, string> = { pdd: '﻿' + MEMO, sum: 'released build 42\r\n', ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, v!.text])) };
  const reads: string[] = [];
  return {
    reads,
    async folder(id) {
      if (!folders[id]) throw new Error(`no folder ${id}`);
      return folders[id];
    },
    async child(parent, name) {
      return kids[parent]?.[name] ?? null;
    },
    async readText(id) {
      reads.push(id);
      return texts[id];
    },
  };
}

const verdict = (capture: unknown, extra = '') =>
  `skill: idea-to-pdd-eval\ntarget: noora\nran_at: '2026-10-16T10:00:00Z'\ncapture_path: ${JSON.stringify(capture)}\noverall_score: 8.2\nverdict: pass\n${extra}`;

describe('stampGateArtifactSha — the graded artifact\'s hash, appended in the write path', () => {
  it('a verdict in a phase folder: capture_path resolves from the RUN, the hash is readiness\'s contentSha', async () => {
    const r = await stampGateArtifactSha('idea-to-pdd-eval_verdict.yaml', verdict('1-design/idea-to-pdd.md'), 'design', tree());
    expect(r.stamped).toBe(contentSha(MEMO));
    expect(parseYaml(r.text)).toMatchObject({ verdict: 'pass', overall_score: 8.2, artifact_sha256: contentSha(MEMO) });
    // Everything the grader wrote is untouched; the field is only appended.
    expect(r.text.startsWith(verdict('1-design/idea-to-pdd.md'))).toBe(true);
  });

  it('a grade in one phase can name an artifact in another', async () => {
    const r = await stampGateArtifactSha('app-release-eval_verdict.yaml', verdict('/3-commcare/app-release_summary.md'), 'design', tree());
    expect(r.stamped).toBe(contentSha('released build 42'));
  });

  it('the QA result the shared writer builds stays a valid QA result with the field', async () => {
    // Exactly what scripts/qa-result.ts writes.
    const qa = stringifyYaml(aggregateQAResult({
      skill: 'idea-to-pdd-qa', target: 'noora', capture_path: '1-design/idea-to-pdd.md',
      outcomes: [{ check: 'sections', type: 'static', result: { pass: true, detail: 'ok' } }],
    }), { lineWidth: 0 });
    const r = await stampGateArtifactSha('idea-to-pdd-qa_result.yaml', qa, 'design', tree());
    expect(r.stamped).toBeTruthy();
    expect(validateQAResult(parseYaml(r.text)).artifact_sha256).toBe(r.stamped);
  });

  it('leaves the grade exactly as written when it cannot vouch', async () => {
    const reader = tree();
    const cases: Array<[string, string, string | null]> = [
      ['build-memo.md', verdict('1-design/idea-to-pdd.md'), 'design'], // not a gate
      ['x-eval_verdict.yaml', verdict('1-design/idea-to-pdd.md', `artifact_sha256: ${'a'.repeat(64)}\n`), 'design'], // grader's own hash wins
      ['x-eval_verdict.yaml', verdict('4-connect/a.md + 4-connect/b.md'), 'design'], // two artifacts
      ['x-eval_verdict.yaml', verdict('runs/20260925-1536/3-commcare/x.md'), 'design'], // not run-relative
      ['x-eval_verdict.yaml', verdict('1-design/missing.md'), 'design'], // not in the run
      ['x-eval_verdict.yaml', verdict('3-commcare/shot.png'), 'design'], // media
      ['x-eval_verdict.yaml', verdict('1-design/idea-to-pdd.md'), null], // no parent
      ['x-eval_verdict.yaml', verdict('1-design/idea-to-pdd.md'), 'nowhere'], // Drive error
      ['x-eval_verdict.yaml', 'skill: x\ncapture_path: 1-design/idea-to-pdd.md\nverdict: pass\nnotes: |\n  trailing block', 'design'],
    ];
    for (const [name, text, parent] of cases) {
      const r = await stampGateArtifactSha(name, text, parent, reader);
      if (r.stamped) {
        // The trailing block scalar case is allowed to stamp ONLY if nothing else changed.
        const { artifact_sha256: _x, ...rest } = parseYaml(r.text);
        expect(rest).toEqual(parseYaml(text));
      } else {
        expect(r.text).toBe(text);
      }
    }
  });

  it('captureSegments accepts exactly what readiness\'s capturedArtifact can match', () => {
    expect(captureSegments('1-design/idea-to-pdd.md')).toEqual(['1-design', 'idea-to-pdd.md']);
    expect(captureSegments('/1-design/idea-to-pdd.md')).toEqual(['1-design', 'idea-to-pdd.md']);
    expect(captureSegments('a.md + b.md')).toBeNull();
    expect(captureSegments('../x.md')).toBeNull();
    expect(captureSegments(42)).toBeNull();
  });
});

describe('a stamped grade keeps its gate fresh in readiness', () => {
  it('an artifact re-saved after the grade with the same content is not stale; changed content is', async () => {
    const r = await stampGateArtifactSha('idea-to-pdd-eval_verdict.yaml', verdict('1-design/idea-to-pdd.md'), 'design', tree());
    const catalog = { qaSkills: new Set<string>(), evalSkills: new Set(['idea-to-pdd']) };
    const gate: RunFile = { path: '1-design/idea-to-pdd-eval_verdict.yaml', modifiedTime: '2026-10-16T10:00:00Z', text: r.text };
    const stale = (artifact: RunFile) => assessGates([gate, artifact], { phases: {} }, catalog).filter((f) => f.id.startsWith('eval-stale'));
    expect(stale({ path: '1-design/idea-to-pdd.md', modifiedTime: '2026-10-16T12:00:00Z', text: MEMO })).toEqual([]);
    expect(stale({ path: '1-design/idea-to-pdd.md', modifiedTime: '2026-10-16T12:00:00Z', text: MEMO + 'a new section\n' })).toHaveLength(1);
  });
});
