/**
 * dimagi-internal/ace#1643 — `app-release` released the CCHQ draft without ever
 * asking whether the draft still matched the Nova blueprint.
 *
 * `classifyAppDrift` is the pure decision behind the new `app-release § Step
 * 3a`. It lives in lib/ so the rule is executable rather than prose: the
 * failure being prevented is a release that reports success while shipping
 * content the operator already fixed.
 *
 * ## Red/green honesty
 *
 * `classifyAppDrift` is new in this change, so these are the executable SPEC
 * of the new decision rather than assertions that were red against the pre-fix
 * tree (the pre-fix tree had no decision to be red about — it went straight to
 * `commcare_make_build`). Their preventer value is forward-looking: the two
 * deliberate asymmetries below — counts can never earn the skip, unresolved
 * signals default to re-upload — cannot be quietly relaxed without this file
 * going red. The pre-fix reds are in
 * `test/skills/app-release-drift-check.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type NovaBlueprintField,
  classifyAppDrift,
  countNovaVisibleFields,
  formatDriftDecision,
} from '../../lib/app-release-drift.js';
import { walkFormFields } from '../../scripts/run-form-walk.js';

const CCZ_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ccz');

const DEPLOYED = '2026-08-24T23:12:00Z';

describe('drift → re-upload, re-apply settings, then build', () => {
  it('the live repro: the run edited Nova after app-deploy', () => {
    const d = classifyAppDrift({
      app: 'deliver',
      deployedAt: DEPLOYED,
      novaEditedSinceDeploy: true,
      novaVisibleFieldCount: 50,
      hqDraftVisibleFieldCount: 48,
    });
    expect(d.drift).toBe(true);
    expect(d.action).toBe('reupload-reapply-settings-then-build');
    expect(d.conclusive).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/edited the Nova app after app-deploy/);
  });

  it('a field-count mismatch alone is enough', () => {
    const d = classifyAppDrift({
      app: 'deliver',
      novaVisibleFieldCount: 50,
      hqDraftVisibleFieldCount: 48,
    });
    expect(d.drift).toBe(true);
    expect(d.action).toBe('reupload-reapply-settings-then-build');
    expect(d.reasons.join(' ')).toMatch(/field count differs — Nova 50, HQ draft 48/);
  });

  it('a form-count mismatch alone is enough', () => {
    const d = classifyAppDrift({
      app: 'learn',
      novaFormCount: 7,
      hqDraftFormCount: 6,
      novaEditedSinceDeploy: false,
    });
    // The ordering signal says "clean" and the counts say otherwise. Any
    // positive signal wins — the counts are observing the draft directly.
    expect(d.drift).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/form count differs/);
  });

  it('a Nova edit timestamp after the deploy is enough', () => {
    const d = classifyAppDrift({
      app: 'deliver',
      deployedAt: DEPLOYED,
      novaEditedAt: '2026-08-24T23:40:00Z',
    });
    expect(d.drift).toBe(true);
    expect(d.conclusive).toBe(true);
  });

  it('reports every firing signal, not just the first', () => {
    const d = classifyAppDrift({
      app: 'deliver',
      deployedAt: DEPLOYED,
      novaEditedAt: '2026-08-24T23:40:00Z',
      novaEditedSinceDeploy: true,
      novaFormCount: 3,
      hqDraftFormCount: 2,
      novaVisibleFieldCount: 50,
      hqDraftVisibleFieldCount: 48,
    });
    expect(d.reasons).toHaveLength(4);
  });
});

describe('no drift → build directly', () => {
  it('the Learn app in the live repro: edits landed BEFORE the deploy', () => {
    const d = classifyAppDrift({
      app: 'learn',
      deployedAt: DEPLOYED,
      novaEditedAt: '2026-08-24T22:58:00Z',
      novaFormCount: 6,
      hqDraftFormCount: 6,
      novaVisibleFieldCount: 31,
      hqDraftVisibleFieldCount: 31,
    });
    expect(d.drift).toBe(false);
    expect(d.action).toBe('build-directly');
    expect(d.conclusive).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/no drift/);
  });

  it('an explicit "no Nova edit since deploy" clears it', () => {
    const d = classifyAppDrift({
      app: 'learn',
      deployedAt: DEPLOYED,
      novaEditedSinceDeploy: false,
      novaVisibleFieldCount: 31,
      hqDraftVisibleFieldCount: 31,
    });
    expect(d.drift).toBe(false);
    expect(d.action).toBe('build-directly');
    expect(d.reasons.join(' ')).toMatch(/no Nova edit after app-deploy/);
  });

  it('an edit at exactly the deploy instant is not drift', () => {
    const d = classifyAppDrift({
      app: 'learn',
      deployedAt: DEPLOYED,
      novaEditedAt: DEPLOYED,
    });
    expect(d.drift).toBe(false);
  });
});

describe('matching counts NEVER earn the skip on their own', () => {
  // Two of the three drifting Deliver edits in the repro — the extended
  // consent paragraph and the `area_ref` constraint — moved no count at all.
  // A count-only "all clear" would have shipped them stale on any run whose
  // edits happened to be text-only.
  it('agreeing counts with no ordering signal still re-uploads', () => {
    const d = classifyAppDrift({
      app: 'deliver',
      novaFormCount: 3,
      hqDraftFormCount: 3,
      novaVisibleFieldCount: 50,
      hqDraftVisibleFieldCount: 50,
    });
    expect(d.drift).toBe(true);
    expect(d.conclusive).toBe(false);
    expect(d.action).toBe('reupload-reapply-settings-then-build');
  });
});

describe('a hidden-inflated field count does not defeat an ordering-clear signal (ace#1789)', () => {
  // Live repro: bednet-check-2-visit/20260828-0629. Nova `get_app` counts
  // hidden fields (`user_score`, `qN_score`, `case_name`, `entity_key`, …);
  // the HQ draft walk never emits them. Raw Nova totals were Learn 44 /
  // Deliver 17 against HQ drafts of 32 / 14 — a mismatch on essentially
  // every ACE app — while both apps had `novaEditedSinceDeploy: false`.
  // Before this fix, ANY count mismatch forced `drift: true` before the
  // ordering fact was ever consulted, so the one signal that was supposed to
  // earn `build-directly` was unreachable.
  it('the run explicitly made no Nova edit since deploy: field mismatch is corroboration only', () => {
    const d = classifyAppDrift({
      app: 'learn',
      deployedAt: DEPLOYED,
      novaEditedSinceDeploy: false,
      // Raw, hidden-inflated Nova count vs. the HQ draft walk's count —
      // exactly the ace#1789 repro numbers.
      novaVisibleFieldCount: 44,
      hqDraftVisibleFieldCount: 32,
    });
    expect(d.drift).toBe(false);
    expect(d.action).toBe('build-directly');
    expect(d.conclusive).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/no drift/);
    expect(d.reasons.join(' ')).toMatch(/not treated as drift/);
  });

  it('an ordering timestamp proving the edit was at/before deploy has the same effect', () => {
    const d = classifyAppDrift({
      app: 'deliver',
      deployedAt: DEPLOYED,
      novaEditedAt: '2026-08-24T22:58:00Z',
      novaVisibleFieldCount: 17,
      hqDraftVisibleFieldCount: 14,
    });
    expect(d.drift).toBe(false);
    expect(d.action).toBe('build-directly');
  });

  it('a form-count mismatch is NOT downgraded the same way — forms have no hidden-field confound', () => {
    const d = classifyAppDrift({
      app: 'learn',
      novaEditedSinceDeploy: false,
      novaFormCount: 7,
      hqDraftFormCount: 6,
    });
    expect(d.drift).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/form count differs/);
  });

  it('a genuine field mismatch with NO ordering clearance still yields drift: true — the conservative default is not weakened', () => {
    const d = classifyAppDrift({
      app: 'deliver',
      novaVisibleFieldCount: 50,
      hqDraftVisibleFieldCount: 48,
    });
    expect(d.drift).toBe(true);
    expect(d.action).toBe('reupload-reapply-settings-then-build');
    expect(d.conclusive).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/field count differs — Nova 50, HQ draft 48/);
  });
});

describe('unresolved signals default to re-upload, and say they defaulted', () => {
  it('no signals at all', () => {
    const d = classifyAppDrift({ app: 'deliver' });
    expect(d.drift).toBe(true);
    expect(d.conclusive).toBe(false);
    expect(d.reasons.join(' ')).toMatch(/drift undetermined/);
  });

  it('a deploy timestamp with no Nova counterpart is not an ordering fact', () => {
    const d = classifyAppDrift({ app: 'deliver', deployedAt: DEPLOYED });
    expect(d.drift).toBe(true);
    expect(d.conclusive).toBe(false);
    expect(d.signals.orderingComparable).toBe(false);
  });

  it('unparseable timestamps are treated as absent, not as equal', () => {
    const d = classifyAppDrift({
      app: 'deliver',
      deployedAt: 'not-a-date',
      novaEditedAt: 'also-not-a-date',
    });
    expect(d.drift).toBe(true);
    expect(d.conclusive).toBe(false);
    expect(d.signals.novaEditedAfterDeploy).toBeNull();
  });

  it('one comparable count pair is not an ordering fact either', () => {
    const d = classifyAppDrift({ app: 'learn', novaVisibleFieldCount: 31, hqDraftVisibleFieldCount: 31 });
    expect(d.conclusive).toBe(false);
    expect(d.drift).toBe(true);
  });
});

describe('the decision is auditable', () => {
  it('reasons is never empty on any branch', () => {
    for (const inputs of [
      { app: 'a' },
      { app: 'b', novaEditedSinceDeploy: false, deployedAt: DEPLOYED },
      { app: 'c', novaVisibleFieldCount: 1, hqDraftVisibleFieldCount: 2 },
    ]) {
      expect(classifyAppDrift(inputs).reasons.length).toBeGreaterThan(0);
    }
  });

  it('records every comparison it was able to make', () => {
    const d = classifyAppDrift({
      app: 'deliver',
      novaVisibleFieldCount: 50,
      hqDraftVisibleFieldCount: 48,
      novaFormCount: 3,
    });
    expect(d.signals.fieldCounts).toEqual({ nova: 50, hq: 48, comparable: true, mismatch: true });
    expect(d.signals.formCounts).toEqual({ nova: 3, hq: null, comparable: false, mismatch: false });
  });

  it('formats a one-line summary that names the verdict and the action', () => {
    const drift = formatDriftDecision(
      classifyAppDrift({ app: 'deliver', novaEditedSinceDeploy: true }),
    );
    expect(drift).toMatch(/^deliver: DRIFT → reupload-reapply-settings-then-build\./);

    const defaulted = formatDriftDecision(classifyAppDrift({ app: 'deliver' }));
    expect(defaulted).toMatch(/DRIFT \(undetermined — defaulted\)/);

    const clean = formatDriftDecision(
      classifyAppDrift({ app: 'learn', novaEditedSinceDeploy: false }),
    );
    expect(clean).toMatch(/^learn: NO DRIFT → build-directly\./);
  });
});

/**
 * ace#1807 — the residual off-by-one #1789 left behind, one level up from the
 * leaf case it fixed.
 *
 * #1789 taught the contract to exclude `kind: hidden` LEAVES. A CONTAINER has
 * its own asymmetry: `walkFormFields` skips the `<group>` element but recurses
 * into it, so a group contributes a row **iff it emitted a `<label>` child**,
 * while Nova's `get_app` counts every container regardless.
 *
 * ## The issue's stated mechanism was refuted, and this block pins the
 * corrected rule
 *
 * #1807 read the delta as *"a group whose children are all hidden has no body
 * element at all"*. The compiled artifact says otherwise —
 * `test/fixtures/ccz/spark-facilitator-meeting-record.xml` (byte-identical to
 * released Deliver build `b08533bdf26a48a295a362ff204fb88d`, re-downloaded and
 * `shasum`-matched in the session that fixed this) carries all 14 groups in its
 * body, `meeting_summary` included, as `<group ref="/data/meeting_summary"/>`.
 * The element is emitted; only its LABEL is absent, because Nova's label for
 * that group is the empty string. The two properties coincide on this one
 * group and nowhere else in either app, so the correlation is not the cause.
 *
 * Excluding on "all descendants hidden" would be wrong in BOTH directions — it
 * would drop a labelled all-hidden container that the walk does count, and keep
 * an unlabelled container with visible children that the walk does not. Both
 * shapes are asserted below.
 *
 * ## Both sides are measured, neither is asserted
 *
 * The HQ column is recomputed at test time by running the SAME `walkFormFields`
 * the skill invokes over the vendored compiled forms. So this block cannot pass
 * by two hand-copied numbers agreeing; the walker and this function have to
 * agree, from a real Nova structure and real compiled XML respectively.
 */
