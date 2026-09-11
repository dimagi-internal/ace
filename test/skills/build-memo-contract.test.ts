/**
 * The run's build memo is DECLARED, COMPOSED from named producer sections, and
 * GATED at the Phase 4 boundary (dimagi-internal/ace#2371).
 *
 * ## The defect this guards
 *
 * Every poverty-graduation PDD names a build memo as a compilation target, and
 * Targeting PDD §11 [FIXED] calls it *the review artifact*: "humans review the
 * memo and spot-check the apps, rather than reviewing every screen." ACE's
 * skills wrote to "the build memo" 76 times across 8 files, and no run ever
 * delivered one:
 *
 *   - the Deliver half existed only as an unnamed section inside
 *     `pdd-to-deliver-app_summary.md`, never linked to a reviewer;
 *   - the Learn half (`pdd-to-learn-app_build-memo.md`) was named in the
 *     skill's Products list but no step wrote it, so it was composed inside the
 *     build's context and lost (`poverty-graduation/20260905-1345` and its fork
 *     `20260908-0510`);
 *   - Phase 4 — opportunity configuration and verification flags — wrote no
 *     memo content at all, so where a PDD verification rule was actually
 *     applied was recorded nowhere a reviewer would look.
 *
 * The design author reviewed every screen as a result.
 *
 * ## What this pins
 *
 * 1. The manifest declares the programme memo, REQUIRED, in the `connect`
 *    phase, and the boundary fence's own function
 *    (`computeExpectedRequiredArtifacts` / `diffArtifacts`, which
 *    `verify_phase_artifacts` wraps) reports it missing with a healable
 *    producer. A prose-only requirement is how #892 regressed as #2174.
 * 2. Each producer names the section the composer reads, and the Learn skill
 *    has an actual WRITE step for its memo — the missing step is the defect.
 * 3. Phase 4's section treats "Not configurable on Connect" as a required
 *    statement, never an omission.
 * 4. The phase agent dispatches the composer after the step whose section it
 *    reads, and its self-check counts the memo.
 * 5. The review surfaces carry the link: the typed `products.connect.build_memo`
 *    handoff (what ace-web's summary reads), the orchestrator close-out, and the
 *    pause-time summary.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ARTIFACT_MANIFEST } from '../../lib/artifact-manifest.js';
import { computeExpectedRequiredArtifacts, diffArtifacts } from '../../lib/phase-closeout.js';
import { PHASE_PRODUCTS_SCHEMAS, productProducer } from '../../lib/phase-products-schema.js';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const MEMO = '4-connect/build-memo.md';
const LEARN_MEMO = '3-commcare/pdd-to-learn-app_build-memo.md';
const DELIVER_SUMMARY = '3-commcare/pdd-to-deliver-app_summary.md';
const OPP_SETUP = '4-connect/connect-opp-setup.md';
const PHASE4_HEADING = '## Build memo — opportunity configuration and verification';

/** A numbered step of a SKILL.md, from its marker to the next top-level step. */
function step(doc: string, marker: string, nextMarker: string): string {
  const start = doc.indexOf(marker);
  const end = doc.indexOf(nextMarker, start + marker.length);
  if (start < 0 || end < 0) return '';
  return doc.slice(start, end);
}

describe('the manifest declares the programme memo (ace#2371)', () => {
  const entry = ARTIFACT_MANIFEST.find((a) => a.path === MEMO);

  it('declares 4-connect/build-memo.md, produced by build-memo, in the connect phase', () => {
    expect(entry, `no manifest entry for ${MEMO}`).toBeDefined();
    expect(entry!.producedBy).toBe('build-memo');
    expect(entry!.phase).toBe('connect');
  });

  it('is REQUIRED — a conditional requirement needs a detector, and a missed detection is the silent pass', () => {
    expect(entry!.required).toBe(true);
    expect(entry!.notRequiredInModes ?? []).toEqual([]);
  });

  it('is a reviewable document: rendered, shared as commenter, source persisted', () => {
    expect(entry!.rendered).toBe(true);
    expect(entry!.recipientFacing).toBe(true);
    expect(entry!.shareRole).toBe('commenter');
    expect(entry!.sourcePersisted).toBe(true);
  });

  it('declares build-memo as a consumer of every section it composes', () => {
    for (const p of [DELIVER_SUMMARY, LEARN_MEMO, OPP_SETUP, 'decisions.yaml']) {
      const e = ARTIFACT_MANIFEST.find((a) => a.path === p);
      expect(e, `no manifest entry for ${p}`).toBeDefined();
      expect(e!.consumedBy, `${p} does not list build-memo as a consumer`).toContain('build-memo');
    }
  });
});

