/**
 * dimagi-internal/ace#1864 — an authored pipeline field whose path extracts
 * nothing is never checked, so the demo loses its payoff on the next render.
 *
 * The corpus below is REAL, not invented:
 *
 * - `LIVE_HEALTHY_ROWS` are four rows returned by
 *   `pipeline_preview(pipeline_id=5411, opportunity_id=10054, sample_size=15)`
 *   on 2026-09-06 (`from_cache: false`, `row_count: 12`), trimmed to the
 *   columns under test.
 *
 * - `LIVE_PROBE_*` is the same call with a `schema_override` pointing three
 *   fields at `form.no_such_group.no_such_field` — a deliberately-bad path on
 *   real data. It returned, verbatim:
 *
 *     records_bad_count : 0, 0, 0
 *     steps_bad_distinct: 0, 0, 0
 *     avg_bad           : null, null, null
 *     records_good_count: 18, 17, 14
 *     fields_all_null   : ["avg_bad"]
 *
 *   That single response is the whole issue: labs' own detector names ONLY the
 *   `avg`, because `count`/`count_distinct` over zero matched records are `0`
 *   rather than `null` — precisely the field type that gated
 *   spark-facilitator/20260828-0703's below-floor filter.
 *
 * The old-surface control (`fieldsAllNullVerdict`) is the mutation: it is the
 * check with zero-deadness removed, i.e. exactly what labs and every gate
 * upstream of this one could see. It must pass the corpus the new check fails.
 */
import { describe, it, expect } from 'vitest';
import {
  checkPipelineFieldsExtract,
  isDeadExtraction,
  type PipelinePreview,
} from '../../lib/pipeline-field-extraction.js';

// ── Real rows, pipeline 5411 / opp 10054, 2026-09-06, from_cache:false ──

const LIVE_HEALTHY_ROWS = [
  {
    username: 'annie_kalua',
    records: 18,
    meetings_held: 18,
    not_held: 0,
    community_meetings: 17,
    committee_meetings: 1,
    gps_imprecise: 1,
    steps_covered: 7,
    community: 'Village J',
    avg_attendance: 65.44444444444444,
  },
  {
    username: 'chimwemwe_gondwe',
    records: 17,
    meetings_held: 17,
    not_held: 0,
    community_meetings: 17,
    committee_meetings: 0,
    gps_imprecise: 0,
    steps_covered: 7,
    community: 'Village E',
    avg_attendance: 65.05882352941177,
  },
  {
    username: 'dalitso_mbewe',
    records: 14,
    meetings_held: 11,
    not_held: 3,
    community_meetings: 11,
    committee_meetings: 0,
    gps_imprecise: 0,
    steps_covered: 6,
    community: 'Village I',
    avg_attendance: 71.0909090909091,
  },
  {
    username: 'esnart_banda',
    records: 19,
    meetings_held: 19,
    not_held: 0,
    community_meetings: 19,
    committee_meetings: 0,
    gps_imprecise: 1,
    steps_covered: 7,
    community: 'Village C',
    avg_attendance: 67.42105263157895,
  },
];

const HEALTHY_DECLARED = [
  { name: 'records', path: 'form.meeting_held.meeting_conducted', aggregation: 'count' },
  {
    name: 'meetings_held',
    path: 'form.meeting_held.meeting_conducted',
    aggregation: 'count',
    filter_path: 'form.meeting_held.meeting_conducted',
    filter_value: 'yes',
  },
  {
    name: 'not_held',
    path: 'form.meeting_held.meeting_conducted',
    aggregation: 'count',
    filter_path: 'form.meeting_held.meeting_conducted',
    filter_value: 'no',
  },
  {
    name: 'community_meetings',
    path: 'form.meeting_type_screen.meeting_type',
    aggregation: 'count',
    filter_path: 'form.meeting_type_screen.meeting_type',
    filter_value: 'community_meeting',
  },
  {
    name: 'committee_meetings',
    path: 'form.meeting_type_screen.meeting_type',
    aggregation: 'count',
    filter_path: 'form.meeting_type_screen.meeting_type',
    filter_value: 'committee_meeting',
  },
  {
    name: 'gps_imprecise',
    path: 'form.evidence.gps_accuracy_band',
    aggregation: 'count',
    filter_path: 'form.evidence.gps_accuracy_band',
    filter_value: 'imprecise',
  },
  { name: 'steps_covered', path: 'form.fcap_step.step', aggregation: 'count_distinct' },
  { name: 'community', path: 'form.community_identity.village_name', aggregation: 'first' },
  {
    name: 'avg_attendance',
    path: 'form.meeting_summary.Total_Attendance',
    aggregation: 'avg',
    transform: 'float',
  },
];

const HEALTHY: PipelinePreview = {
  pipeline_id: 5411,
  name: 'FLW KPI Aggregates',
  declared: HEALTHY_DECLARED,
  rows: LIVE_HEALTHY_ROWS,
  from_cache: false,
  fields_all_null: [],
};

