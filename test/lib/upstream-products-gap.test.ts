import { describe, it, expect } from 'vitest';
import {
  classifyUpstreamProductsGaps,
  formatUpstreamProductsGapReport,
} from '../../lib/upstream-products-gap.js';
import { classifyPhaseProducts, PHASE_PRODUCTS_SCHEMAS } from '../../lib/phase-products-schema.js';

/**
 * dimagi-internal/ace#1888 — a forked run copies phase statuses but no
 * `products` blocks.
 *
 * The two fixtures below are TRANSCRIBED FROM REAL RUNS, not invented:
 *
 * - NEGATIVE CONTROL (`FORKED_RUN`): `hh-poverty-targeting/20260901-1932`,
 *   Drive file `1rt2XCCcoqfeTB5rnicAEBKRSXHc39WfX`, a fork of `20260828-0702`
 *   at `synthetic-data-and-workflows`. Read 2026-09-06.
 * - POSITIVE CONTROL (`REAL_RUN`): its source, `20260828-0702`, Drive file
 *   `1szo7z6FMbWhoIbV7Rcv-Xuh1wkRyb_oe-cmKHUUNVXw` — a run every phase of
 *   which actually executed.
 *
 * `products` values are reduced to a single representative key each; this
 * module only asks whether a block is non-empty and (via the existing fence)
 * whether required keys resolve, so the reduction preserves every property
 * under test. Statuses and verdicts are verbatim.
 */

const DOC = {
  file_id: '1abcDEF',
  title: 'Onboarding email',
  web_view_link: 'https://docs.google.com/document/d/1abcDEF/edit',
};

/** The real fork, AFTER the operator hand-seeded phases 3 and 4. */
const FORKED_RUN = {
  forked_from: '20260828-0702',
  forked_from_phase: 'synthetic-data-and-workflows',
  phases: {
    'idea-to-design': { status: 'done', verdict: 'seeded' },
    'scenarios-and-acceptance': { status: 'done', verdict: 'seeded' },
    'commcare-setup': {
      status: 'done',
      verdict: 'seeded',
      products: { apps: { learn: { hq_app_id: 'abc' }, deliver: { hq_app_id: 'def' } } },
    },
    'connect-setup': {
      status: 'done',
      verdict: 'seeded',
      products: {
        connect: {
          opportunity: { url: 'https://connect.dimagi.com/o/1', connect_int_id: 10055 },
          domain: 'connect-ace-prod',
          ace_test_user: { invite_row_present: true },
        },
      },
    },
    'ocs-setup': { status: 'done', verdict: 'seeded' },
    'qa-and-training': { status: 'done', verdict: 'seeded' },
    'synthetic-data-and-workflows': {
      status: 'pending',
    },
    'solicitation-management': { status: 'skipped', verdict: 'skipped' },
    'execution-management': { status: 'skipped', verdict: 'skipped' },
    closeout: { status: 'skipped', verdict: 'skipped' },
  },
};

/** The real source run — every phase actually executed. */
const REAL_RUN = {
  phases: {
    'idea-to-design': { status: 'done', products: { pdd: DOC, work_order: DOC } },
    // No registered schema → exempt by construction, and really has no products.
    'scenarios-and-acceptance': { status: 'done' },
    'commcare-setup': {
      status: 'done',
      products: { apps: { learn: { hq_app_id: 'abc' }, deliver: { hq_app_id: 'def' } } },
    },
    'connect-setup': {
      status: 'done',
      products: {
        connect: {
          opportunity: { url: 'https://connect.dimagi.com/o/1' },
          domain: 'connect-ace-prod',
          ace_test_user: { invite_row_present: true },
        },
      },
    },
    'ocs-setup': { status: 'done', products: { ocs_chatbot: { id: 'bot-1' } } },
    'qa-and-training': {
      status: 'done',
      products: { training: { deck: DOC, docs: { onboarding_email: DOC } } },
    },
    'synthetic-data-and-workflows': { status: 'done', products: { synthetic: { env: 'e1' } } },
    'solicitation-management': {
      status: 'done',
      products: { solicitation: { url: 'https://labs.connect.dimagi.com/solicitations/1/' } },
    },
    'execution-management': { status: 'pending' },
    closeout: { status: 'pending' },
  },
};