describe('the Phase 4 boundary names it', () => {
  it('the fence expects it on the connect phase', () => {
    const paths = computeExpectedRequiredArtifacts('connect').map((e) => e.path);
    expect(paths).toContain(MEMO);
  });

  it('a Phase 4 folder without it fails the fence, naming a healable producer', () => {
    const everythingElse = computeExpectedRequiredArtifacts('connect')
      .map((e) => e.path)
      .filter((p) => p !== MEMO);
    const report = diffArtifacts('connect', everythingElse);
    expect(report.ok).toBe(false);
    expect(report.missing.map((m) => m.path)).toEqual([MEMO]);
    expect(report.missing[0].producedBy).toBe('build-memo');
  });

  it('the Google-Doc name without the extension still satisfies it (ace#786 tolerance)', () => {
    const present = computeExpectedRequiredArtifacts('connect')
      .map((e) => e.path)
      .map((p) => (p === MEMO ? '4-connect/build-memo' : p));
    expect(diffArtifacts('connect', present).ok).toBe(true);
  });

  it('the orchestrator Phase 4 section names the memo and the fence that gates it', () => {
    const orch = read('agents/ace-orchestrator.md');
    const phase4 = step(orch, '### Phase 4: Connect Setup', '### Phase 5: OCS Setup');
    expect(phase4).toContain(MEMO);
    expect(phase4).toMatch(/verify_phase_artifacts\(phase='connect'\)/);
    expect(phase4).toContain('Skill(build-memo)');
  });
});

describe('the phase agent composes it last and checks for it', () => {
  const agent = read('agents/connect-setup.md');

  it('claims build-memo in frontmatter', () => {
    const fm = agent.slice(0, agent.indexOf('\n---', 4));
    expect(fm).toMatch(/name:\s*build-memo\b/);
  });

  it('dispatches build-memo AFTER connect-opp-setup, whose section it reads', () => {
    const step2 = agent.indexOf('### Step 2: Opportunity Setup');
    const step3 = agent.indexOf('### Step 3: Build memo');
    expect(step2).toBeGreaterThan(0);
    expect(step3).toBeGreaterThan(step2);
    expect(agent.slice(step3)).toContain('Invoke the `build-memo` skill');
  });

  it('the self-check counts the memo among the required artifacts', () => {
    const selfCheck = step(agent, '### Self-check', '## Failure Modes');
    expect(selfCheck).toContain('build-memo.md');
    expect(selfCheck).toMatch(/\*\*5\*\* required artifacts/);
  });
});

describe('each producer names the section the composer reads', () => {
  it('pdd-to-deliver-app Step 7 names `## Build memo` with its two sub-tables', () => {
    const doc = read('skills/pdd-to-deliver-app/SKILL.md');
    const step7 = step(doc, '7. **Write the summary**', '8. **Notify admin group**');
    expect(step7).toContain('`## Build memo`');
    expect(step7).toContain('### [ACE] latitudes taken');
    expect(step7).toContain('### [FIXED] ambiguities hit');
  });

  it('pdd-to-learn-app has a WRITE step for its memo — the missing step was the defect', () => {
    const doc = read('skills/pdd-to-learn-app/SKILL.md');
    const step7a = step(doc, '7a. **Write the build memo**', '8. **Notify admin group**');
    expect(step7a, 'Step 7a (write the Learn build memo) is missing').not.toBe('');
    expect(step7a).toContain('3-commcare/pdd-to-learn-app_build-memo.md');
    expect(step7a).toContain('drive_create_file');
    expect(step7a).toMatch(/On every path/i);
    // Learn PDD §6(5): the framework-gap list, carried verbatim, including the
    // inventory-unavailable line (ace#2056 — never a parsed guess).
    expect(step7a).toContain('## Framework gaps (Learn PDD §6(5))');
    expect(step7a).toContain('buildMemoNotes');
    expect(step7a).toContain('inventory-unavailable');
  });

  it('connect-opp-setup Step 8 ends with the Phase 4 section, one row per PDD verification rule', () => {
    const doc = read('skills/connect-opp-setup/SKILL.md');
    const step8 = step(doc, '8. **Write config summary**', '9. **Capture the ConnectProd');
    expect(step8).toContain(PHASE4_HEADING.replace('## ', ''));
    expect(step8).toContain('### Verification rules — where each is applied');
    expect(step8).toMatch(/one row\s+per verification rule stated in ANY PDD of the run/);
    // Componentized programmes keep their rules in the component PDDs.
    expect(step8).toMatch(/component/);
  });

  it('"Not configurable on Connect" is a required statement, never an omission', () => {
    const doc = read('skills/connect-opp-setup/SKILL.md');
    const step8 = step(doc, '8. **Write config summary**', '9. **Capture the ConnectProd');
    expect(step8).toContain('Not configurable on Connect — applied in <where>');
    expect(step8).toContain('Not configurable on Connect — not applied anywhere in this build');
    expect(step8).toMatch(/must be\s+stated, never omitted/);
    expect(step8).toContain('ace#1013');
  });
});

