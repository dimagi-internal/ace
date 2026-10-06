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
  isArchived,
  assessLinks,
  assessPostcondition,
  assessPreviews,
  assessSurfaceAudit,
  buildReleaseVerdict,
  decidedFromRunState,
  INVENTORY_TEXT_WANTED,
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

  it('a `warn` that cleared the band is still a blocker, worded accurately with the sub-7 dimensions', () => {
    const now = new Date().toISOString();
    const verdictYaml = [
      'skill: run-surface-audit-eval',
      'target: spark-facilitator/20261001-2208',
      'mode: deep',
      'overall_score: 7.4',
      'verdict: warn',
      'dimensions:',
      '  outsider_orientation: { score: 8.5, weight: 0.2 }',
      '  jargon_and_insider_language: { score: 4, weight: 0.15 }',
      '  claim_accuracy: { score: 8, weight: 0.25 }',
      '  internal_consistency: { score: 6.5, weight: 0.1 }',
      '  ask_actionability: { score: 8, weight: 0.3 }',
      'gate:',
      '  threshold: 7.0',
    ].join('\n');
    const files: RunFile[] = [{ path: '8-solicitation-management/run-surface-audit-eval_verdict.yaml', modifiedTime: now, text: verdictYaml }];
    const f = assessGates(files, {}, { qaSkills: new Set(), evalSkills: new Set() });
    const b = f.find((x) => x.id === 'eval-below-band:run-surface-audit-eval')!;
    expect(b.severity).toBe('blocker');
    expect(b.detail).toContain('cleared the score band but a dimension is still below 7: jargon_and_insider_language 4, internal_consistency 6.5');
    expect(b.detail).not.toMatch(/below its pass mark/);
    expect(b.fix).toMatch(/raise jargon_and_insider_language, internal_consistency to 7/);

    const v = buildReleaseVerdict({ workspace: 'spark', opp: 'spark-facilitator', runId: '20261001-2208', checkedAt: now, files: [], findings: f });
    const plain = v.blockers.find((x) => x.id === 'eval-below-band:run-surface-audit-eval')!;
    expect(plain.summary).toMatch(/cleared the score band but a dimension is still below 7: jargon and insider language and internal consistency\./);
    expect(plain.summary).not.toMatch(/pass mark/);
  });

  it('an archived attempt under superseded-*/ is not graded, nor stale against current files (ace#2753)', () => {
    // spark/spark-facilitator/20261004-1706 after the clone re-sync: the old Phase 7
    // gates were moved to 7-synthetic/superseded-2026-10-06-pre-resync/, the current
    // ones are fresh. Grading the archive against the newer current artifacts raised
    // qa-stale/eval-stale blockers that no re-run could clear.
    const old = '2026-10-06T14:00:00Z';
    const cur = '2026-10-06T23:02:00Z';
    const qa = 'verdict: pass\nchecks_run: 1\nchecks_passed: 1\nfailures: []\n';
    const ev = 'verdict: pass\noverall_score: 8.2\ngate:\n  threshold: 7.0\n';
    const arch = '7-synthetic/superseded-2026-10-06-pre-resync';
    const files: RunFile[] = [
      { path: `${arch}/demo-data-setup-qa_result.yaml`, modifiedTime: old, text: qa },
      { path: `${arch}/semantic-registry-author-eval_verdict.yaml`, modifiedTime: old, text: ev },
      { path: `${arch}/demo-data-setup.md`, modifiedTime: old },
      { path: '7-synthetic/demo-data-setup.md', modifiedTime: cur },
      { path: '7-synthetic/semantic-registry-author_registry.json', modifiedTime: cur },
    ];
    const ids = assessGates(files, {}, { qaSkills: new Set(), evalSkills: new Set() }).map((f) => f.id);
    expect(ids.filter((i) => /stale/.test(i))).toEqual([]);
    expect(isArchived(`${arch}/x.yaml`)).toBe(true);
    expect(isArchived('7-synthetic/superseded-2026-10-06-attempt-1/x.yaml')).toBe(true);
    expect(isArchived('7-synthetic/demo-data-setup.md')).toBe(false);
    expect(isArchived('7-synthetic/superseded.md')).toBe(false);
  });

  it('a `warn` BELOW the band keeps the below-pass-mark wording', () => {
    const now = new Date().toISOString();
    const files: RunFile[] = [{
      path: '8-solicitation-management/run-surface-audit-eval_verdict.yaml', modifiedTime: now,
      text: 'verdict: warn\noverall_score: 6.4\ndimensions:\n  claim_accuracy: { score: 5, weight: 1 }\ngate:\n  threshold: 7.0\n',
    }];
    const b = assessGates(files, {}, { qaSkills: new Set(), evalSkills: new Set() })[0];
    expect(b.detail).not.toMatch(/cleared the score band/);
    const v = buildReleaseVerdict({ workspace: 'spark', opp: 'spark-facilitator', runId: 'x', checkedAt: now, files: [], findings: [b] });
    expect(v.blockers[0].summary).toMatch(/scored below its pass mark/);
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

/**
 * ace#2698: `assessApps` read only run_state `released_build_id`, a key no skill
 * is contracted to write. app-release's summary frontmatter is the sole owner of
 * released build state (skills/app-release/SKILL.md § Products, ace#1439).
 * The run_state below is spark/spark-facilitator/20261004-1706's products.apps
 * shape, whose apps HQ confirmed released (is_released=true, version 1) on 2026-10-05.
 */
describe('assessApps reads the contracted release record (ace#2698)', () => {
  const runState = {
    phases: {
      'commcare-setup': {
        products: {
          apps: {
            domain: 'connect-ace-spark',
            learn: { hq_app_id: 'ae96db88learn', hq_build_id: 'b035410773d84f40a0fa81f6f504ef5e', build_version: 1, released_at: '2026-10-05T13:34:30Z' },
            deliver: { hq_app_id: '81d37f6cdeliver', hq_build_id: 'c737c5a5ae814dafb3953aff1ad3c421', build_version: 1, released_at: '2026-10-05T13:34:30Z' },
          },
        },
      },
    },
  };
  const qa: RunFile = { path: '3-commcare/app-release-qa_result.yaml', modifiedTime: '2026-10-05T14:00:00Z', text: 'verdict: pass' };
  const summary = (learnApp: string, released = true): RunFile => ({
    path: '3-commcare/app-release_summary.md',
    modifiedTime: '2026-10-05T13:35:00Z',
    text: [
      '---',
      'apps:',
      `  learn_app:   { hq_app_id: ${learnApp}, build_id: b035410773d84f40a0fa81f6f504ef5e, version: 1, is_released: ${released}, released_at: '2026-10-05T13:34:30Z' }`,
      "  deliver_app: { hq_app_id: 81d37f6cdeliver, build_id: c737c5a5ae814dafb3953aff1ad3c421, version: 1, is_released: true, released_at: '2026-10-05T13:34:30Z' }",
      '---',
      '',
      '# App release summary',
    ].join('\n'),
  });

  it('a released pair recorded in app-release_summary.md is not a blocker', () => {
    expect(assessApps([qa, summary('ae96db88learn')], runState)).toEqual([]);
  });

  it('without a readable summary, the run_state shapes producers actually wrote still count', () => {
    expect(assessApps([qa], runState)).toEqual([]);
  });

  it('the summary is authoritative: is_released false blocks even when run_state looks released', () => {
    expect(assessApps([qa, summary('ae96db88learn', false)], runState).map((f) => f.id)).toEqual(['app-unreleased:learn']);
  });

  it('the inventory reads the summary text the gate depends on', () => {
    expect(INVENTORY_TEXT_WANTED.test('3-commcare/app-release_summary.md')).toBe(true);
    expect(INVENTORY_TEXT_WANTED.test('3-commcare/app-deploy_summary.md')).toBe(false);
  });

  it('a summary naming a DIFFERENT app than run_state (a clone that never re-recorded its release) blocks', () => {
    expect(assessApps([qa, summary('source-learn-app')], runState).map((f) => f.id)).toEqual(['app-release-other-app:learn']);
  });
});