describe('classifyUpstreamProductsGaps — the real fork (negative control)', () => {
  const report = classifyUpstreamProductsGaps(FORKED_RUN);

  it('flags exactly the three phases the live fork left without a handoff', () => {
    expect(report.ok).toBe(false);
    expect(report.gaps.map((g) => g.phase).sort()).toEqual([
      'idea-to-design',
      'ocs-setup',
      'qa-and-training',
    ]);
  });

  it('blocks, because a pending phase is about to be dispatched over the gap', () => {
    expect(report.blocking).toBe(true);
    expect(report.pendingPhases).toEqual(['synthetic-data-and-workflows']);
  });

  it('classifies all three as products-absent, not as missing required keys', () => {
    // This is the whole point. `idea-to-design` and `ocs-setup` have NO
    // entries in REQUIRED_PRODUCT_KEYS, so a required-key check reads ok:true
    // on them — see the "existing fences are blind" test below.
    expect(report.gaps.every((g) => g.kind === 'products-absent')).toBe(true);
    expect(report.gaps.every((g) => g.missing.length === 0)).toBe(true);
  });

  it('names the phase and its seeded verdict in the operator-facing message', () => {
    const ocs = report.gaps.find((g) => g.phase === 'ocs-setup')!;
    expect(ocs.verdict).toBe('seeded');
    expect(ocs.message).toContain('`ocs-setup`');
    expect(ocs.message).toContain('verdict: seeded');
    expect(ocs.message).toContain('products');
  });

  it('renders a HALT block naming ace#1888 and the pending phase', () => {
    const text = formatUpstreamProductsGapReport(report, { runLabel: '20260901-1932' });
    expect(text).toContain('HALT');
    expect(text).toContain('20260901-1932');
    expect(text).toContain('synthetic-data-and-workflows');
    expect(text).toContain('ace#1888');
  });

  it('does NOT flag the two phases the operator hand-seeded', () => {
    const flagged = report.gaps.map((g) => g.phase);
    expect(flagged).not.toContain('commcare-setup');
    expect(flagged).not.toContain('connect-setup');
  });

  it('does NOT flag skipped phases — a skipped phase owes no handoff', () => {
    const flagged = report.gaps.map((g) => g.phase);
    expect(flagged).not.toContain('solicitation-management');
    expect(flagged).not.toContain('execution-management');
    expect(flagged).not.toContain('closeout');
  });

  it('does NOT flag scenarios-and-acceptance, which has no registered schema', () => {
    expect('scenarios-and-acceptance' in PHASE_PRODUCTS_SCHEMAS).toBe(false);
    expect(report.gaps.map((g) => g.phase)).not.toContain('scenarios-and-acceptance');
  });
});

describe('the existing fences really are blind to this (why the module exists)', () => {
  it('classifyPhaseProducts reads ok:true on two of the three absent blocks', () => {
    // Measured live on the fork before this module existed. If this ever goes
    // red, the required-key fence has grown to cover the class and this
    // module can narrow — but do not delete it on a hunch.
    expect(classifyPhaseProducts(FORKED_RUN, 'idea-to-design').ok).toBe(true);
    expect(classifyPhaseProducts(FORKED_RUN, 'ocs-setup').ok).toBe(true);
    // qa-and-training is the one it does catch — it declares required keys.
    expect(classifyPhaseProducts(FORKED_RUN, 'qa-and-training').ok).toBe(false);
  });
});

describe('classifyUpstreamProductsGaps — the real source run (positive control)', () => {
  const report = classifyUpstreamProductsGaps(REAL_RUN);

  it('is clean: 8 of 8 terminal schema-registered phases carry a handoff', () => {
    expect(report.gaps).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.blocking).toBe(false);
  });

  it('formats to the empty string, so a caller can print conditionally', () => {
    expect(formatUpstreamProductsGapReport(report)).toBe('');
  });

  it('still reports its pending phases', () => {
    expect(report.pendingPhases).toEqual(['execution-management', 'closeout']);
  });
});

describe('mutation guards — each rule is load-bearing', () => {
  it('an EMPTY products object is a gap, not a handoff', () => {
    const r = classifyUpstreamProductsGaps({
      phases: { 'ocs-setup': { status: 'done', products: {} }, closeout: { status: 'pending' } },
    });
    expect(r.gaps.map((g) => g.kind)).toEqual(['products-absent']);
  });

  it('a NULL products value is a gap', () => {
    const r = classifyUpstreamProductsGaps({
      phases: { 'ocs-setup': { status: 'done', products: null }, closeout: { status: 'pending' } },
    });
    expect(r.gaps).toHaveLength(1);
  });

  it('a present-but-incomplete block reports required-keys-missing with the paths', () => {
    const r = classifyUpstreamProductsGaps({
      phases: {
        'connect-setup': { status: 'done', products: { connect: { domain: 'd' } } },
        closeout: { status: 'pending' },
      },
    });
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0].kind).toBe('required-keys-missing');
    expect(r.gaps[0].missing).toContain('products.connect.opportunity.url');
  });

  it('an in-flight (non-terminal) phase owes nothing yet', () => {
    const r = classifyUpstreamProductsGaps({
      phases: { 'ocs-setup': { status: 'in_progress' }, closeout: { status: 'pending' } },
    });
    expect(r.ok).toBe(true);
  });

  it('`partial` is on the terminal side of the line, matching ace#1139', () => {
    const r = classifyUpstreamProductsGaps({
      phases: { 'ocs-setup': { status: 'partial' }, closeout: { status: 'pending' } },
    });
    expect(r.gaps.map((g) => g.phase)).toEqual(['ocs-setup']);
  });

  it('`complete` is accepted as a terminal synonym of `done`', () => {
    const r = classifyUpstreamProductsGaps({
      phases: { 'ocs-setup': { status: 'complete' }, closeout: { status: 'pending' } },
    });
    expect(r.gaps.map((g) => g.phase)).toEqual(['ocs-setup']);
  });

  it('a gap with nothing left to dispatch is advisory, not blocking', () => {
    const r = classifyUpstreamProductsGaps({
      phases: { 'ocs-setup': { status: 'done' }, closeout: { status: 'done', products: { x: 1 } } },
    });
    expect(r.ok).toBe(false);
    expect(r.blocking).toBe(false);
    expect(formatUpstreamProductsGapReport(r)).toContain('WARN');
  });

  it('a run_state with no phases key is not an error', () => {
    expect(classifyUpstreamProductsGaps({}).ok).toBe(true);
    expect(classifyUpstreamProductsGaps(null).ok).toBe(true);
    expect(classifyUpstreamProductsGaps({ phases: [] }).ok).toBe(true);
  });
});
