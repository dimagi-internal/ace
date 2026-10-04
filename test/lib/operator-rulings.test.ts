/**
 * Per-opp operator rulings override a standing design assumption
 * (skills/idea-to-pdd § Standing design assumptions → § Per-opp operator
 * rulings). Live case: spark-facilitator, where the owner ruled on 2026-10-04
 * that devices are costed separately and asked about — against the standing
 * `devices-assumed` rule of 2026-09-26.
 *
 * The attribution path is the one `inputs/decision-overrides.yaml` already
 * uses: the producer sends `ai-default` + `feedback_ref:
 * operator-rulings/<id>`, and the write boundary stamps `human-decided` +
 * `decided_by` / `decided_at` FROM THE FILE (ace#2307 — a caller may never
 * assert a human ruled).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import yaml from 'yaml';

import { DecisionRowStrictSchema, parseDecisionsYaml } from '../../lib/decisions-schema.js';
import { composeAppendedLog } from '../../lib/decisions-write.js';
import { enrichDecisionsLog } from '../../lib/decisions-enrich.js';
import { ingestPriorRun } from '../../lib/decisions-ingest.js';
import {
  applyOperatorRulings,
  OperatorRulingsError,
  overriddenAssumptions,
  parseOperatorRulingsYaml,
  rulingDecisionRow,
  rulingsFor,
} from '../../lib/operator-rulings.js';
import { scanRateScope } from '../../lib/rate-scope-consistency.js';
import { compareCommercialTerms } from '../../lib/commercial-terms-consistency.js';
import { handleAppendRows } from '../../mcp/decisions-server.js';

const TEXT = readFileSync(join(__dirname, '..', 'fixtures', 'operator-rulings', 'spark-facilitator.yaml'), 'utf8');
const FILE = parseOperatorRulingsYaml(TEXT);
const DEVICES = FILE.rulings[0];

describe('the file', () => {
  it('parses the spark-facilitator fixture and scopes it by artifact', () => {
    expect(FILE.opp).toBe('spark-facilitator');
    for (const a of ['pdd', 'solicitation', 'work-order'] as const) {
      expect(rulingsFor(FILE, a).map((r) => r.id)).toEqual(['devices-costed-separately']);
      expect(overriddenAssumptions(FILE, a).has('devices-assumed')).toBe(true);
    }
    expect(rulingsFor(FILE, 'apps')).toEqual([]);
    expect(overriddenAssumptions(FILE, 'apps').size).toBe(0);
    expect(overriddenAssumptions(null, 'pdd').size).toBe(0);
  });

  it('refuses a malformed file loudly (an ignored ruling is the failure)', () => {
    const bad = (patch: (d: any) => void) => {
      const d = yaml.parse(TEXT);
      patch(d);
      return () => parseOperatorRulingsYaml(yaml.stringify(d));
    };
    expect(bad((d) => (d.rulings[0].overrides = 'phones-assumed'))).toThrow(OperatorRulingsError);
    expect(bad((d) => (d.rulings[0].applies_to = []))).toThrow(/applies_to/);
    expect(bad((d) => (d.rulings[0].decided_at = 'last week'))).toThrow(/decided_at/);
    expect(bad((d) => d.rulings.push({ ...d.rulings[0] }))).toThrow(/duplicate ruling id/);
    expect(bad((d) => (d.rulings[0].ruling = 'Set hh_count_tt per PDD §4 (ace#2590).'))).toThrow(/plain language/);
    expect(() => parseOperatorRulingsYaml(': not yaml : [')).toThrow(OperatorRulingsError);
  });
});

describe('the decision row each producer records', () => {
  const at = {
    'idea-to-pdd': '1-design',
    'solicitation-create': '8-solicitation-management',
    'pdd-to-work-order': '1-design',
  } as const;

  it('is a valid ai-default write for all three producers, one id each', () => {
    const ids = Object.entries(at).map(([skill, phase]) => {
      const row = rulingDecisionRow(DEVICES, { skill, phase });
      expect(DecisionRowStrictSchema.safeParse(row).success, skill).toBe(true);
      expect(row).toMatchObject({ status: 'ai-default', feedback_ref: 'operator-rulings/devices-costed-separately', plain: DEVICES.ruling });
      return row.id;
    });
    expect(ids).toEqual(['pdd-ruling-devices-costed-separately', 'sol-ruling-devices-costed-separately', 'wo-ruling-devices-costed-separately']);
  });
});

describe('the write boundary stamps the attribution from the file', () => {
  const row = rulingDecisionRow(DEVICES, { skill: 'idea-to-pdd', phase: '1-design' });
  const compose = (rows: unknown[], operatorRulings = FILE.rulings) =>
    composeAppendedLog({ existingYamlText: null, opportunity: 'spark-facilitator', run_id: '20261004-1200', rows, operatorRulings, now: () => '2026-10-04T12:00:00Z' });

  it('human-decided + decided_by / decided_at, matching how decision-overrides attribute a ruling', () => {
    const r = compose([row]);
    expect(r.operatorRulingsApplied).toEqual(['pdd-ruling-devices-costed-separately']);
    const written = parseDecisionsYaml(r.content).decisions[0];
    expect(written).toMatchObject({ status: 'human-decided', decided_by: 'jjackson@dimagi.com', decided_at: '2026-10-04' });
    expect(written.override).toBeUndefined();
  });

  it('a caller still cannot assert human-decided itself (ace#2307)', () => {
    expect(() => compose([{ ...row, status: 'human-decided', decided_by: 'someone@example.org', decided_at: '2026-10-04' }])).toThrow();
  });

  it('a ref naming no ruling is reported, and the row stays ai-default', () => {
    const r = compose([{ ...row, feedback_ref: 'operator-rulings/no-such-ruling' }]);
    expect(r.operatorRulingsUnmatched).toEqual(['operator-rulings/no-such-ruling']);
    expect(parseDecisionsYaml(r.content).decisions[0].status).toBe('ai-default');
  });

  it('a ruled row never carries an ask, and carries into later runs as binding', () => {
    const r = compose([row]);
    const log = parseDecisionsYaml(r.content);
    const { log: enriched } = enrichDecisionsLog(log, { runState: {} });
    expect(enriched.decisions[0].review_ask).toBeUndefined();
    const carried = ingestPriorRun(log.decisions, '20261004-1200', []);
    expect(carried.inherited.find((i) => i.id === row.id)?.authority).toBe('binding');
  });

  it('applyOperatorRulings drops an ask the producer had set — a person has ruled', () => {
    const asked = { ...row, review_ask: 'recommended-confirmation' as const, confirm_reason: 'x' };
    const out = applyOperatorRulings([asked], FILE.rulings).rows[0];
    expect(out.review_ask).toBeUndefined();
    expect(out.confirm_reason).toBeUndefined();
  });

  it('decisions_append_rows loads inputs/operator-rulings.yaml next to decision-overrides.yaml', async () => {
    const created: string[] = [];
    const fake = {
      files: {
        get: vi.fn(async (a: { fileId: string; alt?: string }) =>
          a.alt === 'media' ? { data: TEXT } : { data: { parents: [a.fileId === 'run' ? 'runs' : 'opp'] } },
        ),
        list: vi.fn(async ({ q }: { q: string }) => {
          if (q.includes("name='decisions.yaml'")) return { data: { files: [] } };
          if (q.includes("name='inputs'")) return { data: { files: [{ id: 'inputs' }] } };
          if (q.includes("name='decision-overrides.yaml'")) return { data: { files: [] } };
          if (q.includes("name='operator-rulings.yaml'")) return { data: { files: [{ id: 'or', mimeType: 'application/x-yaml' }] } };
          throw new Error(q);
        }),
        create: vi.fn(async (a: { media: { body: string } }) => {
          created.push(a.media.body);
          return { data: { id: 'dec' } };
        }),
      },
    };
    const r = await handleAppendRows({ runFolderId: 'run', opportunity: 'spark-facilitator', run_id: '20261004-1200', rows: [row] }, fake as never, { now: () => '2026-10-04T12:00:00Z' });
    expect(r.operatorRulingsApplied).toEqual([row.id]);
    expect(parseDecisionsYaml(created[0]).decisions[0].status).toBe('human-decided');
  });
});

describe('the publication rails let the ruling through, and nothing else', () => {
  const payload = (sentence: string) => ({
    scope_of_work: 'Facilitators run verified community meetings.',
    questions: [
      { id: 'q-rate', text: 'Propose an all-in rate per verified meeting and say how much is paid to the worker vs. commodity.' },
      { id: 'q-devices', text: sentence },
    ],
  });

  it('a device line costed separately is blocked by default and allowed under the ruling', () => {
    const p = payload('Who provides phones and data for facilitators? Device costs are funded separately — state them as their own line.');
    expect(scanRateScope(p).clean).toBe(false);
    expect(scanRateScope(p, { devicesCostedSeparately: true }).clean).toBe(true);
  });

  it('the ruling does not open a separate line for anything else', () => {
    const p = payload('Transport to meetings is funded separately.');
    expect(scanRateScope(p, { devicesCostedSeparately: true }).clean).toBe(false);
  });

  it('a work order with an all-in rate and devices outside it agrees with the solicitation that records the ruling', () => {
    const wo =
      'The per-meeting rate is all-in, covering supervision and transport.\n' +
      'Devices and data are costed separately in the partner response.';
    const sol = (rows: object[]) => yaml.stringify({ decisions: rows });
    const allIn = { id: 'sol-all-in-rate', 'ai-default': 'All-in rate per verified meeting', plain: 'The rate is all-in.' };
    const ruling = { id: 'sol-ruling-devices-costed-separately', 'ai-default': 'Follow the operator ruling', plain: DEVICES.ruling };
    expect(compareCommercialTerms(wo, sol([allIn, ruling])).status).toBe('agree');
    // Without the ruling the same work order still contradicts an all-in listing.
    expect(compareCommercialTerms(wo, sol([allIn])).status).toBe('disagree');
  });
});
