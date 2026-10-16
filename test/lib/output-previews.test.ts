/**
 * Output previews contract v1 (ace-web spec 2026-09-29-output-previews-design.md).
 *
 * A preview of an output lives in the folder of the phase that BUILT it —
 * `<N>-<phase>/previews/<output-slug>/_previews.yaml` + frames — whoever
 * captured it. ace-web reads the same folder; these tests pin the half of the
 * contract the plugin writes: the slug (the join key, byte-equal to ace-web's
 * `output_slug`), the index shape, and the readback that catches a Google-Doc
 * write.
 */
import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  outputSlug,
  previewsFolderPath,
  previewFileName,
  resolveAppOutputKey,
  buildPreviewsIndex,
  serializePreviewsIndex,
  assertPreviewsIndexReadable,
  pickDashboardScenes,
  workflowOutputKey,
  resolveTemplate,
  labsWorkflowId,
  PREVIEWS_SCHEMA_VERSION,
  PREVIEWS_INDEX_PATH,
  withoutOtherOpportunityFrames,
} from '../../lib/output-previews.js';
import { showsOtherOpportunities } from '../../lib/opp-title-frames.js';
import { PHASE_DEFS } from '../../lib/artifact-manifest.js';

const BASE = {
  phase: 'commcare-setup',
  outputKey: 'apps.learn',
  capturedBy: 'app-screenshot-capture',
  capturedPhase: 'qa-and-training',
  capturedAt: '2026-09-29T12:00:00Z',
};

describe('outputSlug', () => {
  it('matches the spec examples', () => {
    expect(outputSlug('apps.learn')).toBe('apps-learn');
    expect(outputSlug('synthetic.workflows.programme_report')).toBe('synthetic-workflows-programme-report');
  });
  it('lowercases, collapses runs, trims edges (same as ace-web output_slug)', () => {
    expect(outputSlug('Apps..Learn_App')).toBe('apps-learn-app');
    expect(outputSlug('.x.')).toBe('x');
    expect(outputSlug('learn_app')).toBe('learn-app');
  });
});

describe('paths', () => {
  it('builds the folder from the BUILDING phase folder', () => {
    const commcare = PHASE_DEFS.find((p) => p.key === 'commcare')!.folder;
    const synthetic = PHASE_DEFS.find((p) => p.key === 'synthetic-data-and-workflows')!.folder;
    expect(previewsFolderPath(commcare, 'apps.deliver')).toBe('3-commcare/previews/apps-deliver');
    expect(previewsFolderPath(synthetic, workflowOutputKey('worker_review'))).toBe(
      '7-synthetic/previews/synthetic-workflows-worker-review',
    );
  });
  it('refuses a key with no slug', () => {
    expect(() => previewsFolderPath('3-commcare', '...')).toThrow();
  });
  it('names frames <NN>-<step>.png', () => {
    expect(previewFileName(1, 'journey-learn-home')).toBe('01-journey-learn-home.png');
    expect(previewFileName(12, 'a/b c')).toBe('12-a-b-c.png');
    expect(() => previewFileName(0, 'x')).toThrow();
  });
});

describe('resolveAppOutputKey — read the run, not the declared shape', () => {
  it('prefers the declared apps.<app>', () => {
    expect(resolveAppOutputKey({ apps: { learn: { hq_app_id: 'a' }, learn_app: {} } }, 'learn')).toEqual({
      key: 'apps.learn',
      present: true,
    });
  });
  it('finds the drifted spellings', () => {
    expect(resolveAppOutputKey({ apps: { deliver_app: { hq_app_id: 'd' } } }, 'deliver').key).toBe('apps.deliver_app');
    expect(resolveAppOutputKey({ learn_app: { hq_app_id: 'l' } }, 'learn').key).toBe('learn_app');
  });
  it('falls back to the declared key, flagged not-present', () => {
    expect(resolveAppOutputKey(undefined, 'learn')).toEqual({ key: 'apps.learn', present: false });
    expect(resolveAppOutputKey({ apps: { learn: 'not-a-mapping' } }, 'learn').present).toBe(false);
  });
});