describe('the composer composes; it never re-derives', () => {
  const doc = read('skills/build-memo/SKILL.md');

  it('reads exactly the named producer sections', () => {
    expect(doc).toContain(DELIVER_SUMMARY);
    expect(doc).toContain('`## Build memo`');
    expect(doc).toContain(LEARN_MEMO);
    expect(doc).toContain(OPP_SETUP);
    expect(doc).toContain(PHASE4_HEADING);
    expect(doc).toContain('decisions.yaml');
  });

  it('states the compose-never-re-derive rule and what a gap becomes', () => {
    expect(doc).toContain('## The one rule: compose, never re-derive');
    expect(doc).toContain('NOT CITED by <producer>');
    expect(doc).toContain('NOT STATED by connect-opp-setup');
    expect(doc).toMatch(/ABSENT — <path>/);
  });

  it('carries the four compilation parts plus a completeness table', () => {
    for (const h of [
      '## 1. Every [ACE] latitude taken and every [FIXED] ambiguity hit',
      '## 2. Deliver app',
      '## 3. Learn app',
      '## 4. Opportunity configuration and verification flags',
      '## 5. Completeness',
    ]) {
      expect(doc, `memo structure lacks "${h}"`).toContain(h);
    }
    expect(doc).toContain('"Not configurable on Connect" is a valid answer and must be stated');
  });

  it('publishes at one stable per-run path and records the link in typed state', () => {
    expect(doc).toContain("name: 'build-memo.md'");
    expect(doc).toContain('build-memo.source.md');
    expect(doc).toContain("role: 'commenter'");
    expect(doc).toMatch(/merge: 'deep'/);
    expect(doc).toContain("validateAs: { kind: 'phase-products', phase: 'connect-setup' }");
    expect(doc).toContain('build_memo:');
  });
});

describe('the review surfaces carry the link', () => {
  it('products.connect.build_memo is typed and attributed to build-memo, not connect-opp-setup', () => {
    const ok = PHASE_PRODUCTS_SCHEMAS['connect-setup'].safeParse({
      connect: {
        build_memo: {
          file_id: 'abc',
          title: 'Build memo',
          web_view_link: 'https://docs.google.com/document/d/abc/edit',
          complete: false,
          gaps: ['Learn build memo absent'],
        },
      },
    });
    expect(ok.success).toBe(true);
    const bad = PHASE_PRODUCTS_SCHEMAS['connect-setup'].safeParse({
      connect: { build_memo: { web_view_link: 'not a url' } },
    });
    expect(bad.success).toBe(false);
    expect(productProducer('connect-setup', 'connect.build_memo')).toBe('build-memo');
    expect(productProducer('connect-setup', 'connect.build_memo.web_view_link')).toBe('build-memo');
    // The rest of the block stays with its sole writer.
    expect(productProducer('connect-setup', 'connect.opportunity.url')).toBe('connect-opp-setup');
  });

  it('the orchestrator close-out and pause summary lead with the memo link', () => {
    expect(read('agents/ace-orchestrator.md')).toContain('products.connect.build_memo.web_view_link');
    expect(read('agents/orchestrator-reference.md')).toMatch(
      /\*\*Build memo:\*\* from Phase 4 on, `products\.connect\.build_memo\.web_view_link`/,
    );
  });
});
