/**
 * Regression corpus for the external-review-surface audit.
 *
 * On 2026-08-14 the first ACE run ever shown to an external party
 * (`spark-facilitator/20260813-2126`) shipped with twelve defects, and EVERY
 * automated check we had reported green. This file is the specification: each
 * `describe` below is one of those twelve, expressed as a payload the auditor
 * must reject.
 *
 * **The rule these tests exist to enforce is not "the auditor finds bugs" — it
 * is "the auditor cannot silently find nothing."** The most expensive failure
 * of that day was a check that counted a payload key named `questions` when the
 * field is `items`: it reported 0 forever and nearly sent someone to fix a
 * working feature. So several tests below assert that the auditor BLOCKS when
 * its own inputs or assumptions are missing, rather than passing.
 *
 * If you are here because a test failed after changing `SURFACE_CONTRACT`:
 * that is the contract with `ace-web` (frozen on the other side by
 * `apps/opps/tests/test_public_surface_contract.py`). Reconcile both, don't
 * relax one.
 */

import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACCEPTED_PUBLIC_SECRETS,
  auditCompleteness,
  auditWalkthroughParity,
  auditSyntheticLabelling,
  auditBuildStatusParity,
  auditDeepQaParity,
  auditConfidentiality,
  auditContract,
  auditArchetypeContradiction,
  auditDecisionRows,
  auditDocFidelity,
  auditGuideScreenshots,
  auditLinks,
  auditRender,
  auditReviewerMembership,
  auditUnresolvedMemberGates,
  applyRenderedGates,
  auditAssistantAccess,
  canonicalDocUrl,
  derivePublicChatUrl,
  classifyLink,
  collectUrls,
  GATE_TEXT_MAX_CHARS,
  isBlocking,
  isFileDownloadUrl,
  sameOriginGateCandidates,
  labelMatchesPhaseTag,
  resolveDocSource,
  stripMarkdownSyntax,
  summarise,
  type DocProbe,
  type DocSourceMap,
  type Finding,
  type ProbedLink,
  type RenderReport,
} from '../../lib/run-surface-audit.js';

const PAGE = 'https://labs.connect.dimagi.com/ace/opps/dimagi-team/demo-opp/runs/20260813-2126/summary';

/** A payload with every section present — the shape a healthy run serves. */
function healthyPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    opp: {
      workspace_slug: 'dimagi-team',
      slug: 'demo-opp',
      run_id: '20260813-2126',
      display_name: 'Demo',
      description: 'x',
      status: 'active',
    },
    design: { docs: [{ title: 'PDD', url: 'https://docs.google.com/document/d/PDDPDDPDDPDD/edit', access: 'public' }] },
    apps: [],
    // Null on a clean run — the honest default for these three.
    build: null,
    // Null unless `/ace:qa-deep` actually ran, which is most runs.
    deep_qa: null,
    connect: null,
    training: null,
    assistant: null,
    walkthroughs: [],
    dashboards: [],
    synthetic: null,
    selected_llo: null,
    solicitation: null,
    launch: null,
    cycle_grade: null,
    opp_eval: null,
    learnings: null,
    open_questions: null,
    stage: { label: 'solicitation', pending_sections: [] },
    feedback: [],
    decisions: null,
    reactions: {},
    decision_edits: {},
    workbench: { url: '/ace/w/dimagi-team/opps/demo-opp/runs/20260813-2126', access: 'admin' },
    viewer: { is_member: false },
    ...over,
  };
}

function codes(findings: Finding[]): string[] {
  return findings.map((f) => f.code);
}

