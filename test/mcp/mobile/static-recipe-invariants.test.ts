import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Static-recipe content invariants. These guard against regressions in the
// hand-tuned palette recipes under `mcp/mobile/recipes/static/` — the kind
// of bugs that only surface live (silent off-screen tap targets, etc.) and
// are cheap to assert structurally here.

const STATIC_DIR = fileURLToPath(
  new URL('../../../mcp/mobile/recipes/static/', import.meta.url),
);

function readRecipe(name: string): string {
  return readFileSync(`${STATIC_DIR}${name}`, 'utf8');
}

describe('connect-claim-opp.yaml', () => {
  const yaml = readRecipe('connect-claim-opp.yaml');

  it('anchors every scrollUntilVisible on a button id below the OPP_NAME (not just the title text)', () => {
    // Regression guard for the 2026-05-15 turmeric run halt: anchoring
    // scrollUntilVisible on `text:${OPP_NAME}` alone left the button
    // beneath the title clipped off-screen, so the subsequent
    // `tapOn(id:btn_view_opportunity, below:text:${OPP_NAME})` matched a
    // node that wasn't actually rendered. Driving the scroll by the
    // element we need to tap is the structural fix.
    //
    // Both Resume and New-Opportunity branches each ship a
    // scrollUntilVisible — assert each one targets a button id and
    // is scoped to the target card via `below: text: ${OPP_NAME}`.
    // The unconditional title-scroll added before the branches uses
    // `text:` (no button id) — exclude it here; it has its own
    // dedicated regression test below.
    const scrollBlocks = [
      ...yaml.matchAll(
        /- scrollUntilVisible:\s*\n\s*element:\s*\n([\s\S]*?)\n\s*direction:/g,
      ),
    ];
    const buttonAnchoredScrolls = scrollBlocks
      .map((m) => m[1])
      .filter((clause) => /id: "org\.commcare\.dalvik:id\/btn_/.test(clause));
    expect(
      buttonAnchoredScrolls.length,
      'expected one button-anchored scrollUntilVisible per branch',
    ).toBeGreaterThanOrEqual(2);
    for (const elementClause of buttonAnchoredScrolls) {
      expect(elementClause).toMatch(
        /id: "org\.commcare\.dalvik:id\/(btn_resume|btn_view_opportunity)"/,
      );
      // Card-scoping must still pin to OPP_NAME so a stale prior-run invite
      // higher in the list isn't matched first.
      expect(elementClause).toContain('below:');
      expect(elementClause).toContain('text: ${OPP_NAME}');
    }
  });

  it('still scopes the final tapOn to the OPP_NAME card', () => {
    // The `below: text: ${OPP_NAME}` scoping on the tapOn is the original
    // safeguard against tapping a stale prior-run invite. Keep it.
    expect(yaml).toMatch(
      /- tapOn:\s*\n\s*id: "org\.commcare\.dalvik:id\/btn_view_opportunity"\s*\n\s*below:\s*\n\s*text: \$\{OPP_NAME\}/,
    );
  });

  it('scrolls the target title into the viewport BEFORE the branch `when:` guards evaluate', () => {
    // Regression guard for the 2026-05-17 malaria-itn-fgd run halt
    // (run 20260515-1645 Phase 6 attempt 8): with 4+ prior-run invite
    // cards rendered ahead of the target tile, both Branch A
    // (`btn_resume` + `below: text: ${OPP_NAME}`) and Branch B
    // (`btn_view_opportunity` + `below: text: ${OPP_NAME}`)
    // `when:` guards evaluate to false because the title is below the
    // fold. The in-body `scrollUntilVisible` lives INSIDE each guard,
    // so it never fires — recipe halts without claiming. Fix:
    // unconditional `scrollUntilVisible` on `text: ${OPP_NAME}`
    // before either branch, restoring the visibility precondition
    // both guards depend on.
    const titleScrollIdx = yaml.search(
      /- scrollUntilVisible:\s*\n\s*element:\s*\n\s*text: \$\{OPP_NAME\}\s*\n\s*direction: DOWN/,
    );
    expect(titleScrollIdx, 'expected an unconditional title scroll').toBeGreaterThan(-1);
    const branchAIdx = yaml.indexOf('# --- BRANCH A:');
    expect(branchAIdx, 'expected Branch A marker').toBeGreaterThan(-1);
    expect(
      titleScrollIdx,
      'title scroll must precede Branch A so its `when:` guard can resolve when the target is below the fold',
    ).toBeLessThan(branchAIdx);
  });

  it('scrolls the per-branch button into the viewport BEFORE the branch `when:` guards evaluate', () => {
    // Regression guard for malaria-itn-fgd run 20260515-1645 Phase 6
    // attempt 11: with 5+ prior-run invite cards rendered ahead of
    // the target, the title-only scroll-into-view leaves the title at
    // the viewport BOTTOM. The button below the title is clipped
    // off-screen, both Branch A (`btn_resume`) and Branch B
    // (`btn_view_opportunity`) `when:` guards evaluate to false
    // (the button isn't visible), and the in-body `scrollUntilVisible`
    // never fires. Catch-22.
    //
    // Fix: after the unconditional title-scroll, add a button-scroll
    // for each branch's possible button id. Each lives inside its own
    // `runFlow when: visible: { id: btn_* }` so only the actually-
    // present button is scrolled into view. By the time the Branch A
    // / Branch B guards below evaluate, the per-branch button is in
    // the rendered viewport.
    const branchAIdx = yaml.indexOf('# --- BRANCH A:');
    expect(branchAIdx, 'expected Branch A marker').toBeGreaterThan(-1);
    const preBranchYaml = yaml.slice(0, branchAIdx);

    // Both branch buttons must have a pre-branch scroll that brings
    // them into view (each scoped `below: text: ${OPP_NAME}`).
    expect(
      preBranchYaml,
      'expected pre-branch scroll for btn_resume below the target title',
    ).toMatch(
      /- scrollUntilVisible:\s*\n\s*element:\s*\n\s*id: "org\.commcare\.dalvik:id\/btn_resume"\s*\n\s*below:\s*\n\s*text: \$\{OPP_NAME\}/,
    );
    expect(
      preBranchYaml,
      'expected pre-branch scroll for btn_view_opportunity below the target title',
    ).toMatch(
      /- scrollUntilVisible:\s*\n\s*element:\s*\n\s*id: "org\.commcare\.dalvik:id\/btn_view_opportunity"\s*\n\s*below:\s*\n\s*text: \$\{OPP_NAME\}/,
    );
  });

  it('branches on btn_resume vs btn_view_opportunity, both card-scoped', () => {
    // Regression guard for the 2026-05-15 turmeric run wrong-opp claim:
    // when the target opp tile lives in the "In Progress" section it
    // shows `btn_resume` instead of `btn_view_opportunity`. The earlier
    // recipe assumed always-`btn_view_opportunity` and the `below:`
    // anchor matched the next downstream "New Opportunities" card,
    // silently claiming the wrong opp. Both branches must exist and
    // both must be scoped by `below: text: ${OPP_NAME}` so the runtime
    // visibility probe acts on the target card, not a sibling.
    expect(yaml).toMatch(
      /when:\s*\n\s*visible:\s*\n\s*id: "org\.commcare\.dalvik:id\/btn_resume"\s*\n\s*below:\s*\n\s*text: \$\{OPP_NAME\}/,
    );
    expect(yaml).toMatch(
      /when:\s*\n\s*visible:\s*\n\s*id: "org\.commcare\.dalvik:id\/btn_view_opportunity"\s*\n\s*below:\s*\n\s*text: \$\{OPP_NAME\}/,
    );
  });

  it('resume branch handles both connect_learning_button and btn_start surfaces', () => {
    // After tapping Resume on a Connect-data-wiped device the user lands on
    // an opp-detail "Job Card" with `connect_learning_button`
    // ("DOWNLOAD LEARN APP"); on other Connect states the same Resume
    // tap can land on the New-Opportunity-style detail with `btn_start`.
    // The Resume branch must probe both before falling through to the
    // shared `nsv_home_screen` wait.
    expect(yaml).toContain('org.commcare.dalvik:id/connect_learning_button');
    expect(yaml).toContain('org.commcare.dalvik:id/btn_start');
  });

  it('both branches converge on the Learn-app nsv_home_screen wait', () => {
    // The handoff selector for `learn-launch.yaml` is the Learn-app
    // StandardHomeActivity ScrollView. Whichever branch ran, the
    // recipe must end on this wait.
    expect(yaml).toMatch(
      /- extendedWaitUntil:\s*\n\s*visible:\s*\n\s*id: "org\.commcare\.dalvik:id\/nsv_home_screen"/,
    );
  });

  it('nsv_home_screen wait timeout is generous enough for CommCare Learn first-boot', () => {
    // Regression guard for the 2026-05-17 malaria-itn-fgd run halt
    // (run 20260515-1645 Phase 6 attempt 9): after the btn_start tap,
    // CommCare fires POST /users/start_learn_app/, downloads the
    // 14-step Learn CCZ, installs modules, and runs the initial sync
    // before StandardHomeActivity renders nsv_home_screen. The full
    // first-boot window can run past 60s on a fresh cold-booted AVD,
    // so the wait must be ≥120s. Earlier 60s value expired with the
    // recipe still on opp-detail, halting the run.
    const match = yaml.match(
      /- extendedWaitUntil:\s*\n\s*visible:\s*\n\s*id: "org\.commcare\.dalvik:id\/nsv_home_screen"\s*\n\s*timeout:\s*(\d+)/,
    );
    expect(match, 'expected an extendedWaitUntil on nsv_home_screen with an explicit timeout').not.toBeNull();
    const timeoutMs = Number(match![1]);
    expect(
      timeoutMs,
      'nsv_home_screen wait must be ≥120s to cover CommCare Learn first-boot (CCZ download + module install + initial sync)',
    ).toBeGreaterThanOrEqual(120000);
  });
});

describe('learn-tap-module.yaml', () => {
  const yaml = readRecipe('learn-tap-module.yaml');

  it('does NOT assume CommCare auto-skip into the only form — branches on nav_btn_next visibility', () => {
    // Regression guard for the 2026-05-15 turmeric run halt on Module 4
    // ("Form Walkthrough — Vendor & Product"): when a module's name
    // equals its single form's display name, CommCare suppresses the
    // auto-skip-into-only-form behavior and the device sits on the
    // intermediate one-row `screen_suite_menu_list`. The pre-fix
    // recipe taps the suite-root row and immediately handed off to
    // `form-advance.yaml`'s `tapOn nav_btn_next` — which halts
    // because the form hasn't been entered yet.
    //
    // The structural fix is a `runFlow when:` branch that probes for
    // `screen_suite_menu_list` still visible AND `nav_btn_next` NOT
    // visible (the same-name intermediate-list state), then taps the
    // only row to enter the form.
    expect(yaml).toMatch(/- runFlow:\s*\n\s*when:/);
    expect(yaml).toMatch(
      /when:\s*\n\s*visible:\s*\n\s*id: "org\.commcare\.dalvik:id\/screen_suite_menu_list"\s*\n\s*notVisible:\s*\n\s*id: "org\.commcare\.dalvik:id\/nav_btn_next"/,
    );
  });

  it('Branch B converges on nav_btn_next visible (form entered)', () => {
    // After tapping the intermediate-list row, the recipe must assert
    // that `nav_btn_next` becomes visible — so any further halt is
    // fast and named at the precondition rather than deep inside
    // form-advance.yaml.
    expect(yaml).toMatch(
      /extendedWaitUntil:\s*\n\s*visible:\s*\n\s*id: "org\.commcare\.dalvik:id\/nav_btn_next"/,
    );
  });

  it('opens the form via FORM_NAME when form-name != module-name (Branch C — name-mismatch case)', () => {
    // Regression guard for the malaria-itn-app/20260528-1607 Phase 6
    // halt. The ITN Learn app uses distinct, descriptive per-form names
    // (module "Visit Purpose & Ethics" → form "Purpose, Consent &
    // Do-No-Harm" — good authoring practice). When module-name !=
    // form-name, CommCare does NOT auto-skip into the single form: the
    // device sits on an intermediate one-row form-list whose only row is
    // the FORM name. The pre-fix recipe handled ONLY the same-name case
    // (Branch B taps by ${MODULE_NAME}); for the name-mismatch case it
    // skipped, leaving the form unopened. The generated journey then
    // tapped a form-internal option, found no target on the menu-list
    // screen, and hard-failed with selector-not-found.
    //
    // Structural fix (Branch C): when ${FORM_NAME} is supplied and a row
    // matching it is rendered in the menu-list body (scoped via
    // `below: id: screen_suite_menu_list` so the toolbar title — which
    // still reads ${MODULE_NAME} — is excluded), tap that form row to
    // open the form, then assert nav_btn_next visible. A SINGLE
    // learn-tap-module call (MODULE_NAME + FORM_NAME) now opens the form
    // in BOTH the same-name and name-mismatch cases.
    //
    // This assertion FAILS on the pre-fix recipe (which had no
    // ${FORM_NAME} matcher anywhere) and PASSES on the fixed one.
    expect(
      yaml,
      'expected a Branch C guard matching text:${FORM_NAME} scoped to the menu-list body',
    ).toMatch(
      /visible:\s*\n\s*text: "\$\{FORM_NAME\}"\s*\n\s*below:\s*\n\s*id: "org\.commcare\.dalvik:id\/screen_suite_menu_list"/,
    );
    // And the body must TAP that form row (scoped the same way) to open
    // the form — not merely probe for it.
    expect(
      yaml,
      'expected Branch C to tapOn the ${FORM_NAME} form row scoped to the menu-list body',
    ).toMatch(
      /- tapOn:\s*\n\s*text: "\$\{FORM_NAME\}"\s*\n\s*below:\s*\n\s*id: "org\.commcare\.dalvik:id\/screen_suite_menu_list"/,
    );
  });

  it('documents FORM_NAME as an optional parameter so callers know to pass it in a single call', () => {
    // The class-level fix only works if recipe authors (and the
    // app-test-cases generator) know to pass FORM_NAME alongside
    // MODULE_NAME in a single learn-tap-module invocation. The header
    // comment is the contract surface; assert it names FORM_NAME so the
    // parameter can't silently disappear from the documented interface.
    expect(yaml).toMatch(/\$\{FORM_NAME\}/);
    expect(yaml.toLowerCase()).toContain('optional');
  });

  it('Branch B only fires when the form row text matches MODULE_NAME (same-name case)', () => {
    // Regression guard for the 2026-05-19 malaria-itn-fgd run halt
    // (run 20260515-1645 Phase 6 attempt 12) on J1 module
    // "Briefing Acknowledgement" → form "Acknowledge Readiness":
    // Branch B's pre-fix `when:` clause only required the
    // intermediate form-list to be visible + nav_btn_next NOT visible,
    // so it fired regardless of whether the form's display name
    // matched the module name. On the form-list screen the toolbar
    // still reads ${MODULE_NAME}, so the inner re-tap of
    // `learn-suite-row-by-name` (text-anchored on ${MODULE_NAME})
    // landed on the non-tappable toolbar TextView; the subsequent
    // extendedWaitUntil on nav_btn_next then expired against the
    // unchanged form-list.
    //
    // Structural fix: Branch B's effective trigger must additionally
    // require a `${MODULE_NAME}`-matching node SCOPED to the menu-list
    // body (via `below: id: screen_suite_menu_list`). When form-name
    // != module-name, no such body node exists, so Branch B skips and
    // the caller's next learn-tap-module invocation (with FORM_NAME)
    // drills the form row by its own label.
    //
    // Expressed as a nested runFlow because Maestro `when:` clauses
    // accept ONE `visible:` element selector — combining two visible-
    // predicate semantics (outer: list-id visible; inner: text-in-
    // body visible) requires a nested flow.
    expect(yaml).toMatch(
      /visible:\s*\n\s*text: "\$\{MODULE_NAME\}"\s*\n\s*below:\s*\n\s*id: "org\.commcare\.dalvik:id\/screen_suite_menu_list"/,
    );
  });
});
