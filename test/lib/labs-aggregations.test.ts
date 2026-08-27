import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LIVE_PIPELINE_AGGREGATIONS,
  NUMERIC_AGGREGATIONS_REQUIRING_FLOAT_TRANSFORM,
  parseValidAggregationsFromError,
  parseDocumentedAggregations,
  diffAggregations,
  isAggregationDriftFree,
} from '../../lib/labs-aggregations.js';

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1675 — the connect-labs playbook documented a pipeline
// aggregation enum the live server rejects.
//
// ACE got this wrong twice, in two files, 2.5 months apart (ace#749 fixed the
// skill copy; the playbook copy was not in scope and kept the stale
// vocabulary). Both times the drift was invisible to CI, because nothing
// compared the documentation against the contract.
//
// This suite is the offline gate. It needs no network: LIVE_PIPELINE_AGGREGATIONS
// is the pin taken from the server's own rejection payload, and the test
// asserts the playbook still documents exactly that. Re-introducing `mean`,
// `validated_rate`, or `non_null_rate` into the playbook fails here.
//
// The online half — re-deriving the pin from the live server — is
// scripts/probe-labs-pipeline-aggregations.ts, deliberately opt-in.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAYBOOK = path.resolve(__dirname, '../../playbook/integrations/connect-labs.md');

describe('parseValidAggregationsFromError', () => {
  it('extracts the allow-list the server echoes on rejection', () => {
    // Verbatim shape observed live 2026-08-26 (opp 10047, pipeline 5242).
    const msg =
      "Unknown aggregation '__ace_probe_invalid__' on field 'ace_probe_bogus'. " +
      "Valid: ['avg', 'count', 'count_distinct', 'count_unique', 'first', " +
      "'last', 'list', 'max', 'min', 'sum']";
    expect(parseValidAggregationsFromError(msg)).toEqual([...LIVE_PIPELINE_AGGREGATIONS]);
  });

  it('handles double-quoted and unquoted tokens', () => {
    expect(parseValidAggregationsFromError('Valid: ["avg", "sum"]')).toEqual(['avg', 'sum']);
    expect(parseValidAggregationsFromError('Valid: [avg, sum]')).toEqual(['avg', 'sum']);
  });

  it('returns null — not an empty list — when the error is something else', () => {
    // A dead pipeline id or an auth failure must never be read as "the
    // allow-list is empty", which would report every documented value as
    // invented drift.
    expect(parseValidAggregationsFromError('Pipeline 999 not found')).toBeNull();
    expect(parseValidAggregationsFromError('function avg(text) does not exist')).toBeNull();
  });
});

describe('parseDocumentedAggregations', () => {
  it('reads the tokens out of the playbook anchor sentence', () => {
    const md =
      '- **The PIPELINE `aggregation` allow-list is exactly these ten:**\n' +
      '  `avg`, `count`, `sum`. Anything else is rejected.\n';
    expect(parseDocumentedAggregations(md)).toEqual(['avg', 'count', 'sum']);
  });

  it('returns null when the anchor sentence is gone', () => {
    // A doc that stopped stating the allow-list is as broken as one that
    // states it wrongly — the test must fail, not silently pass on [].
    expect(parseDocumentedAggregations('# connect-labs\n\nnothing here\n')).toBeNull();
  });
});

describe('diffAggregations', () => {
  it('names both directions of drift', () => {
    // The exact ace#1675 defect: `mean` invented, `avg`/`min`/... undocumented.
    const drift = diffAggregations(['count', 'mean'], ['avg', 'count']);
    expect(drift.invented).toEqual(['mean']);
    expect(drift.undocumented).toEqual(['avg']);
    expect(isAggregationDriftFree(drift)).toBe(false);
  });

  it('is clean when the lists match regardless of order', () => {
    const drift = diffAggregations(['sum', 'avg'], ['avg', 'sum']);
    expect(isAggregationDriftFree(drift)).toBe(true);
  });
});

describe('playbook/integrations/connect-labs.md documents the live allow-list', () => {
  const markdown = readFileSync(PLAYBOOK, 'utf8');

  it('states the allow-list in a parseable form', () => {
    expect(parseDocumentedAggregations(markdown)).not.toBeNull();
  });

  it('documents exactly the ten live aggregations, with no drift', () => {
    const documented = parseDocumentedAggregations(markdown);
    const drift = diffAggregations(documented ?? [], LIVE_PIPELINE_AGGREGATIONS);
    expect(drift).toEqual({ undocumented: [], invented: [] });
  });

  it('does not reintroduce the manifest-side tokens as pipeline aggregations', () => {
    // The regression that shipped twice. These are legal in a synthetic
    // MANIFEST's kpi_config[].aggregation and illegal in a pipeline schema;
    // the playbook may name them only while explaining that distinction.
    const documented = parseDocumentedAggregations(markdown) ?? [];
    for (const token of ['mean', 'validated_rate', 'non_null_rate', 'distinct_count']) {
      expect(documented).not.toContain(token);
    }
  });

  it('warns that numeric aggregations need transform: "float"', () => {
    expect(markdown).toContain('transform: "float"');
    for (const agg of [
      ...NUMERIC_AGGREGATIONS_REQUIRING_FLOAT_TRANSFORM.failLoud,
      ...NUMERIC_AGGREGATIONS_REQUIRING_FLOAT_TRANSFORM.failSilent,
    ]) {
      expect(markdown).toContain(`\`${agg}\``);
    }
  });

  it('records that min/max fail SILENTLY, not loudly', () => {
    // The half that costs money: avg/sum error out, but min/max return a
    // lexicographic text extreme with isError:false. Measured live —
    // max "9" vs a true numeric max of 75 on form.ppi_score.
    expect(markdown).toMatch(/silent/i);
    expect(markdown).toContain('function avg(text) does not exist');
  });
});
