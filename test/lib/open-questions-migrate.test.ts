/**
 * scripts/migrate-open-questions.ts + lib/open-questions-migrate.ts — spec § 6
 * (docs/superpowers/specs/2026-10-04-open-questions-into-decisions-design.md).
 *
 * Fixtures are the real spark-facilitator ledger reads already in the repo
 * (test/fixtures/open-questions/spark-facilitator-*.text-markdown.md, read
 * from Drive with exportAs text/markdown) against the real
 * spark-facilitator/20261001-2208 decisions log.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseDecisionsYaml, DecisionRowStrictSchema } from '../../lib/decisions-schema.js';
import {
  buildMigration,
  classificationTemplate,
  ownerFrom,
  ownerIsInternal,
  proposeClassification,
  readLedgerOpenRows,
  renderArchivedLedger,
  renderProposals,
  type Classification,
} from '../../lib/open-questions-migrate.js';

const ROOT = join(__dirname, '..', '..');
const FIX = join(ROOT, 'test', 'fixtures');
const LEDGER_PATH = join(FIX, 'open-questions', 'spark-facilitator-repaired.text-markdown.md');
const LEDGER = readFileSync(LEDGER_PATH, 'utf8');
const DECISIONS_PATH = join(FIX, 'decisions-backfill', 'spark-facilitator-20261001-2208', 'decisions.yaml');
const LOG = parseDecisionsYaml(readFileSync(DECISIONS_PATH, 'utf8'));
const ROWS = readLedgerOpenRows(LEDGER);

describe('reading the legacy ledger', () => {
  it('parses every open row with its fields, archive excluded', () => {
    expect(ROWS.length).toBe((LEDGER.split('## Archive')[0].match(/\*\*id:\*\*/g) ?? []).length);
    const hh = ROWS.find((r) => r.id === 'household-count-denominator')!;
    expect(hh.owner).toBe('Spark / ACE');
    expect(hh.blocking).toMatch(/^Before Phase 3/);
    expect(hh.question.length).toBeGreaterThan(20);
  });

  it('every spark ledger read in the repo parses', () => {
    for (const f of ['spark-facilitator.text-markdown.md', 'spark-facilitator-outsider-plain.text-markdown.md', 'spark-facilitator-spliced.text-markdown.md']) {
      expect(readLedgerOpenRows(readFileSync(join(FIX, 'open-questions', f), 'utf8')).length, f).toBeGreaterThan(0);
    }
  });
});

describe('the proposal is deterministic and shows its evidence', () => {
  const proposals = proposeClassification(ROWS, LOG);
  const by = (id: string) => proposals.find((p) => p.ledgerId === id)!;

  it('classifies every open row, and the same input gives the same output', () => {
    expect(proposals.map((p) => p.ledgerId)).toEqual(ROWS.map((r) => r.id));
    expect(proposeClassification(ROWS, LOG)).toEqual(proposals);
    for (const p of proposals) expect(p.evidence.length, p.ledgerId).toBeGreaterThan(0);
  });

  it('same id as a live decision row → A', () => {
    expect(by('app-runtime-default-language')).toMatchObject({ proposed: 'A' });
    expect(by('app-runtime-default-language').candidates[0]).toMatchObject({ how: 'id', score: 1 });
  });

  it('a re-worded decision row → A, citing the row and the overlap', () => {
    expect(by('household-count-denominator').proposed).toBe('A');
    expect(by('household-count-denominator').evidence[0]).toContain('household-count-source');
  });

  it('an upstream request → D; a deferred gate → C; a go/no-go with no covering row → E', () => {
    expect(by('assessment-item-rotation').proposed).toBe('D');
    expect(by('proposal-generator-boundary').proposed).toBe('C');
    expect(by('rwanda-two-cbf-attribution').proposed).toBe('C');
    expect(by('cbf-smartphones-and-connectivity').proposed).toBe('E');
  });

  it('a default the build took with no decision row → B (spec: lookup-table-provisioning)', () => {
    expect(by('lookup-table-provisioning').proposed).toBe('B');
  });

  it('renders a reviewable table with a category count', () => {
    const text = renderProposals(proposals);
    expect(text).toMatch(/^PROPOSED classification — 25 open rows \(A \d+, B \d+, C \d+, D \d+, E \d+\)/);
    expect(text).toContain('evidence:');
    expect(text).toContain('candidate:');
  });
});