describe('novaVisibleFieldCount excludes an UNLABELLED container (ace#1807)', () => {
  const g = (label: string, ...children: NovaBlueprintField[]): NovaBlueprintField => ({
    kind: 'group',
    label,
    children,
  });
  const f = (kind = 'text'): NovaBlueprintField => ({ kind });
  const h = (): NovaBlueprintField => ({ kind: 'hidden' });
  const many = (n: number, make: () => NovaBlueprintField) => Array.from({ length: n }, make);

  /** Nova blueprint of "Community enrolment", from a live `get_app`. */
  const ENROLMENT: NovaBlueprintField[] = [
    g('Community identity', ...many(6, () => f())),
    g('Households', f('int')),
    g(
      'Community location',
      f('geopoint'),
      h(),
      h(),
      h(),
      f('label'),
      f('label'),
      f('label'),
    ),
    g('Starting step', f('single_select'), h()),
  ];

  /** Nova blueprint of "Community meeting record", from the same `get_app`. */
  const MEETING: NovaBlueprintField[] = [
    g('Meeting date', f('date')),
    g('Did the meeting happen?', f('single_select')),
    g('Why the meeting did not happen', ...many(4, () => f())),
    g('Type of meeting', f('single_select')),
    g('FCAP step', f('single_select'), f('single_select')),
    g('Attendance', ...many(4, () => f('int'))),
    g('Participation', ...many(2, () => f('int'))),
    g('Who else attended', ...many(4, () => f())),
    g('How the meeting went', ...many(6, () => f())),
    g('Savings', f('single_select')),
    g('Savings details', ...many(6, () => f())),
    g(
      'Evidence',
      f('label'),
      f('single_select'),
      f('image'),
      f('geopoint'),
      h(),
      h(),
      h(),
      f('label'),
      f('label'),
      f('label'),
    ),
    g('Next meeting', f('date')),
    // The ace#1807 case: Nova label is "", eight children, all hidden.
    g('', ...many(8, () => h())),
  ];

  /** Nova's own raw total, so the fixture is provably the right app. */
  const rawCount = (fields: NovaBlueprintField[]): number =>
    fields.reduce((n, x) => n + 1 + rawCount(x.children ?? []), 0);

  it('the fixtures reproduce Nova get_app’s own raw totals (20 and 65)', () => {
    // If these drift, the fixture is no longer this app and nothing below holds.
    expect(rawCount(ENROLMENT)).toBe(20);
    expect(rawCount(MEETING)).toBe(65);
  });

  it('CROSS-CHECK: matches what walkFormFields emits from the real compiled CCZ', () => {
    const walk = (name: string) =>
      walkFormFields(readFileSync(join(CCZ_FIXTURES, name), 'utf8')).length;
    // Left side from the Nova blueprint, right side from the compiled XML.
    // Neither number is written down twice.
    expect(countNovaVisibleFields(ENROLMENT)).toBe(walk('spark-facilitator-enrolment.xml'));
    expect(countNovaVisibleFields(MEETING)).toBe(walk('spark-facilitator-meeting-record.xml'));
    // And the absolute values, so a change that moves BOTH sides is still loud.
    expect(countNovaVisibleFields(ENROLMENT)).toBe(16);
    expect(countNovaVisibleFields(MEETING)).toBe(53);
  });

  it('the whole delta is the unlabelled container, not the hidden leaves', () => {
    // #1789's rule alone (hidden leaves only) gives 54 — the residual this
    // issue is about. Recomputed here rather than quoted.
    const hiddenOnlyRule = (fields: NovaBlueprintField[]): number =>
      fields.reduce(
        (n, x) =>
          n +
          (x.kind === 'hidden' ? 0 : 1) +
          hiddenOnlyRule(x.children ?? []),
        0,
      );
    expect(hiddenOnlyRule(MEETING)).toBe(54);
    expect(countNovaVisibleFields(MEETING)).toBe(53);
    // Enrolment has no unlabelled container, so the two rules agree there —
    // which is why #1789 looked complete.
    expect(hiddenOnlyRule(ENROLMENT)).toBe(16);
    expect(countNovaVisibleFields(ENROLMENT)).toBe(16);
  });

  it('REFUTED SHAPE A: a LABELLED all-hidden container still counts', () => {
    // The walk emits its <label>, so Nova must count it too. An
    // "all descendants hidden" exclusion would drop it.
    expect(countNovaVisibleFields([g('Scores', h(), h(), h())])).toBe(1);
  });

  it('REFUTED SHAPE B: an UNLABELLED container with visible children does not count', () => {
    // No <label> emitted, so the walk sees only the children. An
    // "all descendants hidden" exclusion would wrongly keep the container.
    expect(countNovaVisibleFields([g('', f(), f())])).toBe(2);
  });

  it('a whitespace-only label is an absent label', () => {
    expect(countNovaVisibleFields([g('   ', f())])).toBe(1);
  });

  it('nests: an unlabelled container inside a labelled one', () => {
    expect(countNovaVisibleFields([g('Outer', f(), g('', h(), h()), g('Inner', f()))])).toBe(
      1 /* Outer */ + 1 /* leaf */ + 0 /* unlabelled */ + 1 /* Inner */ + 1 /* its leaf */,
    );
  });

  it('a labelled `repeat` counts like a labelled group', () => {
    expect(countNovaVisibleFields([{ kind: 'repeat', label: 'Members', children: [f(), h()] }])).toBe(
      2,
    );
  });

  it('the corrected count reaches the ORDERING fact instead of forcing a re-upload', () => {
    // The cost #1807 names: with the wrong basis the mismatch short-circuits
    // to drift, and the re-upload reverts appearance="acquire" and per-module
    // display_style (ace#1643), which app-release-qa Step 2.8 then BLOCKERs.
    const d = classifyAppDrift({
      app: 'deliver',
      novaEditedSinceDeploy: false,
      novaVisibleFieldCount: countNovaVisibleFields(MEETING),
      hqDraftVisibleFieldCount: 53,
    });
    expect(d.drift).toBe(false);
    expect(d.action).toBe('build-directly');
  });

  it('and a REAL field-count mismatch is still not silently forgiven', () => {
    const d = classifyAppDrift({
      app: 'deliver',
      novaVisibleFieldCount: countNovaVisibleFields(MEETING),
      hqDraftVisibleFieldCount: 51,
    });
    expect(d.drift).toBe(true);
  });
});