// ── The live bad-path probe: real rows, deliberately-wrong paths ──

const BAD_PATH = 'form.no_such_group.no_such_field';

const LIVE_PROBE: PipelinePreview = {
  pipeline_id: 5411,
  name: 'probe ace1864',
  declared: [
    { name: 'records_bad_count', path: BAD_PATH, aggregation: 'count' },
    { name: 'steps_bad_distinct', path: BAD_PATH, aggregation: 'count_distinct' },
    { name: 'avg_bad', path: BAD_PATH, aggregation: 'avg' },
    { name: 'records_good_count', path: 'form.meeting_held.meeting_conducted', aggregation: 'count' },
  ],
  rows: [
    { records_bad_count: 0, steps_bad_distinct: 0, avg_bad: null, records_good_count: 18 },
    { records_bad_count: 0, steps_bad_distinct: 0, avg_bad: null, records_good_count: 17 },
    { records_bad_count: 0, steps_bad_distinct: 0, avg_bad: null, records_good_count: 14 },
  ],
  from_cache: false,
  fields_all_null: ['avg_bad'],
};

/**
 * Pipeline 5414 as ACE authored it on spark-facilitator/20260828-0703, before
 * the in-run repair: `records` pointed at `form.meeting_date.date_of_meeting`,
 * which the fixture did not carry. Twelve facilitators, `records: 0` on every
 * one, `avg_attendance` / `avg_participation_pct` null throughout.
 */
const ISSUE_1864: PipelinePreview = {
  pipeline_id: 5414,
  name: 'FLW KPI Aggregates',
  declared: [
    { name: 'records', path: 'form.meeting_date.date_of_meeting', aggregation: 'count' },
    {
      name: 'community',
      path: 'form.community_identity.village_name',
      aggregation: 'first',
    },
    { name: 'avg_attendance', path: 'form.meeting_summary.Total_Attendance', aggregation: 'avg' },
    {
      name: 'avg_participation_pct',
      path: 'form.meeting_summary.Percentage_Participation',
      aggregation: 'avg',
    },
  ],
  rows: Array.from({ length: 12 }, (_, i) => ({
    records: 0,
    community: `Village ${String.fromCharCode(65 + i)}`,
    avg_attendance: null,
    avg_participation_pct: null,
  })),
  from_cache: false,
  fields_all_null: ['avg_attendance', 'avg_participation_pct'],
};

/**
 * THE MUTATION. This is `checkPipelineFieldsExtract` with zero-deadness
 * removed — i.e. labs' `fields_all_null` rule, and the only rule any surface
 * upstream of this check applies to a declared field. If the new check is
 * really doing work, this must be GREEN on the same corpus.
 */
function fieldsAllNullVerdict(p: PipelinePreview): string[] {
  return p.declared
    .filter((f) => p.rows.length > 0 && p.rows.every((r) => r[f.name] === null || r[f.name] === undefined))
    .map((f) => f.name);
}

describe('isDeadExtraction', () => {
  it('treats 0 as dead for the counting aggregations — the whole point of #1864', () => {
    expect(isDeadExtraction(0, 'count')).toBe(true);
    expect(isDeadExtraction(0, 'count_distinct')).toBe(true);
    expect(isDeadExtraction(0, 'count_unique')).toBe(true);
  });

  it('treats 0 as dead for numeric aggregations, and null/empty everywhere', () => {
    expect(isDeadExtraction(0, 'avg')).toBe(true);
    expect(isDeadExtraction(0, 'sum')).toBe(true);
    expect(isDeadExtraction(null, 'avg')).toBe(true);
    expect(isDeadExtraction(undefined, 'count')).toBe(true);
    expect(isDeadExtraction('', 'first')).toBe(true);
    expect(isDeadExtraction([], 'list')).toBe(true);
  });

  it('does not treat a real extracted 0 as dead for first/last/list', () => {
    expect(isDeadExtraction(0, 'first')).toBe(false);
    expect(isDeadExtraction(0, 'last')).toBe(false);
  });

  it('never flags a live value', () => {
    expect(isDeadExtraction(18, 'count')).toBe(false);
    expect(isDeadExtraction(65.44, 'avg')).toBe(false);
    expect(isDeadExtraction('Village J', 'first')).toBe(false);
  });
});

describe('checkPipelineFieldsExtract — negative control (real healthy rows)', () => {
  it('passes pipeline 5411 as it previewed live on 2026-09-06', () => {
    const r = checkPipelineFieldsExtract([HEALTHY]);
    expect(r.pass).toBe(true);
    expect(r.findings.filter((f) => f.blocking)).toHaveLength(0);
    expect(r.fields_judged).toBe(9);
  });

  it('does not flag a field that is zero for SOME rows (not_held: 0,0,3,0)', () => {
    const r = checkPipelineFieldsExtract([HEALTHY]);
    expect(r.findings.map((f) => f.field)).not.toContain('not_held');
    expect(r.findings.map((f) => f.field)).not.toContain('gps_imprecise');
  });

  it('an all-zero FILTERED count is reported, never blocking — a filter may match nothing', () => {
    const noCommittee: PipelinePreview = {
      ...HEALTHY,
      rows: HEALTHY.rows.map((r) => ({ ...r, committee_meetings: 0 })),
    };
    const r = checkPipelineFieldsExtract([noCommittee]);
    expect(r.pass).toBe(true);
    const f = r.findings.find((x) => x.field === 'committee_meetings');
    expect(f?.kind).toBe('filtered-field-all-zero');
    expect(f?.blocking).toBe(false);
  });
});