describe('owner mapping', () => {
  it('drops internal owners and names the implementing organisation', () => {
    expect(ownerIsInternal('ACE / Operator')).toBe(true);
    expect(ownerIsInternal('Spark / ACE')).toBe(false);
    expect(ownerFrom('Spark / ACE')).toBe('Spark');
    expect(ownerFrom('Spark / awarded LLO')).toBe('Spark and implementing-org');
    expect(ownerFrom('Operator')).toBe('dimagi');
  });
});

function filled(): Classification {
  return {
    opp: 'spark-facilitator',
    run_id: '20261001-2208',
    rows: ROWS.map((r) => ({ id: r.id, category: 'D' as const, route: 'task' as const, note: 'test' })),
  };
}

describe('building the rows from a reviewed classification', () => {
  const opts = { ledger: ROWS, log: LOG, migratedOn: '2026-10-04' };

  it('B, C and E rows validate on the strict write path with the right shape', () => {
    const c = filled();
    const set = (id: string, e: Classification['rows'][number]) => (c.rows[c.rows.findIndex((x) => x.id === id)] = e);
    set('lookup-table-provisioning', {
      id: 'lookup-table-provisioning',
      category: 'B',
      row: {
        'ai-default': 'The pilot keeps its own step list',
        options: ['The pilot keeps its own step list', 'Use Spark lists'],
        source: 'FCAP Structure document (steps 1 to 7)',
        plain: 'The pilot keeps its own list of programme steps until Spark shares its lists.',
        plain_question: 'Will Spark share its reference lists, or should the pilot keep its own?',
        confirm_reason: 'No source says whether Spark will share its lists.',
        owner: 'partner',
        answer_channel: 'review',
      },
    });
    set('proposal-generator-boundary', {
      id: 'proposal-generator-boundary',
      category: 'C',
      row: {
        'ai-default': 'Out of scope for this pilot',
        plain: 'Proposal Development is not part of this pilot.',
        revisit_when: 'When the programme extends into Proposal Development.',
        owner: 'partner',
      },
    });
    set('cbf-smartphones-and-connectivity', {
      id: 'cbf-smartphones-and-connectivity',
      category: 'E',
      row: {
        'ai-default': 'Facilitators use their own phones',
        options: ['Facilitators use their own phones', 'Phones are provided'],
        plain: 'The build assumes each facilitator has a smartphone with data.',
        plain_question: 'Do facilitators have smartphones with data, and who pays for them?',
        confirm_reason: 'The owner ruled that devices are costed separately and asked about for this programme.',
        owner: 'partner',
        answer_channel: 'solicitation:devices',
      },
    });
    const r = buildMigration({ classification: c, ...opts });
    expect(r.errors).toEqual([]);
    const b = r.rows.find((x) => x.id === 'lookup-table-provisioning')!;
    expect(b).toMatchObject({ status: 'ai-default', review_ask: 'recommended-confirmation', owner: 'partner' });
    const cc = r.rows.find((x) => x.id === 'proposal-generator-boundary')!;
    expect(cc).toMatchObject({ status: 'deferred', revisit_when: 'When the programme extends into Proposal Development.' });
    expect(cc.review_ask).toBeUndefined();
    const e = r.rows.find((x) => x.id === 'cbf-smartphones-and-connectivity')!;
    expect(e).toMatchObject({ review_ask: 'required-before', needed_by: 'award', answer_channel: 'solicitation:devices' });
    for (const row of r.rows) expect(DecisionRowStrictSchema.safeParse(row).success, row.id).toBe(true);
    expect(r.actions.length).toBe(ROWS.length - 3);
  });

  it('A appends a superseding row only when owner / needed_by is new, and only on an ai-default row', () => {
    const c = filled();
    c.rows[c.rows.findIndex((x) => x.id === 'household-count-denominator')] = {
      id: 'household-count-denominator',
      category: 'A',
      decision_id: 'household-count-source',
      owner: 'Spark M&E',
      needed_by: 'go-live',
      row: { plain: 'The household count comes from the number recorded when a community is enrolled.' },
    };
    const r = buildMigration({ classification: c, ...opts });
    expect(r.errors).toEqual([]);
    const target = LOG.decisions.find((d) => d.id === 'household-count-source')!;
    if (target.status === 'ai-default') {
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ id: 'household-count-source-ask', supersedes: 'household-count-source', owner: 'Spark M&E', needed_by: 'go-live' });
    } else {
      expect(r.rows).toEqual([]);
    }
    expect(r.mapping.find((m) => m.id === 'household-count-denominator')?.category).toBe('A');
  });

  it('refuses: an unclassified row, an A without a live decision, a B without a default, jargon for the owner', () => {
    const c = filled();
    c.rows.pop();
    c.rows[0] = { id: c.rows[0].id, category: 'A', decision_id: 'no-such-row' };
    c.rows[1] = { id: c.rows[1].id, category: 'B', row: { plain: 'x' } };
    c.rows[2] = {
      id: c.rows[2].id,
      category: 'C',
      row: { 'ai-default': 'Later', plain: 'The value of hh_count_tt is set in Phase 9.', revisit_when: 'Later.' },
    };
    const r = buildMigration({ classification: c, ...opts });
    const all = r.errors.join('\n');
    expect(all).toMatch(/has no classification/);
    expect(all).toMatch(/needs decision_id naming a LIVE decision row/);
    expect(all).toMatch(/needs row\["ai-default"\]/);
    expect(all).toMatch(/plain/);
  });

  it('the archive carries the mapping above the original ledger', () => {
    const md = renderArchivedLedger({ original: LEDGER, mapping: [{ id: 'x', category: 'C', to: 'x' }], migratedOn: '2026-10-04', runId: '20261001-2208' });
    expect(md.startsWith('# Open Questions (archived) — migrated 2026-10-04')).toBe(true);
    expect(md).toContain('| x | C — not needed for this pilot (deferred) | x |');
    expect(md).toContain(LEDGER.trim());
  });

  it('the template pre-fills every row and marks what a human must supply', () => {
    const t = classificationTemplate({ opp: 'spark-facilitator', runId: '20261001-2208', proposals: proposeClassification(ROWS, LOG), ledger: ROWS });
    expect(t.rows.map((r) => r.id)).toEqual(ROWS.map((r) => r.id));
    expect(JSON.stringify(t)).toContain('TODO');
    const e = t.rows.find((r) => r.category === 'E')!;
    expect(e.row?.needed_by).toBe('award');
  });
});