function probed(over: Partial<ProbedLink> = {}): ProbedLink {
  return {
    label: 'design.docs[0].url',
    url: 'https://docs.google.com/document/d/PDDPDDPDDPDD/edit',
    declaredAccess: 'public',
    status: 200,
    cls: 'OK',
    note: '',
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════
// The auditor must fail loudly when its own assumptions are wrong.
// This is the cautionary tale, and it comes first because every other
// check in the file depends on it.
// ═══════════════════════════════════════════════════════════════════

describe('the auditor cannot silently find nothing', () => {
  it('BLOCKS on a section it has never been taught about', () => {
    // ace-web grew a section this auditor does not audit. Reporting "clean" on
    // a page containing an unaudited section is false assurance.
    const findings = auditContract(healthyPayload({ brand_new_section: { url: 'https://x.test/' } }));
    expect(codes(findings)).toContain('CONTRACT-UNKNOWN-SECTION');
    expect(findings.filter((f) => f.code === 'CONTRACT-UNKNOWN-SECTION').every(isBlocking)).toBe(true);
  });

  it('BLOCKS when a section it reads has vanished from the payload', () => {
    const p = healthyPayload();
    delete p.open_questions;
    const findings = auditContract(p);
    const missing = findings.filter((f) => f.code === 'CONTRACT-MISSING-SECTION');
    expect(missing.map((f) => f.where)).toContain('open_questions');
    expect(missing.every(isBlocking)).toBe(true);
  });

  it('distinguishes "absent" from "null" — a run that has not reached a phase is not a defect', () => {
    // `open_questions: null` is legitimate. Only a MISSING key is drift.
    const findings = auditContract(healthyPayload({ open_questions: null }));
    expect(codes(findings)).not.toContain('CONTRACT-MISSING-SECTION');
  });

  it('reads open questions from `items`, and says so when the key moves', () => {
    // THE cautionary tale: an agent "verified" open questions by counting a key
    // named `questions`. The field is `items`. It reported 0 forever.
    const findings = auditContract(
      healthyPayload({ open_questions: { url: 'https://docs.google.com/document/d/OQOQOQOQOQOQ/edit', access: 'admin', questions: [] } }),
    );
    const drift = findings.filter((f) => f.code === 'CONTRACT-KEY-DRIFT' && f.where === 'open_questions');
    expect(drift).toHaveLength(1);
    expect(drift[0].detail).toContain('items');
    expect(isBlocking(drift[0])).toBe(true);
  });

  it('BLOCKS rather than passing when completeness was never verified', () => {
    const findings = auditCompleteness(healthyPayload(), null);
    expect(codes(findings)).toEqual(['COMPLETENESS-UNVERIFIED']);
    expect(findings.every(isBlocking)).toBe(true);
  });

  it('BLOCKS rather than passing when document fidelity was never verified', () => {
    const findings = auditDocFidelity([
      { label: 'training.docs[0].url', url: 'https://docs.google.com/document/d/AAAAAAAAAAAA/edit', text: 'clean prose', imageCount: 3 },
    ]);
    expect(codes(findings)).toEqual(['DOC-FIDELITY-UNVERIFIED']);
    expect(findings.every(isBlocking)).toBe(true);
  });

  it('collapses many unverified documents into ONE finding, so a real one is not scrolled past', () => {
    const many: DocProbe[] = Array.from({ length: 8 }, (_, i) => ({
      label: `training.docs[${i}].url`,
      url: `https://docs.google.com/document/d/DOC${i}DOC${i}DOC/edit`,
      text: 'clean prose',
      imageCount: 1,
    }));
    expect(auditDocFidelity(many).filter((f) => f.code === 'DOC-FIDELITY-UNVERIFIED')).toHaveLength(1);
  });

  it('BLOCKS when the probe turns out not to have been anonymous', () => {
    // A member is served a different document. Every confidentiality conclusion
    // drawn from a member's payload is about the wrong thing.
    const findings = auditConfidentiality(healthyPayload({ viewer: { is_member: true } }), { anonymous: true });
    expect(codes(findings)).toContain('PROBE-NOT-ANONYMOUS');
  });

  it('BLOCKS when the rendered page was never opened', () => {
    // Enforced in the CLI rather than the lib, so assert the shape the CLI
    // relies on: an undetermined render check is never a pass.
    const report: RenderReport = {
      renderedHrefs: [],
      notCreatedLabels: [],
      decisionEditCommitsOnPick: null,
      provenanceVisibleByDefault: null,
      writePaths: { comment: 422, edit: 422 },
      undetermined: ['selectors did not match'],
    };
    const findings = auditRender(healthyPayload({ design: null }), report, PAGE);
    expect(codes(findings)).toContain('RENDER-UNDETERMINED');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Defect 1 — every reviewer-facing Drive deliverable was private, and
// the checker reported `12 links · 0 BROKEN`, exit 0.
// ═══════════════════════════════════════════════════════════════════

describe('defect 1 — a private ACE-authored deliverable is a wall, not an auth gate', () => {
  it('classifies a 401 on a Google Doc as PRIVATE-DELIVERABLE, not AUTH-GATED', () => {
    const { cls } = classifyLink('https://docs.google.com/document/d/AAAAAAAAAAAA/edit', 401);
    expect(cls).toBe('PRIVATE-DELIVERABLE');
  });

  it('classifies a sign-in REDIRECT on a Google Doc the same way', () => {
    const { cls } = classifyLink(
      'https://docs.google.com/document/d/AAAAAAAAAAAA/edit',
      200,
      'https://accounts.google.com/v3/signin/identifier?...',
    );
    expect(cls).toBe('PRIVATE-DELIVERABLE');
  });

  it('still passes a genuine third-party login wall', () => {
    // A platform login gate opens for anyone with an account. A private Google
    // Doc opens only for accounts explicitly shared on it. That is the whole
    // distinction, and the old checker did not make it.
    expect(classifyLink('https://labs.connect.dimagi.com/labs/workflow/1/run/', 302, 'https://labs.connect.dimagi.com/accounts/login/').cls)
      .toBe('AUTH-GATED');
  });

  it('makes a private deliverable BLOCK sharing', () => {
    const findings = auditLinks([probed({ cls: 'PRIVATE-DELIVERABLE', status: 401, declaredAccess: 'public' })]);
    expect(codes(findings)).toContain('LINK-PRIVATE-DELIVERABLE');
    expect(summarise(findings).safeToShare).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Defect 2 — the public payload served the OCS embed key anonymously.
// ═══════════════════════════════════════════════════════════════════

describe('defect 2 — secrets on the anonymous payload', () => {
  it('flags a NEW secret-shaped value that nobody has signed off', () => {
    const findings = auditConfidentiality(
      healthyPayload({ assistant: { ocs_url: 'https://x.test/', access: 'admin', public_id: 'p', api_key: 'sk-live-abc123' } }),
      { anonymous: true },
    );
    const secrets = findings.filter((f) => f.code === 'CONF-SECRET-EXPOSED');
    expect(secrets.map((f) => f.where)).toContain('assistant.api_key');
    expect(secrets.every(isBlocking)).toBe(true);
  });

  it('does NOT re-flag the one exposure that was reviewed and accepted', () => {
    // `assistant.embed_key` is a per-chatbot public identifier the browser
    // widget reads off the page by construction (ace-web#706). It stays, WITH
    // its reasoning recorded, so the NEXT key does not ride along on it.
    const findings = auditConfidentiality(
      healthyPayload({ assistant: { ocs_url: 'https://x.test/', access: 'admin', public_id: 'p', embed_key: 'k' } }),
      { anonymous: true },
    );
    expect(codes(findings)).not.toContain('CONF-SECRET-EXPOSED');
    expect(ACCEPTED_PUBLIC_SECRETS['assistant.embed_key']).toMatch(/ace-web#706/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Defect 3 — a privately-captured reviewer's ledger, republished.
// ═══════════════════════════════════════════════════════════════════

describe('defect 3 — a private review must not be republished anonymously', () => {
  it('flags an admin-tagged feedback ledger on an anonymous payload', () => {
    const findings = auditConfidentiality(
      healthyPayload({ feedback: [{ title: '2026-07-27 · Sophie Feintuch', url: 'https://docs.google.com/document/d/LEDGERLEDGER/edit', access: 'admin' }] }),
      { anonymous: true },
    );
    const leak = findings.filter((f) => f.code === 'CONF-PRIVATE-REVIEW-LINKED');
    expect(leak).toHaveLength(1);
    expect(isBlocking(leak[0])).toBe(true);
  });

  it('accepts a ledger the reviewer agreed to publish', () => {
    const findings = auditConfidentiality(
      healthyPayload({ feedback: [{ title: 'Public review', url: 'https://docs.google.com/document/d/LEDGERLEDGER/edit', access: 'public' }] }),
      { anonymous: true },
    );
    expect(codes(findings)).not.toContain('CONF-PRIVATE-REVIEW-LINKED');
  });

  it('does NOT confuse confidentiality with usability — an admin link elsewhere is fine', () => {
    // Hiding a link an external reviewer cannot use is as bad as letting it 404.
    // Only the feedback ledger is a confidentiality rule.
    const findings = auditConfidentiality(healthyPayload(), { anonymous: true });
    expect(codes(findings)).not.toContain('CONF-PRIVATE-REVIEW-LINKED');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Defect 4 — links an external viewer cannot open, shown untagged.
// ═══════════════════════════════════════════════════════════════════

describe('defect 4 — a link an outsider cannot open must say so', () => {
  it('flags a gated link with no access tag', () => {
    const findings = auditLinks([
      probed({ label: 'apps[0].hq_url', url: 'https://www.commcarehq.org/a/dom/apps/view/x/', declaredAccess: null, cls: 'MEMBER-GATED', status: 302 }),
    ]);
    expect(codes(findings)).toContain('LINK-UNTAGGED');
  });

  it('flags a link the page CLAIMS is public but which gates anonymously', () => {
    const findings = auditLinks([probed({ declaredAccess: 'public', cls: 'MEMBER-GATED', status: 403 })]);
    const lie = findings.filter((f) => f.code === 'LINK-ACCESS-MISLABELLED');
    expect(lie).toHaveLength(1);
    expect(isBlocking(lie[0])).toBe(true);
  });

  it('refuses to certify member-gated links when nobody named the reviewers', () => {
    // Anonymous reachability only proves a link works for SOMEBODY.
    const gated = probed({ url: 'https://www.commcarehq.org/a/dom/apps/view/x/', cls: 'MEMBER-GATED', declaredAccess: 'admin' });
    expect(codes(auditUnresolvedMemberGates([gated], []))).toEqual(['REVIEWERS-UNDECLARED']);
    expect(auditUnresolvedMemberGates([gated], ['a@b.c'])).toEqual([]);
  });

  it('treats an unverified membership as blocking, not as fine', () => {
    // "We did not check" is not "it is fine", and treating it as fine is the bug.
    const gated = probed({ url: 'https://www.commcarehq.org/a/dom/apps/view/x/', cls: 'MEMBER-GATED' });
    const unverified = auditReviewerMembership([gated], ['sophie@example.org'], {});
    expect(codes(unverified)).toEqual(['MEMBER-UNVERIFIED']);
    expect(unverified.every(isBlocking)).toBe(true);

    const missing = auditReviewerMembership([gated], ['sophie@example.org'], { hq: { 'sophie@example.org': false } });
    expect(codes(missing)).toEqual(['MEMBER-MISSING']);

    const ok = auditReviewerMembership([gated], ['sophie@example.org'], { hq: { 'sophie@example.org': true } });
    expect(ok).toEqual([]);
  });

  it('does not mistake a labs dashboard for a membership-gated Connect page', () => {
    // `labs.connect.dimagi.com` CONTAINS `connect.dimagi.com`; its /labs/ pages
    // are merely login-gated. The path prefix is load-bearing.
    expect(classifyLink('https://labs.connect.dimagi.com/labs/workflow/1/run/', 403).cls).toBe('AUTH-GATED');
    expect(classifyLink('https://connect.dimagi.com/a/org/opportunity/x/', 403).cls).toBe('MEMBER-GATED');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Defect 5 — "Not created" while the data existed (key-contract drift).
// ═══════════════════════════════════════════════════════════════════

describe('defect 5 — a key-name mismatch renders as absence', () => {
  it('flags a dashboard entry carrying the OLD key names', () => {
    // The data was under `par_url` / `key`, nested in `synthetic.source`. The
    // reader looked for `url` / `title` and drew "Not created".
    const findings = auditContract(healthyPayload({ dashboards: [{ key: 'llo_weekly', par_url: 'https://labs.test/x' }] }));
    const drift = findings.filter((f) => f.code === 'CONTRACT-KEY-DRIFT' && f.where === 'dashboards[0]');
    expect(drift).toHaveLength(1);
    expect(drift[0].detail).toMatch(/url/);
  });

  it('flags a walkthrough carrying the OLD key names', () => {
    const findings = auditContract(healthyPayload({ walkthroughs: [{ key: 'p1', par_url: 'https://labs.test/w' }] }));
    expect(findings.some((f) => f.code === 'CONTRACT-KEY-DRIFT' && f.where === 'walkthroughs[0]')).toBe(true);
  });

  it('catches the rendered face: a populated section drawn as "Not created"', () => {
    const payload = healthyPayload({
      dashboards: [{ title: 'LLO weekly', url: 'https://labs.test/x', access: 'admin' }],
    });
    const report: RenderReport = {
      renderedHrefs: ['https://docs.google.com/document/d/PDDPDDPDDPDD/edit'],
      notCreatedLabels: ['Dashboard'],
      decisionEditCommitsOnPick: true,
      provenanceVisibleByDefault: true,
      writePaths: { comment: 422, edit: 422 },
      undetermined: [],
    };
    const findings = auditRender(payload, report, PAGE);
    const contra = findings.filter((f) => f.code === 'RENDER-CONTRADICTS-PAYLOAD');
    expect(contra.map((f) => f.where)).toContain('dashboards');
    expect(contra.every(isBlocking)).toBe(true);
  });

  it('does not fire when the section really is rendered', () => {
    const payload = healthyPayload({ dashboards: [{ title: 'LLO weekly', url: 'https://labs.test/x', access: 'admin' }] });
    const report: RenderReport = {
      renderedHrefs: ['https://labs.test/x', 'https://docs.google.com/document/d/PDDPDDPDDPDD/edit'],
      notCreatedLabels: ['Live'],
      decisionEditCommitsOnPick: true,
      provenanceVisibleByDefault: true,
      writePaths: { comment: 422, edit: 422 },
      undetermined: [],
    };
    expect(codes(auditRender(payload, report, PAGE))).not.toContain('RENDER-CONTRADICTS-PAYLOAD');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Defect 6 — the PDD and Work Order were absent from the page entirely.
// ═══════════════════════════════════════════════════════════════════

describe('defect 6 — a product the run made and the page never shows', () => {
  const runState = {
    phases: {
      'idea-to-design': {
        products: {
          // Note: a bare `file_id`, with no URL at all. A `url`-only reader
          // silently sees nothing here — the same class of miss as defect 5.
          pdd: { title: 'PDD', file_id: 'PDDPDDPDDPDD' },
          work_order: { title: 'Work Order', file_id: 'WOWOWOWOWOWO' },
        },
      },
    },
  };

  it('flags the Work Order when the page links only the PDD', () => {
    const findings = auditCompleteness(healthyPayload(), runState);
    const missing = findings.filter((f) => f.code === 'MISSING-ARTIFACT');
    expect(missing).toHaveLength(1);
    expect(missing[0].detail).toContain('WOWOWOWOWOWO');
    expect(missing.every(isBlocking)).toBe(true);
  });

  it('passes once both are on the page, matching on the Drive file id', () => {
    const payload = healthyPayload({
      design: {
        docs: [
          { title: 'PDD', url: 'https://docs.google.com/document/d/PDDPDDPDDPDD/edit', access: 'public' },
          { title: 'Work Order', url: 'https://docs.google.com/document/d/WOWOWOWOWOWO/edit?usp=drivesdk', access: 'public' },
        ],
      },
    });
    expect(auditCompleteness(payload, runState)).toEqual([]);
  });

  it('does not demand that internal build-tool URLs appear on a partner page', () => {
    // A Nova build URL is correctly absent. Expecting it would train the reader
    // to ignore this check.
    const withNova = {
      phases: { 'commcare-setup': { products: { apps: { learn: { nova_url: 'https://commcare.app/build/x' } } } } },
    };
    expect(auditCompleteness(healthyPayload(), withNova)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Defect 7 — a produced walkthrough served as `walkthroughs: []`
// ═══════════════════════════════════════════════════════════════════

describe('walkthrough count parity', () => {
  const withWalkthroughs = (n: number) => ({
    'synthetic-data-and-workflows': {
      products: {
        synthetic: {
          walkthroughs: Array.from({ length: n }, (_, i) => ({
            persona: `p${i}`,
            video_web_view_link: `https://drive.google.com/file/d/v${i}/view`,
            eval_verdict: 'warn',
          })),
        },
      },
    },
  });

  it('flags a produced walkthrough the page does not show at all', () => {
    // The exact shape that shipped: run_state has the video, the page has
    // an empty list, and every other check is green because there is no
    // item present to inspect.
    const findings = auditWalkthroughParity({ walkthroughs: [] }, withWalkthroughs(1));
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('WALKTHROUGH-DROPPED');
    expect(findings[0].detail).toContain('produced 1');
    expect(findings[0].detail).toContain('shows 0');
    expect(isBlocking(findings[0])).toBe(true);
  });

  it('flags a partial drop, not just a total one', () => {
    const findings = auditWalkthroughParity({ walkthroughs: [{ persona: 'p0' }] }, withWalkthroughs(3));
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('produced 3');
  });

  it('passes a WITHHELD walkthrough, which has no link by design', () => {
    // The point of counting rather than URL-matching: a withheld entry is
    // the page behaving correctly. A link check would flag it and train
    // the reader to ignore this finding.
    const findings = auditWalkthroughParity(
      { walkthroughs: [{ persona: 'p0', url: null, availability: 'withheld' }] },
      withWalkthroughs(1),
    );
    expect(findings).toEqual([]);
  });

  it('passes an UNAVAILABLE walkthrough — surfaced without a link is still surfaced', () => {
    const findings = auditWalkthroughParity(
      { walkthroughs: [{ persona: 'p0', url: null, availability: 'unavailable' }] },
      withWalkthroughs(1),
    );
    expect(findings).toEqual([]);
  });

  it('stays silent when the run produced no walkthroughs', () => {
    expect(auditWalkthroughParity({ walkthroughs: [] }, {})).toEqual([]);
    expect(auditWalkthroughParity({ walkthroughs: [] }, withWalkthroughs(0))).toEqual([]);
  });

  it('is reached through auditCompleteness, not only when called directly', () => {
    const findings = auditCompleteness({ walkthroughs: [] }, { phases: withWalkthroughs(1) });
    expect(findings.some((f) => f.code === 'WALKTHROUGH-DROPPED')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Defect 7 — a root-relative footer link, 404 anonymously, invisible to
// a checker that filtered on `startswith("http")`.
// ═══════════════════════════════════════════════════════════════════

describe('defect 7 — relative URLs must be collected and checked', () => {
  it('resolves a root-relative payload URL against the page URL', () => {
    const urls = collectUrls(healthyPayload(), PAGE);
    const wb = urls.find((u) => u.label === 'workbench.url');
    expect(wb?.url).toBe('https://labs.connect.dimagi.com/ace/w/dimagi-team/opps/demo-opp/runs/20260813-2126');
  });

  it('would have SEEN the un-prefixed link that 404d for every reader', () => {
    const p = healthyPayload({ workbench: { url: '/w/dimagi-team/opps/demo-opp/runs/20260813-2126', access: 'admin' } });
    const wb = collectUrls(p, PAGE).find((u) => u.label === 'workbench.url');
    // Missing the `/ace` mount — resolved to the origin, which is what the
    // browser does, and what 404d.
    expect(wb?.url).toBe('https://labs.connect.dimagi.com/w/dimagi-team/opps/demo-opp/runs/20260813-2126');
  });

  it('carries each link\'s declared access alongside it', () => {
    const urls = collectUrls(healthyPayload(), PAGE);
    expect(urls.find((u) => u.label === 'design.docs[0].url')?.declaredAccess).toBe('public');
  });

  it('reports a broken link as BROKEN and blocks', () => {
    const findings = auditLinks([probed({ cls: 'BROKEN', status: 404, note: 'not found' })]);
    expect(codes(findings)).toContain('LINK-BROKEN');
    expect(findings[0].severity).toBe('broken');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Defect 8 — phase labels derived by ordinal.
// ═══════════════════════════════════════════════════════════════════

describe('defect 8 — a decision must be published under its own phase name', () => {
  it('accepts a label that names the phase its tag names', () => {
    expect(labelMatchesPhaseTag('3-commcare', 'CommCare setup')).toBe(true);
    expect(labelMatchesPhaseTag('1-design', 'Idea to Design')).toBe(true);
    expect(labelMatchesPhaseTag('8-solicitation-management', 'Solicitation management')).toBe(true);
  });

  it('rejects a label with no relationship to the tag — the ordinal-derived failure', () => {
    expect(labelMatchesPhaseTag('4-connect', 'Solicitation management')).toBe(false);
  });

  it('flags such a row', () => {
    const findings = auditContract(
      healthyPayload({
        decisions: {
          total: 1,
          counts: {},
          rows: [
            {
              id: 'x', phase: 'connect-setup', phase_raw: '4-connect', phase_label: 'Solicitation management',
              phase_ordinal: 8, skill: 's', question: 'q', ai_default: 'a', status: 'ai-default', evidence_basis: 'stated',
            },
          ],
        },
      }),
    );
    expect(codes(findings)).toContain('DECISION-PHASE-LABEL-DRIFT');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Defects 9 + 10 — the rendered experience.
// ═══════════════════════════════════════════════════════════════════

describe('defects 9 and 10 — what the reader actually sees', () => {
  const base: RenderReport = {
    renderedHrefs: ['https://docs.google.com/document/d/PDDPDDPDDPDD/edit', 'https://labs.connect.dimagi.com/ace/w/dimagi-team/opps/demo-opp/runs/20260813-2126'],
    notCreatedLabels: [],
    decisionEditCommitsOnPick: true,
    provenanceVisibleByDefault: true,
    writePaths: { comment: 422, edit: 422 },
    undetermined: [],
  };

  it('defect 9 — flags an edit that needs a separate commit click on every row', () => {
    const findings = auditRender(healthyPayload(), { ...base, decisionEditCommitsOnPick: false }, PAGE);
    expect(codes(findings)).toContain('RENDER-EDIT-NEEDS-EXTRA-COMMIT');
  });

  it('defect 10 — flags provenance visible only after expanding a disclosure', () => {
    const findings = auditRender(healthyPayload(), { ...base, provenanceVisibleByDefault: false }, PAGE);
    const hidden = findings.filter((f) => f.code === 'RENDER-PROVENANCE-HIDDEN');
    expect(hidden).toHaveLength(1);
    expect(isBlocking(hidden[0])).toBe(true);
  });

  it('flags a write path a partner cannot reach', () => {
    const findings = auditRender(healthyPayload(), { ...base, writePaths: { comment: 404, edit: 422 } }, PAGE);
    const broken = findings.filter((f) => f.code === 'WRITE-PATH-UNREACHABLE');
    expect(broken).toHaveLength(1);
    expect(broken[0].severity).toBe('broken');
  });

  it('treats a 422 as proof the write path is live — the handler rejected an invalid body', () => {
    expect(codes(auditRender(healthyPayload(), base, PAGE))).not.toContain('WRITE-PATH-UNREACHABLE');
  });

  it('is clean on a healthy render', () => {
    expect(auditRender(healthyPayload(), base, PAGE)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Defects 11 + 12 — the documents themselves.
// ═══════════════════════════════════════════════════════════════════

describe('defect 11 — a document that shows the reader raw markdown', () => {
  const doc = (text: string): DocProbe => ({
    label: 'training.docs[0].url',
    url: 'https://docs.google.com/document/d/AAAAAAAAAAAA/edit',
    text,
    imageCount: 2,
    sourceMarkdown: null,
  });

  it('flags ATX headings', () => {
    expect(codes(auditDocFidelity([doc('Intro\n\n## Step one\n\nDo the thing.')]))).toContain('DOC-LITERAL-MARKDOWN');
  });

  it('flags YAML frontmatter and bold markers', () => {
    expect(codes(auditDocFidelity([doc('---\ntitle: x\n---\n\nbody')]))).toContain('DOC-LITERAL-MARKDOWN');
    expect(codes(auditDocFidelity([doc('This is **very** important')]))).toContain('DOC-LITERAL-MARKDOWN');
  });

  it('does NOT fire on a properly converted document', () => {
    // Regression: with `\s` and the `m` flag the heading pattern matched a lone
    // `#` (a table column literally named "#") against the FIRST CHARACTER OF
    // THE NEXT LINE, and reported spark-facilitator's clean PDD as raw
    // markdown. A false positive trains the reader to ignore the auditor.
    expect(auditDocFidelity([doc('Metrics\n\n#\n\tMetric\n\tUnit\n\tTarget\n')])).toEqual([]);
  });

  it('does not fire on prose containing a single asterisk or hash', () => {
    expect(auditDocFidelity([doc('Rate is 5 * 3 and item #4 is next.')])).toEqual([]);
  });
});

describe('defect 12 — content that did not survive publication', () => {
  it('flags words the published document lost', () => {
    const findings = auditDocFidelity([
      {
        label: 'training.docs[0].url',
        url: 'https://docs.google.com/document/d/AAAAAAAAAAAA/edit',
        text: 'one two three',
        imageCount: 0,
        sourceMarkdown: 'one two three four five six seven eight nine ten',
      },
    ]);
    expect(codes(findings)).toContain('DOC-CONTENT-LOSS');
  });

  it('flags images the Drive importer dropped', () => {
    const findings = auditDocFidelity([
      {
        label: 'training.docs[0].url',
        url: 'https://docs.google.com/document/d/AAAAAAAAAAAA/edit',
        text: 'Step one. Step two.',
        imageCount: 0,
        // `![alt](drive:<id>)` is dropped SILENTLY by Drive's importer.
        sourceMarkdown: 'Step one. ![s1](drive:aaa) Step two. ![s2](drive:bbb)',
      },
    ]);
    const loss = findings.filter((f) => f.code === 'DOC-CONTENT-LOSS');
    expect(loss.some((f) => /2 are missing/.test(f.detail))).toBe(true);
  });

  it('catches the same loss with NO source markdown, from the run\'s own screenshot count', () => {
    // The form this actually shipped in: the guide published with zero images
    // while the run captured 81 PNGs, and every WORD was present, so every
    // content check stayed green.
    const runState = {
      phases: {
        'qa-and-training': {
          products: { training: { docs: { flw_guide: { file_id: 'GUIDEGUIDEGU' }, faq: { file_id: 'FAQFAQFAQFAQ' } } } },
          steps: {
            'app-screenshot-capture': {
              artifact: '6-qa-and-training/app-screenshot-capture_manifest.yaml',
              note: '81 PNGs published (43 Learn / 38 Deliver), zero zero-byte.',
            },
          },
        },
      },
    };
    const docs: DocProbe[] = [
      { label: 'training.docs[0].url', url: 'https://docs.google.com/document/d/GUIDEGUIDEGU/edit', text: 'Step one.', imageCount: 0 },
      { label: 'training.docs[1].url', url: 'https://docs.google.com/document/d/FAQFAQFAQFAQ/edit', text: 'Q and A.', imageCount: 0 },
    ];
    const findings = auditGuideScreenshots(runState, docs);
    // The GUIDE is flagged; the FAQ is legitimately text and is not.
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('DOC-SCREENSHOTS-ABSENT');
    expect(findings[0].detail).toContain('81 screenshots');
    expect(isBlocking(findings[0])).toBe(true);
  });

  it('says nothing when the run captured no screenshots at all', () => {
    expect(auditGuideScreenshots({ phases: { 'qa-and-training': { products: {} } } }, [])).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ace#1838 — GFM table DELIMITERS are not words. `stripMarkdownSyntax`
// handled headings, links, images and emphasis but not tables, so every
// `|` and every `|---|---|` separator counted as a source word while the
// published Google Doc renders a real table with no delimiters at all.
// Past the 5% band that makes auditDocFidelity emit DOC-CONTENT-LOSS —
// MISLEADING tier, share-blocking — against a document that lost nothing.
// Measured on hh-poverty-targeting/20260828-0702: the PDD was reported as
// having dropped 524 of 8183 words; a token diff of source-vs-published
// after normalising pipes away differed by exactly the published export's
// UTF-8 BOM. Every ACE PDD carries tables, so this fired on ~every run.
// ═══════════════════════════════════════════════════════════════════

describe('ace#1838 — table delimiters must not count as source words', () => {
  const TABLE = [
    '# Payment',
    '',
    '| Unit | Amount | When |',
    '|---|---|---|',
    '| Verified survey | 1 USD | per household |',
    '| Daily cap | 25 | per worker |',
    '',
  ].join('\n');

  it('drops pipes and separator rows but keeps every cell word', () => {
    const out = stripMarkdownSyntax(TABLE);
    expect(out).not.toContain('|');
    for (const cell of ['Unit', 'Amount', 'When', 'Verified', 'survey', '1', 'USD', 'household', 'Daily', 'cap', '25', 'worker']) {
      expect(out.split(/\s+/)).toContain(cell);
    }
  });

  it('does not let the separator-row pattern swallow the following line', () => {
    // `[-:|\s]*` with the `m` flag would eat the newline and take the next
    // row with it — the same footgun already recorded on the literal-markdown
    // patterns. The class must be `[ \t]`.
    expect(stripMarkdownSyntax('|---|---|\nSurvivor line')).toContain('Survivor line');
  });

  it('does not fire DOC-CONTENT-LOSS on a table that converted cleanly', () => {
    // What the published Doc actually contains: the same words, no delimiters.
    const published = 'Payment Unit Amount When Verified survey 1 USD per household Daily cap 25 per worker';
    const findings = auditDocFidelity([
      {
        label: 'design.docs[0].url',
        url: 'https://docs.google.com/document/d/AAAAAAAAAAAA/edit',
        text: published,
        imageCount: 0,
        sourceMarkdown: TABLE,
      },
    ]);
    expect(findings.filter((f) => f.code === 'DOC-CONTENT-LOSS')).toEqual([]);
  });

  it('STILL fires when the importer really dropped the table', () => {
    // The check must narrow, never switch off: cell CONTENTS are still counted
    // on the source side, so a dropped table is still caught.
    const findings = auditDocFidelity([
      {
        label: 'design.docs[0].url',
        url: 'https://docs.google.com/document/d/AAAAAAAAAAAA/edit',
        text: 'Payment',
        imageCount: 0,
        sourceMarkdown: TABLE,
      },
    ]);
    expect(findings.map((f) => f.code)).toContain('DOC-CONTENT-LOSS');
  });
});

// ═══════════════════════════════════════════════════════════════════
// ace#1687 — a partial `--doc-source` map must NARROW the check, never
// erase it. Measured live on hh-poverty-targeting/20260824-1404: three
// audits minutes apart, the two with no map listed 6 and 8 unsourced
// documents, and the one carrying a map with ONE entry dropped
// DOC-FIDELITY-UNVERIFIED entirely.
// ═══════════════════════════════════════════════════════════════════

describe('ace#1687 — a partial --doc-source map narrows the check, it does not erase it', () => {
  const DOCS = [
    { label: 'design.docs[0].url', url: 'https://docs.google.com/document/d/PDDPDDPDDPDD/edit' },
    { label: 'design.docs[1].url', url: 'https://docs.google.com/document/d/WORKORDERWOR/edit' },
    { label: 'training.docs[0].url', url: 'https://docs.google.com/document/d/FLWGUIDEFLWG/edit' },
    { label: 'training.docs[1].url', url: 'https://docs.google.com/document/d/LLOGUIDELLOG/edit' },
    { label: 'training.docs[2].url', url: 'https://docs.google.com/document/d/FAQFAQFAQFAQ/edit' },
    { label: 'open_questions.url', url: 'https://docs.google.com/document/d/OPENQUESTION/edit' },
  ];
  const PROSE = 'some published prose here';

  /** Exactly what the CLI does per probed link, with the map it was handed. */
  function unverifiedDocs(map: DocSourceMap | null): string[] {
    const probes: DocProbe[] = DOCS.map((d) => ({
      label: d.label,
      url: d.url,
      text: PROSE,
      imageCount: 0,
      sourceMarkdown: resolveDocSource(map, d.url),
    }));
    const f = auditDocFidelity(probes).filter((x) => x.code === 'DOC-FIDELITY-UNVERIFIED');
    return f.length ? f[0].where.split(', ') : [];
  }

  it('lists every document when no map is supplied at all', () => {
    expect(unverifiedDocs(null)).toEqual(DOCS.map((d) => d.label));
  });

  it('still lists the five absent documents when the map carries one entry', () => {
    // The bug: `docSources[url] ?? null` collapsed "absent" into "the author
    // asserted no source", so ONE entry silenced the other five and the
    // finding vanished from a run that was about to be shared externally.
    const unverified = unverifiedDocs({
      'https://docs.google.com/document/d/OPENQUESTION/edit': `# open questions\n${PROSE}`,
    });
    expect(unverified).not.toEqual([]);
    expect(unverified).toEqual([
      'design.docs[0].url',
      'design.docs[1].url',
      'training.docs[0].url',
      'training.docs[1].url',
      'training.docs[2].url',
    ]);
    // …and the one document that WAS sourced is no longer named.
    expect(unverified).not.toContain('open_questions.url');
  });

  it('stands the check down only for a url given an EXPLICIT null sentinel', () => {
    const unverified = unverifiedDocs({
      'https://docs.google.com/document/d/OPENQUESTION/edit': null,
      'https://docs.google.com/document/d/FAQFAQFAQFAQ/edit': `# faq\n${PROSE}`,
    });
    expect(unverified).toEqual([
      'design.docs[0].url',
      'design.docs[1].url',
      'training.docs[0].url',
      'training.docs[1].url',
    ]);
  });

  it('distinguishes the three states directly', () => {
    const map: DocSourceMap = { 'https://docs.google.com/document/d/AAAAAAAAAAAA/edit': '# a' };
    // no map at all → nothing attempted
    expect(resolveDocSource(null, 'https://docs.google.com/document/d/AAAAAAAAAAAA/edit')).toBeUndefined();
    // absent from a supplied map → nothing attempted FOR THIS URL (not "no source")
    expect(resolveDocSource(map, 'https://docs.google.com/document/d/BBBBBBBBBBBB/edit')).toBeUndefined();
    // present with null → the deliberate "no source exists" sentinel
    expect(resolveDocSource({ 'https://docs.google.com/document/d/BBBBBBBBBBBB/edit': null }, 'https://docs.google.com/document/d/BBBBBBBBBBBB/edit')).toBeNull();
    // present with markdown → verify against it
    expect(resolveDocSource(map, 'https://docs.google.com/document/d/AAAAAAAAAAAA/edit')).toBe('# a');
  });

  it('matches map keys on doc identity, not URL spelling', () => {
    const map: DocSourceMap = { 'https://docs.google.com/document/d/AAAAAAAAAAAA/edit?usp=drivesdk': '# a' };
    expect(resolveDocSource(map, 'https://docs.google.com/document/d/AAAAAAAAAAAA/edit')).toBe('# a');
  });

  it('leaves a document unverified when its map key matches nothing (a typo fails LOUD)', () => {
    expect(unverifiedDocs({ 'https://docs.google.com/document/d/TYPOTYPOTYPO/edit': '# oops' })).toEqual(
      DOCS.map((d) => d.label),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Severity model — the middle tier is where the real damage was.
// ═══════════════════════════════════════════════════════════════════

describe('severity', () => {
  it('blocks on broken AND on misleading, reports improvements', () => {
    const findings: Finding[] = [{ code: 'X', severity: 'improvement', where: 'a', detail: 'd', fix: 'f' }];
    expect(summarise(findings).safeToShare).toBe(true);
    expect(summarise([...findings, { code: 'Y', severity: 'misleading', where: 'b', detail: 'd', fix: 'f' }]).safeToShare).toBe(false);
  });

  it('compares Google Docs on the file id, not the URL spelling', () => {
    expect(canonicalDocUrl('https://docs.google.com/document/d/ABC123ABC123/edit?usp=drivesdk')).toBe(
      canonicalDocUrl('https://docs.google.com/document/d/ABC123ABC123/edit'),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// auditDecisionRows — seeded by the negative-control ratchet
// (test/skills/negative-control-ratchet.test.ts).
//
// This rule shipped with NO test of any kind. It is reached only through
// `auditRunSurface`, whose own tests exercise payloads with `decisions: null`,
// so every branch below had never executed against a decisions payload — the
// rule could not have reported a defect, and nobody would have known.
//
// The inputs are derived from the rule's stated contract (a row must carry
// `phase_raw` AND `phase_label`, and the label must be derivable from the raw
// tag's TAIL rather than from its ordinal — defect 8), not from reading its
// branches back.
// ═══════════════════════════════════════════════════════════════════

describe('auditDecisionRows — provenance per decision (defect 8 / 10)', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'wo-payment-schedule',
    phase: 'solicitation-management',
    phase_raw: '8-solicitation-management',
    phase_label: 'Solicitation Management',
    phase_ordinal: 8,
    skill: 'pdd-to-work-order',
    question: 'What is the payment schedule?',
    ai_default: '40/40/20',
    status: 'ai-default',
    evidence_basis: 'PDD § Budget',
    ...over,
  });

  it('NEGATIVE — flags a label derived from the ORDINAL, which is the whole defect', () => {
    // Re-order the pipeline and an ordinal-derived label publishes a decision
    // under a phase it has nothing to do with. The evidence the auditor can
    // see is that the label shares no word with the tag.
    const findings = auditDecisionRows({ rows: [row({ phase_label: 'Phase 4' })] });
    expect(codes(findings)).toEqual(['DECISION-PHASE-LABEL-DRIFT']);
    expect(findings[0].where).toContain('wo-payment-schedule');
    expect(findings[0].fix).toBeTruthy();
  });

  it('NEGATIVE — flags a row that drops the provenance keys entirely', () => {
    const findings = auditDecisionRows({ rows: [{ id: 'wo-term' }] });
    expect(codes(findings)).toEqual(['CONTRACT-KEY-DRIFT']);
    expect(findings[0].detail).toContain('phase_label');
  });

  it('POSITIVE — a label derived from the tag TAIL is clean', () => {
    expect(auditDecisionRows({ rows: [row()] })).toEqual([]);
  });

  it('POSITIVE — a label that merely ABBREVIATES the tag is still clean', () => {
    // The contract is "derivable from the tag", not "string-equal to it".
    // An over-tight version of this rule would fire on every real label and
    // get loosened until it fired on nothing — which is how a gate becomes
    // vacuous. One legitimate near-miss has to pass.
    expect(auditDecisionRows({ rows: [row({ phase_label: 'Solicitation' })] })).toEqual([]);
    expect(
      auditDecisionRows({ rows: [row({ phase_raw: '6-qa-and-training', phase_label: 'QA and Training' })] }),
    ).toEqual([]);
  });

  it('POSITIVE — is inert on a run that recorded no decisions', () => {
    expect(auditDecisionRows(null)).toEqual([]);
    expect(auditDecisionRows({ rows: [] })).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// auditLinks — POSITIVE control, seeded by the negative-control ratchet.
//
// Every auditLinks test asserted a finding. Nothing asserted that a healthy
// link set produces NONE — so a rule hard-wired to flag would have passed the
// whole suite. That is the always-fires class (ace#1026), and on this surface
// it is expensive in the opposite direction: `summarise().safeToShare` goes
// false, and a run that is genuinely fine cannot be handed to a partner.
// ═══════════════════════════════════════════════════════════════════

describe('auditLinks — a healthy link set must certify clean', () => {
  it('POSITIVE — public-and-open, plus a gated link that SAYS it is gated', () => {
    expect(
      auditLinks([
        probed(),
        probed({
          label: 'apps[0].hq_url',
          url: 'https://www.commcarehq.org/a/dom/apps/view/x/',
          declaredAccess: 'admin',
          cls: 'MEMBER-GATED',
          status: 302,
        }),
      ]),
    ).toEqual([]);
  });

  it('POSITIVE — REACHABLE, not just OK, honours a `public` tag', () => {
    // The contract is what an outsider experiences: the link opens. A rule
    // that accepted only the `OK` classification would flag an honest public
    // link and get relaxed until it flagged nothing.
    expect(auditLinks([probed({ declaredAccess: 'public', cls: 'REACHABLE', status: 200 })])).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// The two MISLEADING findings from the anonymous audit of
// spark-facilitator/20260828-0703 that were invisible to every check
// here, because the page simply said NOTHING (ace#1867, ace-web#744).
// Silence about provenance is not neutrality — it is an assertion.
// ═══════════════════════════════════════════════════════════════════

const SYNTHETIC_PHASES = {
  'synthetic-data-and-workflows': {
    products: {
      synthetic: {
        source: {
          provider: 'ace-run',
          labs_synthetic_opp_id: 10054,
          record_counts: { user_visits: 223, user_data: 12, completed_works: 0 },
        },
      },
    },
  },
};

describe('generated data must be labelled as generated', () => {
  it('BLOCKS when the run generated a dataset and the page does not say so', () => {
    const findings = auditSyntheticLabelling({ synthetic: null }, SYNTHETIC_PHASES);
    expect(codes(findings)).toContain('SYNTHETIC-UNLABELLED');
    expect(findings.every(isBlocking)).toBe(true);
    // The count is named, so the finding is arguable rather than assertive.
    expect(findings[0].detail).toContain('223');
  });

  it('is silent once the page carries the label', () => {
    const findings = auditSyntheticLabelling(
      { synthetic: { is_synthetic: true, visits: 223 } },
      SYNTHETIC_PHASES,
    );
    expect(findings).toEqual([]);
  });

  it('does not label a run that generated nothing', () => {
    // The same lie pointed the other way. No synthetic block, no finding.
    expect(auditSyntheticLabelling({ synthetic: null }, {})).toEqual([]);
  });
});

describe('a partial build must not render as a clean one', () => {
  const partial = {
    'commcare-setup': {
      status: 'partial',
      verdict: 'partial-deliver-eval-blocked-on-phase1-gap',
      steps: {
        'pdd-to-learn-app': { verdict: 'pass' },
        'pdd-to-deliver-app-eval': { verdict: 'fail' },
      },
    },
  };

  it('BLOCKS when Phase 3 is partial and the page carries no build block', () => {
    const findings = auditBuildStatusParity({ build: null }, partial);
    expect(codes(findings)).toContain('BUILD-STATUS-HIDDEN');
    expect(findings.every(isBlocking)).toBe(true);
    expect(findings[0].detail).toContain('pdd-to-deliver-app-eval');
  });

  it('is silent once the page carries the build block', () => {
    const findings = auditBuildStatusParity(
      { build: { status: 'partial', failing_checks: [] } },
      partial,
    );
    expect(findings).toEqual([]);
  });

  it('BLOCKS on a failing STEP even when the phase calls itself done', () => {
    // The phase status is written by the phase about itself; a failed hard
    // gate is not something it gets to round up.
    const findings = auditBuildStatusParity({ build: null }, {
      'commcare-setup': { status: 'done', steps: { 'x-eval': { verdict: 'fail' } } },
    });
    expect(codes(findings)).toContain('BUILD-STATUS-HIDDEN');
  });

  it('says nothing about a genuinely clean phase', () => {
    expect(auditBuildStatusParity({ build: null }, {
      'commcare-setup': { status: 'done', verdict: 'pass', steps: { a: { verdict: 'pass' } } },
    })).toEqual([]);
    expect(auditBuildStatusParity({ build: null }, {})).toEqual([]);
  });
});


// ═══════════════════════════════════════════════════════════════════
// The deep-QA gate (ace-web#746). The third parity check, and the one
// whose evidence is NOT in run_state.yaml: `/ace:qa-deep` deliberately
// writes no pointer there, so the two verdict FILES in the run folder
// are the only record it ran. A check modelled on its two siblings would
// read `phases`, find nothing, and stay silent forever.
// ═══════════════════════════════════════════════════════════════════

const DEEP_FILES = [
  'run_state.yaml',
  'decisions.yaml',
  '5-ocs/ocs-chatbot-eval_verdict-deep.yaml',
  '6-qa-and-training/app-ux-eval_verdict-deep.yaml',
];

/** Stage A of spark-facilitator/20260828-0703 — 8.03, gate `iterate`. */
function deepStage(over: Record<string, unknown> = {}) {
  return {
    stage: 'assistant',
    label: 'Support assistant',
    ran: true,
    gate: 'iterate',
    score: 8.03,
    threshold: 7.0,
    counts: { total: 68, pass: 58, warn: 8, fail: 2 },
    ...over,
  };
}

describe('a deep gate that ran must not render as one that did not', () => {
  it('BLOCKS when no run-folder listing was supplied', () => {
    const findings = auditDeepQaParity(healthyPayload(), null);
    expect(codes(findings)).toContain('DEEP-QA-UNVERIFIED');
    expect(findings.every(isBlocking)).toBe(true);
    // Names why the usual evidence source cannot answer it.
    expect(findings[0].detail).toContain('run_state.yaml');
  });

  it('BLOCKS when the run holds deep verdicts and the page has no section', () => {
    const findings = auditDeepQaParity(healthyPayload(), DEEP_FILES);
    expect(codes(findings)).toContain('DEEP-QA-HIDDEN');
    expect(findings.every(isBlocking)).toBe(true);
    // The finding names its own evidence, so it is arguable rather than
    // assertive — the same bar the ace#1876 pair set.
    expect(findings[0].detail).toContain('ocs-chatbot-eval_verdict-deep.yaml');
  });

  it('BLOCKS when a stage that ran is reported as not run', () => {
    const findings = auditDeepQaParity(
      healthyPayload({
        deep_qa: {
          stages: [
            deepStage(),
            { stage: 'apps', ran: false, gate: null, score: null },
          ],
        },
      }),
      DEEP_FILES,
    );
    expect(codes(findings)).toEqual(['DEEP-QA-HIDDEN']);
    expect(findings[0].where).toBe('deep_qa.stages[stage=apps]');
  });

  it('BLOCKS a score carried with no gate — the defect the section exists for', () => {
    // 8.03 clears the 7.0 bar and the gate is `iterate` anyway, because
    // --deep requires zero Fails and two answers fabricated
    // safety-adjacent procedure. A bare number reads as a pass.
    const findings = auditDeepQaParity(
      healthyPayload({
        deep_qa: {
          stages: [
            deepStage({ gate: null }),
            { stage: 'apps', ran: true, gate: 'reject', score: 5.7 },
          ],
        },
      }),
      DEEP_FILES,
    );
    expect(codes(findings)).toEqual(['DEEP-QA-SCORE-WITHOUT-GATE']);
    expect(findings[0].detail).toContain('8.03');
  });

  it('is silent once the page carries both stages with their gates', () => {
    const findings = auditDeepQaParity(
      healthyPayload({
        deep_qa: {
          stages: [
            deepStage(),
            { stage: 'apps', ran: true, gate: 'reject', score: 5.7 },
          ],
        },
      }),
      DEEP_FILES,
    );
    expect(findings).toEqual([]);
  });

  it('says nothing about a run that never took the deep gate', () => {
    // The same lie pointed the other way. No verdict files, no finding —
    // and a page that stays silent is then correct.
    expect(
      auditDeepQaParity(healthyPayload(), ['run_state.yaml', 'decisions.yaml']),
    ).toEqual([]);
    expect(auditDeepQaParity(healthyPayload(), [])).toEqual([]);
  });

  it('reads only ONE stage as run when only one verdict exists', () => {
    // `/ace:qa-deep --ocs-only` is a supported invocation, so a page
    // reporting the app stage as not-run is CORRECT here — and must not
    // be flagged.
    const findings = auditDeepQaParity(
      healthyPayload({
        deep_qa: {
          stages: [
            deepStage(),
            { stage: 'apps', ran: false, gate: null, score: null },
          ],
        },
      }),
      ['5-ocs/ocs-chatbot-eval_verdict-deep.yaml'],
    );
    expect(findings).toEqual([]);
  });

  it('is actually WIRED into the audit script, not just written', () => {
    // The cheap guard against a correct function nobody calls. Unlike
    // its two siblings, this one is not reachable through
    // `auditCompleteness` — that early-returns when --run-state is
    // absent, which would swallow a deep-QA finding --run-files could
    // still have proved — so the wiring is one push in the script, and
    // this is what holds it there.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const script = readFileSync(
      path.join(here, '../../scripts/audit-run-surface.ts'),
      'utf8',
    );
    expect(script).toContain('auditDeepQaParity');
    expect(script).toContain("case '--run-files':");
    expect(script).toMatch(/findings\.push\(\.\.\.auditDeepQaParity\(/);
  });

  it('knows the deep_qa section, so it is not reported as unaudited', () => {
    // The other half of the contract change: without the SURFACE_CONTRACT
    // entry, every payload carrying the new section trips
    // CONTRACT-UNKNOWN-SECTION instead.
    const findings = auditContract(healthyPayload({ deep_qa: { stages: [] } }));
    expect(codes(findings)).not.toContain('CONTRACT-UNKNOWN-SECTION');
    expect(codes(findings)).not.toContain('CONTRACT-MISSING-SECTION');
  });
});

// ═══════════════════════════════════════════════════════════════════
// auditDecisionRows — archetype contradiction across rows (ace#1859).
//
// `bednet-check-2-visit/20260828-0629` published TWO archetypes for one run
// on the anonymous Decisions tab: Phase 1 said `longitudinal-visits`, Phase 3
// said `atomic-visit` with `evidence_basis: stated`, citing a document whose
// line 7 reads `Archetype: longitudinal-visits`. `grep -n "atomic-visit"
// run_state.yaml` returned nothing — the run's own record never contained the
// string. Every structural check (classify_phase_writeback,
// verify_phase_artifacts, verify_phase_products) was green.
//
// This is the `misleading` tier the module's header calls out: nothing was
// unreachable, the page just said something untrue about what kind of
// programme this is. It blocks sharing, which is the whole point — the damage
// was that an outsider read it.
// ═══════════════════════════════════════════════════════════════════

describe('auditDecisionRows — archetype contradiction (ace#1859)', () => {
  const arch = (over: Record<string, unknown> = {}) => ({
    id: 'archetype-selection',
    phase: 'design',
    phase_raw: '1-design',
    phase_label: 'Design',
    phase_ordinal: 1,
    skill: 'idea-to-pdd',
    question: 'Which delivery archetype best fits the intervention?',
    ai_default: 'longitudinal-visits',
    status: 'ai-default',
    evidence_basis: 'stated',
    ...over,
  });

  const coverage = (over: Record<string, unknown> = {}) => ({
    id: 'test-archetype-coverage',
    phase: 'commcare',
    phase_raw: '3-commcare',
    phase_label: 'CommCare',
    phase_ordinal: 3,
    skill: 'app-test-cases',
    question: 'Is every archetype covered by a smoke?',
    ai_default: 'longitudinal-visits covered by both smokes',
    status: 'ai-default',
    evidence_basis: 'stated',
    ...over,
  });

  it('NEGATIVE — flags the real ace#1859 row and blocks the share gate', () => {
    const findings = auditDecisionRows({
      rows: [arch(), coverage({ ai_default: 'atomic-visit covered by both smokes' })],
    });
    expect(codes(findings)).toEqual(['DECISION-ARCHETYPE-CONTRADICTION']);
    expect(findings[0].severity).toBe('misleading');
    expect(isBlocking(findings[0])).toBe(true);
    expect(findings[0].where).toContain('test-archetype-coverage');
    expect(findings[0].detail).toContain('atomic-visit');
    expect(findings[0].detail).toContain('longitudinal-visits');
    expect(findings[0].fix).toBeTruthy();
  });

  it('NEGATIVE — flags it whichever row is the odd one out', () => {
    // The rule keys off the run's OWN archetype-selection row, so an
    // atomic-visit run with a stray longitudinal-visits row is caught too —
    // it is not hard-wired to one archetype.
    const findings = auditDecisionRows({
      rows: [arch({ ai_default: 'atomic-visit' }), coverage()],
    });
    expect(codes(findings)).toEqual(['DECISION-ARCHETYPE-CONTRADICTION']);
    expect(findings[0].detail).toContain('atomic-visit');
  });

  it('POSITIVE — the corrected row is clean', () => {
    expect(auditDecisionRows({ rows: [arch(), coverage()] })).toEqual([]);
  });

  it('POSITIVE — the declaring row alone is clean (its options ARE the vocabulary)', () => {
    expect(auditDecisionRows({ rows: [arch()] })).toEqual([]);
  });

  it('POSITIVE — inert on a run that declared no archetype', () => {
    // Most runs' summary payloads carry decisions long before Phase 1's row
    // exists. Inventing a ground truth here would flag every row on the page.
    expect(
      auditDecisionRows({ rows: [coverage({ ai_default: 'atomic-visit covered by both smokes' })] }),
    ).toEqual([]);
  });

  it('POSITIVE — a row that declares evidence_basis: conflicting is exempt', () => {
    expect(
      auditDecisionRows({
        rows: [
          arch(),
          coverage({ ai_default: 'multi-stage covered by both smokes', evidence_basis: 'conflicting' }),
        ],
      }),
    ).toEqual([]);
  });

  it('does not mask the provenance rules it sits beside', () => {
    // A row can be BOTH mislabelled by ordinal and naming the wrong archetype;
    // reporting only one of them would hide work from the reviewer.
    const findings = auditDecisionRows({
      rows: [
        arch(),
        coverage({ ai_default: 'atomic-visit covered by both smokes', phase_label: 'Phase 3' }),
      ],
    });
    expect(codes(findings).sort()).toEqual(
      ['DECISION-ARCHETYPE-CONTRADICTION', 'DECISION-PHASE-LABEL-DRIFT'].sort(),
    );
  });
});

// The rule reached DIRECTLY, not only through `auditDecisionRows`. The
// negative-control ratchet (test/skills/negative-control-ratchet.test.ts)
// requires every check surface to have both controls exercised on the surface
// itself — reaching it only through a caller is how a check ends up never
// having run against the input it exists to reject.
describe('auditArchetypeContradiction — direct controls', () => {
  const declaringRow = { id: 'archetype-selection', ai_default: 'longitudinal-visits' };

  it('NEGATIVE — the real ace#1859 pair produces a blocking finding', () => {
    const findings = auditArchetypeContradiction([
      declaringRow,
      { id: 'test-archetype-coverage', ai_default: 'atomic-visit covered by both smokes' },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('DECISION-ARCHETYPE-CONTRADICTION');
    expect(isBlocking(findings[0])).toBe(true);
  });

  it('NEGATIVE — reads params.archetype when the payload carries it', () => {
    const findings = auditArchetypeContradiction([
      declaringRow,
      {
        id: 'test-archetype-coverage',
        ai_default: 'covered by both smokes',
        params: { archetype: 'atomic-visit' },
      },
    ]);
    expect(findings.map((f) => f.where)).toEqual([
      'decisions.rows (test-archetype-coverage).params.archetype',
    ]);
  });

  it('NEGATIVE — an OVERRIDE to the wrong archetype is what gets checked', () => {
    const findings = auditArchetypeContradiction([
      declaringRow,
      { id: 'r', ai_default: 'longitudinal-visits', override: 'focus-group' },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('focus-group');
  });

  it('POSITIVE — a clean, agreeing set of rows produces nothing', () => {
    expect(
      auditArchetypeContradiction([
        declaringRow,
        { id: 'test-archetype-coverage', ai_default: 'longitudinal-visits covered by both smokes' },
        { id: 'payment-unit-count', ai_default: 'one payment unit' },
      ]),
    ).toEqual([]);
  });

  it('POSITIVE — an override BACK to the declared archetype clears the row', () => {
    expect(
      auditArchetypeContradiction([
        declaringRow,
        { id: 'r', ai_default: 'atomic-visit', override: 'longitudinal-visits' },
      ]),
    ).toEqual([]);
  });

  it('POSITIVE — tolerates junk rows without throwing', () => {
    expect(auditArchetypeContradiction([null, 'nope', {}, { id: 42 }])).toEqual([]);
    expect(auditArchetypeContradiction([])).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ace#1868 — a 200 whose BODY is a gate.
//
// `classifyLink` read the status line and the final URL after redirects, so
// two whole shapes of "answered, then walled you" scored `OK`:
//
//   1. A CLIENT-SIDE gate. ace-web answers 200 at the requested URL and
//      renders the sign-in prompt in the browser. Observed anonymously
//      2026-09-06 on hh-poverty-targeting/20260828-0702's workbench link:
//        curl  -> 200, no redirect, 443 bytes, visible text "ACE Web"
//        audit -> {"cls": "OK"}
//        render-> final /ace/auth/login/?next=…, text "ace-web Sign in with
//                 your Connect account to continue. Sign in with Connect"
//   2. An INTERSTITIAL. Drive answers 200 with HTML where a file was asked
//      for. Observed the same day on ace#1831's forensics uploads:
//        journey-deliver-FAILURE.xml -> 200, content-type text/html,
//        <title>Google Drive - Virus scan warning</title>
//
// Every string in these tests is a transcript, not a construction.
// ═══════════════════════════════════════════════════════════════════

/** Verbatim: the anonymous render of the workbench link, 2026-09-06. */
const ACE_WEB_GATE_TEXT = 'ace-web Sign in with your Connect account to continue. Sign in with Connect';
const ACE_WEB_GATE_URL =
  'https://labs.connect.dimagi.com/ace/auth/login/?next=%2Face%2Fw%2Fdimagi-team%2Fopps%2Fhh-poverty-targeting%2Fruns%2F20260828-0702';
const WORKBENCH_URL = 'https://labs.connect.dimagi.com/ace/w/dimagi-team/opps/hh-poverty-targeting/runs/20260828-0702';
/** Verbatim: the 443-byte SPA shell the same URL serves to a plain fetch. */
const ACE_WEB_SHELL = '<!doctype html><html><head><title>ACE Web</title></head><body><div id="root"></div></body></html>';

/** Verbatim: Drive's virus-scan interstitial, ace#1831's journey-deliver-FAILURE.xml. */
const DRIVE_SCAN_HTML =
  '<!DOCTYPE html><html><head><title>Google Drive - Virus scan warning</title></head><body>' +
  "<p>Google Drive can't scan this file for viruses.</p>" +
  '<p>This file is executable and may harm your computer.</p>journey-deliver-FAILURE.xml (19k)</body></html>';
const DRIVE_DOWNLOAD_URL = 'https://drive.google.com/uc?export=download&id=1j2IOdN8yo9F0CHvFj7SifA7NY2mBwydo';

describe('ace#1868 — a client-side sign-in wall must not score OK', () => {
  it('REGRESSION — the exact call the auditor made on 20260828-0702 still says OK without body evidence', () => {
    // This is the defect, pinned. The three-argument call has no way to know,
    // and that is the point: the fix is that the caller now COLLECTS evidence,
    // not that a URL test got cleverer.
    expect(classifyLink(WORKBENCH_URL, 200, WORKBENCH_URL).cls).toBe('OK');
  });

  it('BLOCKS — rendered text that is nothing but a sign-in shell', () => {
    const { cls, note } = classifyLink(WORKBENCH_URL, 200, WORKBENCH_URL, {
      renderedText: ACE_WEB_GATE_TEXT,
      renderedFinalUrl: WORKBENCH_URL,
    });
    expect(cls).toBe('SPA-GATED');
    expect(note).toContain('Sign in with your Connect account');
  });

  it('BLOCKS — the browser navigated ITSELF to a login route', () => {
    // Decisive on its own: no text pattern involved, so a copy change on the
    // gate cannot make this stop firing.
    expect(
      classifyLink(WORKBENCH_URL, 200, WORKBENCH_URL, {
        renderedText: 'anything at all',
        renderedFinalUrl: ACE_WEB_GATE_URL,
      }).cls,
    ).toBe('SPA-GATED');
  });

  it('POSITIVE — the raw SPA shell alone is NOT enough to condemn a link', () => {
    // The shell says nothing either way, and an auditor that guessed from it
    // would flag every SPA route on the deployment. Silence stays silence.
    expect(
      classifyLink(WORKBENCH_URL, 200, WORKBENCH_URL, {
        contentType: 'text/html; charset=utf-8',
        body: ACE_WEB_SHELL,
      }).cls,
    ).toBe('OK');
  });

  it('POSITIVE — a real page that merely CONTAINS a sign-in affordance stays OK', () => {
    // The summary page itself, rendered anonymously: thousands of characters
    // of content. A length-free text rule would have flagged it, and a false
    // positive is the same failure as a false negative.
    const realPage = `Household Poverty Targeting Survey run 20260828-0702 In progress. ${'Frontline workers visit every household and administer the PPI scorecard verbatim. '.repeat(
      8,
    )} Sign in with Connect`;
    expect(realPage.length).toBeGreaterThan(GATE_TEXT_MAX_CHARS);
    expect(classifyLink(WORKBENCH_URL, 200, WORKBENCH_URL, { renderedText: realPage }).cls).toBe('OK');
  });

  it('a SPA-GATED link tagged `public` is the page telling the reader something untrue', () => {
    const findings = auditLinks([
      probed({ label: 'workbench.url', url: WORKBENCH_URL, declaredAccess: 'public', cls: 'SPA-GATED', status: 200 }),
    ]);
    expect(codes(findings)).toContain('LINK-ACCESS-MISLABELLED');
  });

  it('a SPA-GATED link tagged `admin` is HONEST — no finding', () => {
    // The live case: the payload tags the workbench link `admin`, so the page
    // is telling the truth and the reader is not misled. What changes is the
    // COUNT LINE — it reads SPA-GATED, not OK.
    expect(
      auditLinks([
        probed({ label: 'workbench.url', url: WORKBENCH_URL, declaredAccess: 'admin', cls: 'SPA-GATED', status: 200 }),
      ]),
    ).toEqual([]);
  });
});

describe('ace#1868 — a download that answers with a web page (the ace#1831 corpus)', () => {
  it('BLOCKS — Drive virus-scan interstitial on a file-download URL', () => {
    const { cls, note } = classifyLink(DRIVE_DOWNLOAD_URL, 200, DRIVE_DOWNLOAD_URL, {
      contentType: 'text/html; charset=utf-8',
      body: DRIVE_SCAN_HTML,
    });
    expect(cls).toBe('INTERSTITIAL');
    expect(note).toContain('Google Drive - Virus scan warning');
  });

  it('the interstitial is caught STRUCTURALLY — no pattern for this page is needed', () => {
    // The rule is "a file-download URL answered text/html", so an interstitial
    // nobody has seen yet is caught the same way. This body matches none of
    // SIGNIN_TEXT and carries no recognisable title.
    expect(
      classifyLink(DRIVE_DOWNLOAD_URL, 200, DRIVE_DOWNLOAD_URL, {
        contentType: 'text/html',
        body: '<html><body>Something Drive has not shipped yet</body></html>',
      }).cls,
    ).toBe('INTERSTITIAL');
  });

  it('POSITIVE — the same URL serving actual bytes stays OK', () => {
    // journey-learn.mp4, verified public and 32 MB of ftypisom the same day.
    expect(
      classifyLink('https://drive.google.com/uc?export=download&id=1nmQtzxTdJ0rtH-40wpKaDtRbcFQkrMXU', 200, '', {
        contentType: 'video/mp4',
        body: null,
      }).cls,
    ).toBe('OK');
  });

  it('POSITIVE — an HTML page that is SUPPOSED to be a page is not an interstitial', () => {
    // A Google Doc is a web page; serving HTML is correct there. The rule is
    // scoped to URL forms that promise the file's bytes.
    expect(isFileDownloadUrl('https://docs.google.com/document/d/AAAAAAAAAAAA/edit')).toBe(false);
    expect(
      classifyLink('https://docs.google.com/document/d/AAAAAAAAAAAA/edit', 200, '', {
        contentType: 'text/html; charset=utf-8',
        body: '<html><body>A perfectly ordinary published document</body></html>',
      }).cls,
    ).toBe('OK');
  });

  it('an INTERSTITIAL is broken whatever the access tag says', () => {
    // The tag governs WHO may open a link. This one opens for everybody and
    // hands them the wrong thing, so both tags are equally broken.
    for (const access of ['public', 'admin', null]) {
      const findings = auditLinks([
        probed({ label: 'videos[0].url', url: DRIVE_DOWNLOAD_URL, declaredAccess: access, cls: 'INTERSTITIAL', status: 200 }),
      ]);
      expect(codes(findings)).toContain('LINK-INTERSTITIAL');
      expect(findings.filter((f) => f.code === 'LINK-INTERSTITIAL').every(isBlocking)).toBe(true);
    }
  });
});

describe('ace#1868 — the render pass is bounded, and silence never upgrades a link', () => {
  const page = 'https://labs.connect.dimagi.com/ace/opps/dimagi-team/hh-poverty-targeting/runs/20260828-0702/summary';

  it('candidates are same-origin AND currently passing — nothing else', () => {
    const links = [
      probed({ label: 'workbench.url', url: WORKBENCH_URL, cls: 'OK' }),
      // cross-origin: a browser here buys nothing and Google throttles
      probed({ label: 'design.docs[0].url', cls: 'OK' }),
      // same-origin but already known gated: nothing left to learn
      probed({ label: 'solicitation.url', url: 'https://labs.connect.dimagi.com/solicitations/17609/', cls: 'AUTH-GATED' }),
      probed({ label: 'dashboards[0].url', url: 'https://labs.connect.dimagi.com/labs/workflow/5321/run/', cls: 'AUTH-GATED' }),
    ];
    expect(sameOriginGateCandidates(links, page)).toEqual([WORKBENCH_URL]);
  });

  it('a link with NO gate probe is left exactly as it was', () => {
    const links = [probed({ label: 'workbench.url', url: WORKBENCH_URL, cls: 'OK' })];
    expect(applyRenderedGates(links, [])).toEqual(links);
    expect(applyRenderedGates(links, undefined)).toEqual(links);
    // a probe for a DIFFERENT url must not touch this one
    expect(
      applyRenderedGates(links, [{ url: 'https://labs.connect.dimagi.com/ace/other', status: 200, finalUrl: ACE_WEB_GATE_URL, text: ACE_WEB_GATE_TEXT }])[0]
        .cls,
    ).toBe('OK');
  });

  it('END-TO-END — the live 20260828-0702 evidence turns the workbench link SPA-GATED', () => {
    const links = [
      probed({ label: 'workbench.url', url: WORKBENCH_URL, declaredAccess: 'admin', cls: 'OK', status: 200 }),
      probed({ label: 'design.docs[0].url', cls: 'OK' }),
    ];
    const upgraded = applyRenderedGates(links, [
      { url: WORKBENCH_URL, status: 200, finalUrl: ACE_WEB_GATE_URL, text: ACE_WEB_GATE_TEXT },
    ]);
    expect(upgraded.map((l) => l.cls)).toEqual(['SPA-GATED', 'OK']);
  });

  it('a render that found the page perfectly fine may not OVERTURN a harder truth', () => {
    // Only ever tightens. A 401 the static probe already saw stands.
    const gated = probed({ url: WORKBENCH_URL, cls: 'PRIVATE-DELIVERABLE', status: 401 });
    expect(
      applyRenderedGates([gated], [{ url: WORKBENCH_URL, status: 200, finalUrl: WORKBENCH_URL, text: 'a lovely page' }])[0].cls,
    ).toBe('PRIVATE-DELIVERABLE');
  });
});

// ═══════════════════════════════════════════════════════════════════
// ace#1839 — the page invites the reader to ask questions and offers
// only a link they cannot open.
//
// Rendered anonymously, hh-poverty-targeting/20260828-0702 reads
// "SUPPORT ASSISTANT / Ask questions about this opportunity … /
// View in OCS  ADMIN ONLY", and that link answers (2026-09-06):
//
//   $ curl -sIL https://www.openchatstudio.com/a/connect-ace/chatbots/13029/
//   200 -> https://www.openchatstudio.com/accounts/login/?next=/a/connect-ace/chatbots/13029/
//
// while the run's own anonymous chat surface answers 200 with a live
// chat page (11,755 bytes, cookie jar carried through the 302).
//
// Nothing caught it: auditCompleteness keys on section PRESENCE and the
// section is present; auditLinks checks a link against its own access
// tag and `admin` is honest for a console. Every check was right and
// none was looking at the gap between the invitation and the affordance.
// ═══════════════════════════════════════════════════════════════════

/** Verbatim: the `assistant` block the live endpoint served on 2026-09-06. */
const LIVE_ASSISTANT = {
  ocs_url: 'https://www.openchatstudio.com/a/connect-ace/chatbots/13029/',
  access: 'admin',
  public_id: '2c8d5f93-8e4f-4fde-9bf8-650909255c30',
  embed_key: 'BeEwldQML9Frnm43n8nR65KBt6BhsZMM',
  knowledge_sources: ['the program design document'],
};
/** Verified 200 with a live chat page the same day. */
const LIVE_PUBLIC_CHAT_URL =
  'https://www.openchatstudio.com/a/connect-ace/chatbots/2c8d5f93-8e4f-4fde-9bf8-650909255c30/start/';

describe('ace#1839 — an admin-only link under a public-sounding invitation', () => {
  it('BLOCKS on the live payload, and names the URL the run already holds', () => {
    const findings = auditAssistantAccess({ assistant: LIVE_ASSISTANT });
    expect(codes(findings)).toEqual(['ASSISTANT-PUBLIC-URL-WITHHELD']);
    expect(findings.every(isBlocking)).toBe(true);
    expect(findings[0].detail).toContain(LIVE_PUBLIC_CHAT_URL);
  });

  it('the public URL is DERIVED from what the page already serves anonymously', () => {
    // Nothing is acquired: `public_id` is on the payload and the team slug is
    // in the admin URL's own path. That is the whole point — this is
    // surfacing a value the run holds, not obtaining a new one.
    expect(derivePublicChatUrl(LIVE_ASSISTANT)).toBe(LIVE_PUBLIC_CHAT_URL);
  });

  it('the finding leaves the exposure decision to the operator', () => {
    // Whether an un-authed reader may drive LLM spend is a real product call
    // and this check does not make it. Both remedies must be on the page.
    const fix = auditAssistantAccess({ assistant: LIVE_ASSISTANT })[0].fix;
    expect(fix).toMatch(/PRODUCT call/);
    expect(fix).toMatch(/change the copy/);
    expect(fix).toMatch(/access: public/);
  });

  it('SELF-RETIRING — a payload that carries the public route produces nothing', () => {
    expect(
      auditAssistantAccess({
        assistant: { ...LIVE_ASSISTANT, public_url: LIVE_PUBLIC_CHAT_URL },
      }),
    ).toEqual([]);
    // …including when the console link is still there and still tagged admin,
    // which is the shape the issue actually proposes.
    expect(
      auditAssistantAccess({
        assistant: { ...LIVE_ASSISTANT, chat_url: LIVE_PUBLIC_CHAT_URL, access: 'admin' },
      }),
    ).toEqual([]);
  });

  it('BLOCKS with a different reason when no public URL is derivable at all', () => {
    // Then the reader has no way to accept the invitation, and the only
    // remedy is the copy. The finding must not go quiet.
    const findings = auditAssistantAccess({
      assistant: { ocs_url: LIVE_ASSISTANT.ocs_url, access: 'admin' },
    });
    expect(codes(findings)).toEqual(['ASSISTANT-PUBLIC-URL-WITHHELD']);
    expect(findings[0].detail).toContain('no anonymous chat URL is derivable');
  });

  it('POSITIVE — an absent or not-yet-reached assistant is not this finding', () => {
    // "The run has not got there yet" is auditCompleteness's question, and a
    // check that answered it here would fire on every early run.
    expect(auditAssistantAccess({ assistant: null })).toEqual([]);
    expect(auditAssistantAccess({})).toEqual([]);
    expect(auditAssistantAccess(null)).toEqual([]);
    expect(auditAssistantAccess({ assistant: { public_id: 'p' } })).toEqual([]); // no link offered
  });

  it('POSITIVE — a link the page does NOT call admin-only is not this finding', () => {
    expect(auditAssistantAccess({ assistant: { ...LIVE_ASSISTANT, access: 'public' } })).toEqual([]);
  });

  it('derivePublicChatUrl refuses to guess rather than returning a wrong URL', () => {
    expect(derivePublicChatUrl({ public_id: 'p' })).toBeNull(); // no admin url → no team slug
    expect(derivePublicChatUrl({ ocs_url: LIVE_ASSISTANT.ocs_url })).toBeNull(); // no public_id
    expect(derivePublicChatUrl({ ocs_url: 'https://www.openchatstudio.com/chatbots/13029/', public_id: 'p' })).toBeNull();
    expect(derivePublicChatUrl({ ocs_url: 'not a url', public_id: 'p' })).toBeNull();
    expect(derivePublicChatUrl(null)).toBeNull();
  });

  it('a non-production OCS host is honoured, not overwritten with the default', () => {
    expect(
      derivePublicChatUrl({ ocs_url: 'https://ocs.example.org/a/t/chatbots/1/', public_id: 'pid' }),
    ).toBe('https://ocs.example.org/a/t/chatbots/pid/start/');
  });
});