describe('buildPreviewsIndex', () => {
  it('keeps order, drops duplicate_of aliases and file-less rows, captions from shows', () => {
    const idx = buildPreviewsIndex({
      ...BASE,
      frames: [
        { step: 'journey-learn-home', file_id: 'f1', name: '01-journey-learn-home.png', shows: 'Learn home — three modules' },
        { step: 'journey-learn-final', file_id: 'f9', duplicate_of: 'journey-learn-home' },
        { step: 'journey-learn-no-file' },
        { step_name: 'journey-learn-quiz', file_id: 'f2' },
        { step: 'repeat', file_id: 'f1' },
      ],
    });
    expect(idx.schema_version).toBe(PREVIEWS_SCHEMA_VERSION);
    expect(idx.items).toEqual([
      { file_id: 'f1', name: '01-journey-learn-home.png', caption: 'Learn home — three modules' },
      { file_id: 'f2', name: 'journey-learn-quiz.png' },
    ]);
  });
  it('an explicit caption wins over shows', () => {
    const idx = buildPreviewsIndex({ ...BASE, frames: [{ file_id: 'f', name: 'n.png', caption: 'C', shows: 'S' }] });
    expect(idx.items[0].caption).toBe('C');
  });
  it('requires every header field', () => {
    expect(() => buildPreviewsIndex({ ...BASE, capturedBy: '', frames: [] })).toThrow(/capturedBy/);
  });
  it('an empty frame list is a valid, authoritative "show nothing"', () => {
    expect(buildPreviewsIndex({ ...BASE, frames: [] }).items).toEqual([]);
  });
});

// ace#3030: the three frames indexed on noora-health/noora-health/20261015-1129,
// each showing Spark Facilitator / Bednet Check / Poverty Graduation cards.
describe('opportunity-list frames are never previews (ace#3030)', () => {
  const NOORA_LEARN = [
    { step: 'claim-opp-detail', file_id: 'f2', name: '02-claim-opp-detail.png' },
    { step: 'claim-opp-list', file_id: 'f3', name: '03-claim-opp-list.png' },
    { step: 'claim-opp-list-synced', file_id: 'f4', name: '04-claim-opp-list-synced.png' },
    { step: 'journey-learn-home', file_id: 'f5', name: '05-journey-learn-home.png' },
  ];

  it('buildPreviewsIndex drops them, keeping the detail and app frames', () => {
    const idx = buildPreviewsIndex({ ...BASE, frames: NOORA_LEARN });
    expect(idx.items.map((i) => i.name)).toEqual(['02-claim-opp-detail.png', '05-journey-learn-home.png']);
  });

  it('recognises them by file name alone, as an index item carries no step', () => {
    expect(showsOtherOpportunities({ name: '01-connect-resume-opp-list-synced.png' })).toBe(true);
    expect(showsOtherOpportunities({ name: '07-claim-opp-new-tile.png' })).toBe(true);
    expect(showsOtherOpportunities({ step: 'connect-resume-opp-tile' })).toBe(true);
    // controls: this opportunity's own screens, and app frames
    expect(showsOtherOpportunities({ name: '02-claim-opp-detail.png' })).toBe(false);
    expect(showsOtherOpportunities({ step: 'connect-resume-opp-landed' })).toBe(false);
    expect(showsOtherOpportunities({ name: '05-journey-learn-home.png' })).toBe(false);
    expect(showsOtherOpportunities({})).toBe(false);
  });

  it('withoutOtherOpportunityFrames cleans an index written before this rule (or copied by a clone)', () => {
    const old = { ...buildPreviewsIndex({ ...BASE, frames: [] }), items: NOORA_LEARN.map(({ file_id, name }) => ({ file_id, name })) };
    const text = `# clone-provenance\n# Copied into the noora-health workspace\n# /clone-provenance\n${serializePreviewsIndex(old)}`;
    const r = withoutOtherOpportunityFrames(text);
    expect(r.removed).toEqual(['03-claim-opp-list.png', '04-claim-opp-list-synced.png']);
    expect(r.text.startsWith('# clone-provenance\n')).toBe(true);
    expect(parseYaml(r.text).items.map((i: any) => i.file_id)).toEqual(['f2', 'f5']);
    // idempotent, and untouched when clean
    expect(withoutOtherOpportunityFrames(r.text)).toEqual({ text: r.text, removed: [] });
    expect(withoutOtherOpportunityFrames('not: [valid')).toEqual({ text: 'not: [valid', removed: [] });
  });

  it('PREVIEWS_INDEX_PATH matches an index by its run path', () => {
    expect(PREVIEWS_INDEX_PATH.test('3-commcare/previews/apps-learn/_previews.yaml')).toBe(true);
    expect(PREVIEWS_INDEX_PATH.test('3-commcare/previews/apps-learn/03-claim-opp-list.png')).toBe(false);
  });
});

