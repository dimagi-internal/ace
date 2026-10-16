/**
 * Phase 1 fence: a platform-behaviour question is answered from source / an
 * API probe before Phase 3 (ace#3036 — kaduna parked "does Connect count every
 * Learn module?" for a device walk that came after the build).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { DecisionRowSchema } from '../../lib/decisions-schema';
import { checkPlatformBehaviourDecisions, verifyPlatformBehaviourDecisions } from '../../lib/platform-behaviour-decisions';

const CITE = 'dimagi/commcare-connect@c7409bd35:commcare_connect/opportunity/models.py:398-406';

function log(...rows: Record<string, unknown>[]): string {
  return yaml.stringify({
    schema_version: 6,
    opportunity: 'kaduna-graduation',
    run_id: '20261015-1411',
    generated_at: '2026-10-15T20:00:00Z',
    decisions: rows.map((r, i) => ({ id: `row-${i}`, phase: '1-design', skill: 'idea-to-pdd', ...r })),
  });
}

// The real kaduna F3 row (Phase 1 state), tagged `kind: platform-behaviour`.
const KADUNA_F3 = readFileSync(
  fileURLToPath(new URL('../fixtures/platform-constraints/kaduna-f3-decisions.yaml', import.meta.url)),
  'utf8',
);

describe('the real kaduna F3 row', () => {
  it('fails the fence: a platform question left for "the first device walk"', () => {
    const r = checkPlatformBehaviourDecisions(KADUNA_F3);
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.id)).toContain('learn-completion-across-roles');
  });

  it('passes once answered from Connect source by a superseding row', () => {
    const doc = yaml.parse(KADUNA_F3);
    doc.decisions[0].superseded_by = 'platform-learn-completion-counts-every-module';
    doc.decisions.push({
      id: 'platform-learn-completion-counts-every-module',
      kind: 'platform-behaviour',
      supersedes: 'learn-completion-across-roles',
      resolved_by: 'source',
      resolution_citation: CITE,
    });
    const r = checkPlatformBehaviourDecisions(yaml.stringify(doc));
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });
});

describe('checkPlatformBehaviourDecisions', () => {
  it('fails the kaduna shape: a platform question left for the device walk', () => {
    // F3 as the kaduna PDD wrote it: an open question, "answered by the first device walk".
    const r = checkPlatformBehaviourDecisions(log({ id: 'learn-completion-across-roles', kind: 'platform-behaviour' }));
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([expect.objectContaining({ id: 'learn-completion-across-roles' })]);
    expect(r.summary).toMatch(/before Phase 3/);
  });

  it('passes source- and api-resolved rows', () => {
    const r = checkPlatformBehaviourDecisions(
      log(
        { kind: 'platform-behaviour', resolved_by: 'source', resolution_citation: CITE },
        { kind: 'platform-behaviour', resolved_by: 'api', resolution_citation: 'connect_get_learn_progress(opp 1234) -> modules_completed_pct 64.3' },
        { note: 'an ordinary row is not checked' },
      ),
    );
    expect(r).toMatchObject({ ok: true, rows: 2, failures: [] });
  });

  it('rejects an unpinned source citation and a citation-less resolution', () => {
    const r = checkPlatformBehaviourDecisions(
      log(
        { kind: 'platform-behaviour', resolved_by: 'source', resolution_citation: 'models.py says so' },
        { kind: 'platform-behaviour', resolved_by: 'api' },
      ),
    );
    expect(r.failures.map((f) => f.id)).toEqual(['row-0', 'row-1']);
  });

  it('device: fails as a silent assumption, warns as an open ask', () => {
    expect(checkPlatformBehaviourDecisions(log({ kind: 'platform-behaviour', resolved_by: 'device', resolution_citation: 'Phase 6 walk' })).ok).toBe(false);
    const ask = checkPlatformBehaviourDecisions(
      log({ kind: 'platform-behaviour', resolved_by: 'device', resolution_citation: 'Phase 6 walk', review_ask: 'recommended-confirmation' }),
    );
    expect(ask.ok).toBe(true);
    expect(ask.warnings).toHaveLength(1);
  });

  it('ignores superseded rows — the heal is a superseding resolved row', () => {
    const r = checkPlatformBehaviourDecisions(
      log(
        { id: 'q', kind: 'platform-behaviour', superseded_by: 'q-resolved' },
        { id: 'q-resolved', kind: 'platform-behaviour', resolved_by: 'source', resolution_citation: CITE, supersedes: 'q' },
      ),
    );
    expect(r.ok).toBe(true);
  });

  it('absent log is ok; unparseable log is unreadable and fails', () => {
    expect(checkPlatformBehaviourDecisions(null).ok).toBe(true);
    expect(checkPlatformBehaviourDecisions(': : not yaml [').ok).toBe(false);
  });

  it('reads decisions.yaml from the run root', async () => {
    const r = await verifyPlatformBehaviourDecisions(
      {
        async listFolder() {
          return [{ id: 'd1', name: 'decisions.yaml', mimeType: 'application/vnd.google-apps.document' }];
        },
        async readText() {
          return log({ kind: 'platform-behaviour' });
        },
      } as any,
      'run',
    );
    expect(r.ok).toBe(false);
  });
});

describe('the fence is wired, not just written', () => {
  const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');
  it('verify_phase_artifacts returns platform_behaviour for the design phase', () => {
    const src = read('mcp/google-drive-server.ts');
    expect(src).toMatch(/if \(phase === 'design'\) \{\s*try \{\s*platform_behaviour = await verifyPlatformBehaviourDecisions/);
  });
  it('the orchestrator boundary branches on it and idea-to-design says how to answer', () => {
    expect(read('agents/ace-orchestrator.md')).toMatch(/verify\.platform_behaviour\.ok is not false/);
    expect(read('agents/ace-orchestrator.md')).toMatch(/verify\.platform_behaviour\.ok=false/);
    expect(read('agents/idea-to-design.md')).toMatch(/Platform-behaviour questions — answer them from source, not a device/);
  });
});

describe('decision row schema: resolved_by / resolution_citation', () => {
  const base = { id: 'x', phase: '1-design', skill: 's', question: 'q?', 'ai-default': 'a', options: ['a', 'b'], source: 's', status: 'ai-default' };
  it('pairs the two fields and pins source citations', () => {
    expect(DecisionRowSchema.safeParse({ ...base, kind: 'platform-behaviour' }).success).toBe(true);
    expect(DecisionRowSchema.safeParse({ ...base, resolved_by: 'source', resolution_citation: CITE }).success).toBe(true);
    expect(DecisionRowSchema.safeParse({ ...base, resolved_by: 'source' }).success).toBe(false);
    expect(DecisionRowSchema.safeParse({ ...base, resolution_citation: CITE }).success).toBe(false);
    expect(DecisionRowSchema.safeParse({ ...base, resolved_by: 'source', resolution_citation: 'models.py' }).success).toBe(false);
  });
  it('keeps the fields through a parse (they are not stripped)', () => {
    const p = DecisionRowSchema.parse({ ...base, kind: 'platform-behaviour', resolved_by: 'source', resolution_citation: CITE });
    expect(p).toMatchObject({ kind: 'platform-behaviour', resolved_by: 'source', resolution_citation: CITE });
  });
});
