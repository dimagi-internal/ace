/**
 * validate-release-readiness over the REAL evidence of spark-facilitator/20260926-1800,
 * gathered read-only 2026-10-01 (test/fixtures/release-readiness/spark-20260926-1800/README.md).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  assessApps,
  assessChatbot,
  assessGates,
  assessLinks,
  assessPostcondition,
  assessPreviews,
  assessSurfaceAudit,
  buildReleaseVerdict,
  decidedFromRunState,
  releaseGate,
  renderReleaseReport,
  type RunFile,
} from '../../lib/release-readiness';

const FIX = join(__dirname, '../fixtures/release-readiness/spark-20260926-1800');
const json = <T>(n: string): T => JSON.parse(readFileSync(join(FIX, n), 'utf8')) as T;
const text = (n: string) => readFileSync(join(FIX, n), 'utf8');
const catalog = {
  qaSkills: new Set(['idea-to-pdd', 'pdd-to-work-order', 'pdd-to-test-prompts', 'app-release', 'demo-data-setup', 'semantic-registry-author']),
  evalSkills: new Set(['build-memo', 'training-deck-render', 'connect-opp-setup', 'semantic-registry-author', 'pdd-to-learn-app']),
};

describe('assessGates on the real Spark run', () => {
  it('flags the hand-rolled QA results, the unparseable verdict and every gate that never ran', () => {
    const files = json<RunFile[]>('inventory.json');
    const runState = parseYaml(text('run_state.yaml'));
    const ids = assessGates(files, runState, catalog).map((f) => f.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'qa-malformed:semantic-registry-author-qa',
        'qa-malformed:app-release-qa',
        'eval-unreadable:pdd-to-learn-app-eval',
        'qa-missing:demo-data-setup-qa',
        'eval-missing:build-memo-eval',
        'eval-missing:training-deck-render-eval',
      ]),
    );
    // A fork stamps copies seconds apart in either order — not staleness.
    expect(ids.filter((i) => i.startsWith('eval-stale:') || i.startsWith('qa-stale:'))).toEqual([]);
  });

  it('turns re-run gate results into the blockers they report', () => {
    const files = json<RunFile[]>('inventory.json');
    const now = new Date().toISOString();
    const overlaid: RunFile[] = [
      ...files,
      { path: '7-synthetic/demo-data-setup-qa_result.yaml', modifiedTime: now, text: text('demo-data-setup-qa_result.yaml') },
      { path: '6-qa-and-training/training-deck-render-eval_verdict.yaml', modifiedTime: now, text: text('training-deck-render-eval_verdict.yaml') },
      { path: '4-connect/build-memo-eval_verdict.yaml', modifiedTime: now, text: text('build-memo-eval_verdict.yaml') },
    ];
    const f = assessGates(overlaid, parseYaml(text('run_state.yaml')), catalog);
    const byId = Object.fromEntries(f.map((x) => [x.id, x]));
    expect(byId['qa-fail:demo-data-setup-qa'].detail).toMatch(/worker_review_url_scoped/);
    expect(byId['eval-below-band:training-deck-render-eval'].detail).toMatch(/fail 4\.66/);
    // warn is below the pass band — still a blocker
    expect(byId['eval-below-band:build-memo-eval'].severity).toBe('blocker');
  });

  it('marks a result stale when its artifact was regenerated well after grading', () => {
    const files = json<RunFile[]>('inventory.json').map((f) =>
      f.path === '6-qa-and-training/training-faq.md' ? { ...f, modifiedTime: '2026-09-27T00:00:00Z' } : f,
    );
    const ids = assessGates(files, parseYaml(text('run_state.yaml')), catalog).map((x) => x.id);
    expect(ids).toContain('eval-stale:training-faq-eval');
  });
});

describe('the other evidence on the real Spark run', () => {
  it('post-condition: the refused verification rules are a warning, not a blocker', () => {
    const pc = json<{ read: never; decided: never }>('postcondition.json');
    const f = assessPostcondition(pc.read, pc.decided);
    expect(f.map((x) => [x.id, x.severity])).toEqual([['connect-verification_rules_persisted', 'warning']]);
    expect(decidedFromRunState(parseYaml(text('run_state.yaml'))).formFieldRulesExpected).toBe(1);
    expect(assessPostcondition(null, null)[0].severity).toBe('blocker');
  });

  it('previews: zero gaps is clean; a gap or a bad frame blocks; an unread list blocks', () => {
    expect(assessPreviews(json<{ outputs: never[] }>('gaps.json').outputs)).toEqual([]);
    expect(assessPreviews([{ id: 'connect-setup:connect.program', output_key: 'connect.program', phase: 'connect-setup' }])[0].severity).toBe('blocker');
    expect(assessPreviews(null)[0].id).toBe('previews-unchecked');
    expect(assessPreviews([], [{ frame: '01-program-card.png', ok: false, detail: 'a probe program, not this one' }])).toHaveLength(1);
  });

  it('links: every real probe loaded; a failed one blocks', () => {
    const probes = json<never[]>('links.json');
    expect(assessLinks(probes)).toEqual([]);
    const broken = json<Array<Record<string, unknown>>>('links.json').map((p, i) => (i === 0 ? { ...p, ok: false, detail: 'login: landed on a login page' } : p));
    expect(assessLinks(broken as never)[0].severity).toBe('blocker');
    expect(assessLinks(null)[0].id).toBe('links-unchecked');
  });

  it('public summary: misleading findings warn, broken ones block, no audit blocks', () => {
    const audit = json<{ findings: never[] }>('surface.json');
    expect(assessSurfaceAudit(audit).every((f) => f.severity === 'warning')).toBe(true);
    const broken = { findings: [{ code: 'LINK-404', severity: 'broken', where: 'x', detail: 'd', fix: 'f' }] };
    expect(assessSurfaceAudit(broken as never)[0].severity).toBe('blocker');
    expect(assessSurfaceAudit(null)[0].id).toBe('surface-unaudited');
  });

  it('chatbot and apps: the real run has a recent-enough transcript and released apps; absence blocks', () => {
    const files = json<RunFile[]>('inventory.json');
    const transcript = files.find((f) => /ocs-chatbot-qa_transcript-quick\.md$/.test(f.path)) ?? null;
    expect(transcript).not.toBeNull();
    expect(assessChatbot(transcript, '2026-09-28T00:00:00Z')).toEqual([]);
    expect(assessChatbot(transcript, '2026-10-30T00:00:00Z')[0].id).toBe('chatbot-transcript-old');
    expect(assessChatbot(null, '2026-10-01T00:00:00Z')[0].severity).toBe('blocker');
    expect(assessApps(files, parseYaml(text('run_state.yaml')))).toEqual([]);
    expect(assessApps([], {}).map((f) => f.id)).toEqual(['app-unreleased:learn', 'app-unreleased:deliver', 'app-release-qa-missing']);
  });
});