describe('serialize + assertPreviewsIndexReadable', () => {
  const index = buildPreviewsIndex({
    ...BASE,
    frames: [
      { file_id: 'f1', name: '01-a.png', shows: 'Home: "Modules" list, 3 rows' },
      { file_id: 'f2', name: '02-b.png' },
    ],
  });
  const text = serializePreviewsIndex(index);

  it('round-trips to the contract shape', () => {
    const parsed = parseYaml(text);
    expect(parsed).toEqual(index);
    const rb = assertPreviewsIndexReadable(text, {
      folderSlug: 'apps-learn',
      phase: 'commcare-setup',
      outputKey: 'apps.learn',
      capturedBy: 'app-screenshot-capture',
      expectedCount: 2,
    });
    expect(rb.findings).toEqual([]);
    expect(rb.ok).toBe(true);
    expect(rb.index?.items).toHaveLength(2);
  });

  it('catches a Google-Doc write (\\r\\n\\r\\n\\r\\n newlines)', () => {
    const mangled = text.replace(/\n/g, '\r\n\r\n\r\n');
    const rb = assertPreviewsIndexReadable(mangled);
    expect(rb.ok).toBe(false);
    expect(rb.findings.map((f) => f.reason)).toContain('not-real-bytes');
  });

  it('catches an index in the wrong folder', () => {
    const rb = assertPreviewsIndexReadable(text, { folderSlug: 'apps-deliver' });
    expect(rb.findings.map((f) => f.reason)).toEqual(['slug-mismatch']);
  });

  it('catches a count the writer did not mean', () => {
    const rb = assertPreviewsIndexReadable(text, { expectedCount: 3 });
    expect(rb.findings.map((f) => f.reason)).toEqual(['count-mismatch']);
  });

  it('catches missing fields, bad items, duplicates and non-YAML', () => {
    expect(assertPreviewsIndexReadable('').ok).toBe(false);
    expect(assertPreviewsIndexReadable('- a\n- b\n').findings[0].reason).toBe('not-yaml');
    const bad = assertPreviewsIndexReadable(
      'schema_version: 2\nphase: commcare-setup\noutput_key: apps.learn\ncaptured_by: x\ncaptured_phase: y\n' +
        'captured_at: not-a-date\nitems:\n  - file_id: a\n    name: a.png\n  - file_id: a\n    name: b.png\n  - name: c.png\n',
    );
    const reasons = bad.findings.map((f) => f.reason);
    expect(reasons).toContain('bad-field');
    expect(reasons).toContain('duplicate-file-id');
    expect(reasons).toContain('bad-item');
  });

  it('refuses an output_key that points at a previews slot under products', () => {
    const t = serializePreviewsIndex({ ...index, output_key: 'apps.learn.previews' });
    expect(assertPreviewsIndexReadable(t).findings.map((f) => f.reason)).toContain('products-pointer');
  });
});

describe('Phase 7 — pickDashboardScenes', () => {
  const vars = {
    programme_par_url: 'https://labs.connect.dimagi.com/labs/workflow/501/run/?run_id=9&opportunity_id=10001',
    partner_a_opp_report_par_url: 'https://labs.connect.dimagi.com/labs/workflow/502/run/?run_id=11&opportunity_id=10002',
  };
  const workflows = {
    // Name mismatch on purpose: realized var `programme_par_url`, workflows key `programme_report`.
    programme_report: { workflow_id: 501, run_url: vars.programme_par_url },
    partner_a_opp_report: { run_url: vars.partner_a_opp_report_par_url },
    worker_review: { workflow_id: 503, run_url: 'https://labs.connect.dimagi.com/labs/workflow/503/run/?run_id=12' },
  };
  const scenes = [
    { scene_index: 1, url: '${programme_par_url}' },
    { scene_index: 2, url: '${programme_par_url}' },
    { scene_index: 3, url: '${programme_par_url}' },
    { scene_index: 4, url: '${partner_a_opp_report_par_url}' },
    { scene_index: 5, url: 'https://example.org/unrelated' },
  ];

  it('matches scenes to dashboards by labs workflow id, capped per output, in spec order', () => {
    expect(pickDashboardScenes({ scenes, workflows, vars })).toEqual({
      programme_report: [1, 2],
      partner_a_opp_report: [4],
    });
  });

  it('skips scenes whose snapshot does not exist', () => {
    expect(pickDashboardScenes({ scenes, workflows, vars, available: [2, 3, 4], perOutput: 1 })).toEqual({
      programme_report: [2],
      partner_a_opp_report: [4],
    });
  });

  it('no render, no scenes → nothing to write', () => {
    expect(pickDashboardScenes({ scenes: [], workflows, vars })).toEqual({});
    expect(pickDashboardScenes({ scenes, workflows: undefined, vars })).toEqual({});
  });

  it('falls back to exact run_url equality when no workflow id is present', () => {
    const wf = { custom: { run_url: 'https://labs.example/custom/dash/' } };
    expect(pickDashboardScenes({ scenes: [{ scene_index: 7, url: 'https://labs.example/custom/dash' }], workflows: wf })).toEqual({
      custom: [7],
    });
  });

  it('helpers', () => {
    expect(workflowOutputKey('programme_report')).toBe('synthetic.workflows.programme_report');
    expect(resolveTemplate('${a}/x/${b}', { a: 'A' })).toBe('A/x/${b}');
    expect(labsWorkflowId('https://h/labs/workflow/42/run/?run_id=1')).toBe('42');
    expect(labsWorkflowId('https://h/labs/other')).toBeNull();
  });
});