describe('the CLI: dry-run by default; --apply refuses an unreviewed template', () => {
  const tsx = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = join(ROOT, 'scripts', 'migrate-open-questions.ts');
  const run = (...a: string[]) => spawnSync(process.execPath, [tsx, script, '--ledger', LEDGER_PATH, '--decisions', DECISIONS_PATH, ...a], { encoding: 'utf8' });

  it('dry-run prints the proposal, writes only the template it was asked for', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-oq-'));
    const tpl = join(dir, 'classification.json');
    const r = run('--write-template', tpl);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PROPOSED classification');
    expect(r.stdout).toContain('DRY RUN — nothing written.');
    expect(existsSync(tpl)).toBe(true);

    const rows = join(dir, 'rows.json');
    const archive = join(dir, 'archived.md');
    const a = run('--apply', '--classification', tpl, '--out-rows', rows, '--out-archive', archive);
    expect(a.status).toBe(1);
    expect(a.stderr).toContain('REFUSED');
    expect(a.stderr).toContain('TODO');
    expect(existsSync(rows)).toBe(false);
    expect(existsSync(archive)).toBe(false);
  });

  it('--apply with a complete classification writes the rows and the archive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-oq-'));
    const cls = join(dir, 'reviewed.json');
    writeFileSync(cls, JSON.stringify(filled()));
    const rows = join(dir, 'rows.json');
    const archive = join(dir, 'archived.md');
    const a = run('--apply', '--classification', cls, '--out-rows', rows, '--out-archive', archive);
    expect(a.status, a.stderr).toBe(0);
    expect(JSON.parse(readFileSync(rows, 'utf8'))).toEqual([]);
    expect(readFileSync(archive, 'utf8')).toContain('| lookup-table-provisioning | D');
  });
});