describe('checkPipelineFieldsExtract — positive control (#1864)', () => {
  it('fails pipeline 5414 as authored, naming records and its path', () => {
    const r = checkPipelineFieldsExtract([ISSUE_1864]);
    expect(r.pass).toBe(false);
    const blocking = r.findings.filter((f) => f.blocking);
    expect(blocking.map((f) => f.field).sort()).toEqual([
      'avg_attendance',
      'avg_participation_pct',
      'records',
    ]);
    const records = blocking.find((f) => f.field === 'records');
    expect(records?.kind).toBe('field-dead');
    expect(records?.path).toBe('form.meeting_date.date_of_meeting');
    expect(r.auto_fix_hint).toContain('pipeline_update_schema');
  });

  it('MUTATION: the null-only rule (labs + every gate upstream) misses records entirely', () => {
    // 3 blocking findings from the new check ...
    expect(checkPipelineFieldsExtract([ISSUE_1864]).findings.filter((f) => f.blocking)).toHaveLength(3);
    // ... 2 from the mutation, and `records` — the field that gates the demo — is not among them.
    const mutated = fieldsAllNullVerdict(ISSUE_1864);
    expect(mutated).toHaveLength(2);
    expect(mutated).not.toContain('records');
  });

  it('MUTATION on the live bad-path probe: 3 blocking vs labs’ 1 fields_all_null entry', () => {
    const r = checkPipelineFieldsExtract([LIVE_PROBE]);
    expect(r.pass).toBe(false);
    expect(r.findings.filter((f) => f.blocking).map((f) => f.field).sort()).toEqual([
      'avg_bad',
      'records_bad_count',
      'steps_bad_distinct',
    ]);
    // What labs itself reported on that exact call.
    expect(LIVE_PROBE.fields_all_null).toEqual(['avg_bad']);
    expect(fieldsAllNullVerdict(LIVE_PROBE)).toEqual(['avg_bad']);
    // The healthy sibling field on the same call is untouched.
    expect(r.findings.map((f) => f.field)).not.toContain('records_good_count');
  });
});

describe('checkPipelineFieldsExtract — the surfaces #1864 slipped past', () => {
  it('refuses a cached preview: warm rows are not evidence about the saved schema', () => {
    const r = checkPipelineFieldsExtract([{ ...HEALTHY, from_cache: true }]);
    expect(r.pass).toBe(false);
    expect(r.findings[0].kind).toBe('cached-preview');
    expect(r.fields_judged).toBe(0);
  });

  it('enumerates from the DECLARED list, so a column that never came back is caught', () => {
    // check 7 iterates Object.keys(row), so this field is invisible to it.
    const dropped: PipelinePreview = {
      ...HEALTHY,
      rows: HEALTHY.rows.map(({ records, ...rest }) => rest),
    };
    const r = checkPipelineFieldsExtract([dropped]);
    expect(r.pass).toBe(false);
    const f = r.findings.find((x) => x.field === 'records');
    expect(f?.kind).toBe('field-missing-from-rows');
  });

  it('folds in fields_all_null so it can never fall below labs’ own detector', () => {
    const r = checkPipelineFieldsExtract([{ ...HEALTHY, fields_all_null: ['community'] }]);
    expect(r.pass).toBe(false);
    expect(r.findings.find((f) => f.field === 'community')?.kind).toBe('field-dead');
  });

  it('reports rather than passes when there is nothing to judge', () => {
    const noRows = checkPipelineFieldsExtract([{ ...HEALTHY, rows: [] }]);
    expect(noRows.pass).toBe(true);
    expect(noRows.findings[0].kind).toBe('no-rows');
    expect(noRows.detail).toContain('no-rows');

    const noFields = checkPipelineFieldsExtract([{ ...HEALTHY, declared: [] }]);
    expect(noFields.findings[0].kind).toBe('no-declared-fields');
    expect(noFields.fields_judged).toBe(0);
  });

  it('judges every authored pipeline, including one whose dashboard renders a frozen snapshot', () => {
    // 5411's dashboard renders a completed snapshot, so check 7 reads good
    // frozen values while the definition rots. This check previews it anyway.
    const r = checkPipelineFieldsExtract([HEALTHY, ISSUE_1864]);
    expect(r.pass).toBe(false);
    expect(r.findings.filter((f) => f.blocking).every((f) => f.pipeline_id === 5414)).toBe(true);
  });
});
