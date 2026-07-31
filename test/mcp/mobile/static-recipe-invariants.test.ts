import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveSelectorsInYaml } from '../../../mcp/mobile/recipe-resolver.js';
import {
  lintRecipeText,
  PALETTE_REQUIRED_SCREENSHOT_ENV,
} from '../../../mcp/mobile/recipe-lint.js';

// Static-recipe content invariants. These guard against regressions in the
// hand-tuned palette recipes under `mcp/mobile/recipes/static/` — the kind
// of bugs that only surface live (silent off-screen tap targets, etc.) and
// are cheap to assert structurally here.

const STATIC_DIR = fileURLToPath(
  new URL('../../../mcp/mobile/recipes/static/', import.meta.url),
);

// Assert on the RESOLVED recipe (every `${SELECTOR:logical-name}` /
// `"${SELECTOR:logical-name}"` replaced with its concrete matcher) so
// these structural invariants test the EFFECTIVE recipe Maestro runs —
// robust to whether a selector is written as a raw resource-id literal
// or referenced via the selector map (jjackson/ace#650). Resolving here
// also implicitly asserts the recipe's placeholders all resolve.
function readRecipe(name: string): string {
  const raw = readFileSync(`${STATIC_DIR}${name}`, 'utf8');
  return resolveSelectorsInYaml(raw, '2.63.0').yaml;
}

describe('connect-claim-opp.yaml', () => {
  const yaml = readRecipe('connect-claim-opp.yaml');

  it('anchors every scrollUntilVisible on a button id below the run-id matcher (not just the title text)', () => {
    // Regression guard for the 2026-05-15 turmeric run halt: anchoring
    // scrollUntilVisible on the title text alone left the button
    // beneath the title clipped off-screen, so the subsequent
    // `tapOn(id:btn_view_opportunity, below:text:".*${OPP_RUN_ID}.*")`
    // matched a node that wasn't actually rendered. Driving the scroll by
    // the element we need to tap is the structural fix.
    //
    // The tile discriminator is now the run-id (#618): Phase 4
    // front-prefixes the opp name with the run-id, and the recipe matches
    // `text: ".*${OPP_RUN_ID}.*"` (a substring-regex on the line-1 token)
    // instead of the full `${OPP_NAME}` label.
    //
    // Both Resume and New-Opportunity branches each ship a
    // scrollUntilVisible — assert each one targets a button id and
    // is scoped to the target card via `below: text: ".*${OPP_RUN_ID}.*"`.
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
      // Card-scoping must still pin to the run-id matcher so a stale
      // prior-run invite higher in the list isn't matched first.
      expect(elementClause).toContain('below:');
      expect(elementClause).toContain('text: ".*${OPP_RUN_ID}.*"');
    }
  });

  it('still scopes the final tapOn to the run-id-matched card', () => {
    // The `below: text: ".*${OPP_RUN_ID}.*"` scoping on the tapOn is the
    // original safeguard against tapping a stale prior-run invite, now
    // anchored on the run-id token (#618). Keep it.
    expect(yaml).toMatch(
      /- tapOn:\s*\n\s*id: "org\.commcare\.dalvik:id\/btn_view_opportunity"\s*\n\s*below:\s*\n\s*text: "\.\*\$\{OPP_RUN_ID\}\.\*"/,
    );
  });

  it('scrolls the target title into the viewport BEFORE the branch `when:` guards evaluate', () => {
    // Regression guard for the 2026-05-17 malaria-itn-fgd run halt
    // (run 20260515-1645 Phase 6 attempt 8): with 4+ prior-run invite
    // cards rendered ahead of the target tile, both Branch A
    // (`btn_resume` + `below: text: ".*${OPP_RUN_ID}.*"`) and Branch B
    // (`btn_view_opportunity` + `below: text: ".*${OPP_RUN_ID}.*"`)
    // `when:` guards evaluate to false because the title is below the
    // fold. The in-body `scrollUntilVisible` lives INSIDE each guard,
    // so it never fires — recipe halts without claiming. Fix:
    // unconditional `scrollUntilVisible` on `text: ".*${OPP_RUN_ID}.*"`
    // before either branch, restoring the visibility precondition
    // both guards depend on.
    const titleScrollIdx = yaml.search(
      /- scrollUntilVisible:\s*\n\s*element:\s*\n\s*text: "\.\*\$\{OPP_RUN_ID\}\.\*"\s*\n\s*direction: DOWN/,
    );
    expect(titleScrollIdx, 'expected an unconditional title scroll').toBeGreaterThan(-1);
    const branchAIdx = yaml.indexOf('# --- BRANCH A:');
    expect(branchAIdx, 'expected Branch A marker').toBeGreaterThan(-1);
    expect(
      titleScrollIdx,
      'title scroll must precede Branch A so its `when:` guard can resolve when the target is below the fold',
    ).toBeLessThan(branchAIdx);
  });

  it('centers the target card on the title scroll, so the branch buttons land in the viewport', () => {
    // `centerElement: true` (jjackson/ace#800) is the SOLE mechanism
    // putting the card's button in the rendered viewport before the
    // Branch A/B `when:` guards evaluate. Without it the title-scroll
    // leaves the matched card at the viewport BOTTOM, the button below
    // the title is clipped, both guards evaluate false, and the recipe
    // falls through to the #629 wedge detector on a healthy tile.
    // Probe-confirmed twice on bednet-spot-check/20260618-2112: the
    // below-scoped tapOn SKIPPED without centering and COMPLETED with it.
    //
    // This was asserted by NO test until 2026-07-29, which is how the
    // pre-branch button-scroll blocks (the older, redundant fix for the
    // same failure — see the sibling test below) survived long enough to
    // cause a regression of their own.
    const titleScroll = yaml.match(
      /- scrollUntilVisible:\s*\n\s*element:\s*\n\s*text: "\.\*\$\{OPP_RUN_ID\}\.\*"\s*\n([\s\S]*?)(?=\n- )/,
    );
    expect(titleScroll, 'expected the unconditional title scroll').not.toBeNull();
    expect(
      titleScroll![1],
      'title scroll must set centerElement: true — it is the only thing bringing the branch button into view',
    ).toMatch(/centerElement: true/);
  });

  it('lets nothing scroll the list between the title scroll and Branch A', () => {
    // Regression guard for bednet-spot-check/20260729-1239 Phase 6.
    //
    // Two "pre-branch button-scroll" runFlow blocks used to sit here —
    // the older fix for the below-fold catch-22 (malaria-itn-fgd
    // 20260515-1645), superseded by `centerElement: true` above. Their
    // `when:` guards were deliberately UNSCOPED (`visible: { id:
    // btn_resume }`, no `below:`), so on the steady-state accumulated
    // invite list the guard matched a STALE In-Progress tile's Resume
    // button, entered the body, and the below-scoped `optional: true`
    // scroll — hunting a btn_resume below a title that is a NEW
    // opportunity, where none exists — ran its full 40s budget
    // scrolling to the list BOTTOM.
    //
    // The trap: an `optional: true` scrollUntilVisible that never finds
    // its target does NOT no-op. It still scrolls, and that side effect
    // destroyed the centered viewport the title-scroll had just
    // established — so both Branch A/B guards evaluated false and the
    // recipe wedged on a claimable tile.
    //
    // The old test asserted only the BODY scoping of those blocks and
    // never constrained their GUARD scoping; the defect lived exactly in
    // that gap. So assert the postcondition instead of an
    // implementation: between the centered title-scroll and Branch A,
    // nothing may move the list.
    const branchAIdx = yaml.indexOf('# --- BRANCH A:');
    expect(branchAIdx, 'expected Branch A marker').toBeGreaterThan(-1);

    const titleScrollIdx = yaml.search(
      /- scrollUntilVisible:\s*\n\s*element:\s*\n\s*text: "\.\*\$\{OPP_RUN_ID\}\.\*"\s*\n\s*direction: DOWN/,
    );
    expect(titleScrollIdx, 'expected an unconditional title scroll').toBeGreaterThan(-1);

    // Strip comments — the rationale above legitimately names these steps.
    const between = yaml
      .slice(titleScrollIdx, branchAIdx)
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
      // drop the title scroll itself; we are checking what FOLLOWS it
      .replace(/^- scrollUntilVisible:[\s\S]*?(?=\n- |$)/, '');

    expect(
      between,
      'no second scrollUntilVisible may follow the centered title scroll — it destroys the centering',
    ).not.toMatch(/- scrollUntilVisible:/);
    expect(
      between,
      'no runFlow may sit between the title scroll and Branch A — an unscoped `when:` guard can match a stale tile',
    ).not.toMatch(/- runFlow:/);
    expect(
      between,
      'no swipe/scroll step may follow the centered title scroll',
    ).not.toMatch(/- (swipe|scroll):/);
  });

  it('branches on btn_resume vs btn_view_opportunity, both card-scoped', () => {
    // Regression guard for the 2026-05-15 turmeric run wrong-opp claim:
    // when the target opp tile lives in the "In Progress" section it
    // shows `btn_resume` instead of `btn_view_opportunity`. The earlier
    // recipe assumed always-`btn_view_opportunity` and the `below:`
    // anchor matched the next downstream "New Opportunities" card,
    // silently claiming the wrong opp. Both branches must exist and
    // both must be scoped by `below: text: ".*${OPP_RUN_ID}.*"` so the
    // runtime visibility probe acts on the target card, not a sibling.
    expect(yaml).toMatch(
      /when:\s*\n\s*visible:\s*\n\s*id: "org\.commcare\.dalvik:id\/btn_resume"\s*\n\s*below:\s*\n\s*text: "\.\*\$\{OPP_RUN_ID\}\.\*"/,
    );
    expect(yaml).toMatch(
      /when:\s*\n\s*visible:\s*\n\s*id: "org\.commcare\.dalvik:id\/btn_view_opportunity"\s*\n\s*below:\s*\n\s*text: "\.\*\$\{OPP_RUN_ID\}\.\*"/,
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

  it('Branch B TAP is body-scoped to MODULE_NAME (not the bare toolbar-colliding text match)', () => {
    // Regression guard for jjackson/ace#590 (malaria-rdt/20260531-0739
    // Phase 6 halt on Module 1 "Program Orientation"). Branch B's
    // *when:* guard was already body-scoped, but its *tap* still used
    // the bare `${SELECTOR:learn-suite-row-by-name}` (a `text:
    // ${MODULE_NAME}` matcher). On the intermediate form-list screen the
    // TOOLBAR TITLE also reads ${MODULE_NAME}, so the bare matcher
    // resolved to the non-tappable toolbar title, the form row was never
    // opened, and the nav_btn_next assert expired.
    //
    // The fix mirrors Branch C: Branch B's tap must be scoped to the
    // menu-list body via `below: id: screen_suite_menu_list` so it lands
    // on the (tappable) form row, not the (non-tappable) toolbar title.
    // FORM_NAME identifies Branch C's tap; MODULE_NAME identifies
    // Branch B's — this regex matches only Branch B.
    expect(
      yaml,
      'expected Branch B to tapOn text:${MODULE_NAME} scoped to the menu-list body (below: screen_suite_menu_list)',
    ).toMatch(
      /- tapOn:\s*\n\s*text: "\$\{MODULE_NAME\}"\s*\n\s*below:\s*\n\s*id: "org\.commcare\.dalvik:id\/screen_suite_menu_list"/,
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

describe('connect-resume-opp.yaml', () => {
  const yaml = readRecipe('connect-resume-opp.yaml');

  it('scopes the CTA tap to the target card (childOf containsChild), not the leaky below:text pattern', () => {
    // Regression guard for jjackson/ace#591 (malaria-rdt/20260531-0739):
    // the prior recipe tapped `id: btn_resume, below: text: ${OPP_NAME}`,
    // which matches the FIRST btn_resume in DOCUMENT ORDER below the title
    // and leaked into a LATER tile's button — resuming the WRONG opp when
    // the target was Learn-complete (its own CTA is "Proceed", not
    // "Resume"). Live-confirmed fix (ACE_Pixel_API_34, 2.63.0): each tile
    // is a rootCardView whose inner ViewGroup holds tvTitle + the CTA as
    // sibling direct children, so `childOf: { containsChild: { text:
    // ".*${OPP_RUN_ID}.*" } }` pins the tap to the target card. The
    // card-identity anchor is the run-id token (#618), not the full
    // ${OPP_NAME} label.
    expect(
      yaml,
      'expected card-scoped CTA tap via childOf/containsChild on the run-id matcher',
    ).toMatch(
      /childOf:\s*\n\s*containsChild:\s*\n\s*text:\s*"\.\*\$\{OPP_RUN_ID\}\.\*"/,
    );
    // The old leaky tap (btn_resume directly below the title text) must be gone.
    expect(
      yaml,
      'the leaky `id: btn_resume / below: text: ".*${OPP_RUN_ID}.*"` tap must not return',
    ).not.toMatch(
      /id: "org\.commcare\.dalvik:id\/btn_resume"\s*\n\s*below:\s*\n\s*text:\s*"\.\*\$\{OPP_RUN_ID\}\.\*"/,
    );
  });

  it('Branch B (Learn-complete) guards POSITIVELY on the Proceed CTA, not on btn_resume absence', () => {
    // Caught live 2026-05-31: a `notVisible btn_resume` guard for the
    // Proceed branch becomes TRUE after Branch A taps Resume and navigates
    // away, wrongly firing Branch B (which then fails to find "Proceed").
    // The two CTA branches must use mutually-exclusive POSITIVE guards
    // (only one CTA label is present per card), so neither re-fires after
    // a tap navigates off the jobs list.
    expect(
      yaml,
      'expected a positive `visible: text: "Proceed"` guard for the Learn-complete branch',
    ).toMatch(
      /when:\s*\n\s*visible:\s*\n\s*text: "Proceed"/,
    );
    expect(
      yaml,
      'the Proceed branch must NOT guard on `notVisible btn_resume` (fires post-navigation)',
    ).not.toMatch(
      /when:\s*\n\s*notVisible:\s*\n\s*id: "org\.commcare\.dalvik:id\/btn_resume"/,
    );
  });

  it('fails loud if the CTA tap did not leave the jobs list (no silent wrong-opp resume)', () => {
    // #591: a correct CTA tap navigates off connect_fragment_jobs_list.
    // The recipe must assert we left the list so a no-op / wrong-surface
    // tap halts with a named failure instead of silently proceeding into
    // the wrong opp's app.
    expect(
      yaml,
      'expected a fail-loud notVisible assertion on connect_fragment_jobs_list after the CTA tap',
    ).toMatch(
      /notVisible:\s*\n\s*id: "org\.commcare\.dalvik:id\/connect_fragment_jobs_list"/,
    );
  });
});

describe('deliver-sync.yaml', () => {
  const yaml = readRecipe('deliver-sync.yaml');

  // Regression guard for dimagi-internal/ace#1066. `form-submit.yaml`
  // finalizes a plain Deliver form via its `nav_btn_next` auto-finalize
  // branch, which writes to the LOCAL OUTBOX and asserts nothing about the
  // server; only its score-gated branch (`form-nav-finish`, the Learn quiz)
  // asserts ".*form.*sent to server.*". So a Deliver leg that ends at
  // form-submit proves only "the form walked and finalized locally" — an
  // opportunity whose Deliver->Connect path was completely broken would
  // still pass. Observed live on bednet-spot-check/20260729-1239.

  it('asserts the SERVER-DERIVED visit counter, not just the sync banner', () => {
    // The banner only says the sync call returned — it returns even with an
    // empty outbox (observed live: "Sync Successful" alongside the toast
    // "No forms sent to server!"). `Daily Visits` is 0/N until a visit
    // actually reaches Connect, so it is the only assertion here that can
    // fail the reported scenario.
    expect(yaml, 'expected the sync-result banner assertion').toMatch(
      /Sync Successful\|up to date/,
    );
    expect(yaml, 'expected the counter row to be asserted present').toContain(
      'text: "Daily Visits"',
    );
  });

  it('fails a zero counter — the actual reported failure mode', () => {
    // This is THE assertion. Without it the recipe passes on 0/5, which is
    // exactly the state #1066 reported.
    expect(yaml, 'expected assertNotVisible on a zero-valued counter').toMatch(
      /- assertNotVisible:\s*\n\s*text: "0\/\[0-9\]\+"/,
    );
  });

  it('does not rely on a bare N/M match that could false-pass', () => {
    // A lone `.*[1-9][0-9]*/[0-9]+.*` would match ANY unrelated "N/M" on the
    // surface — the same false-pass class this recipe exists to close. The
    // positive match is only sound when paired with the label-present and
    // no-zero-counter assertions above, so require all three to co-exist.
    const hasPositive = /text: "\.\*\[1-9\]\[0-9\]\*\/\[0-9\]\+\.\*"/.test(yaml);
    if (hasPositive) {
      expect(yaml, 'a bare N/M match must be paired with the label assertion').toContain(
        'text: "Daily Visits"',
      );
      expect(yaml, 'a bare N/M match must be paired with the zero-counter guard').toMatch(
        /assertNotVisible/,
      );
    }
  });
});

describe('screenshot-name binding contract (dimagi-internal/ace#1033)', () => {
  // MEASURED MAESTRO PRECEDENCE (2.5.1, the pinned version): a flow's own
  // top-level `env:` block does NOT default under caller-passed env — it
  // OVERRIDES it. `MaestroFlowParser.parseFlow` prepends the subflow's
  // `env:` as a DefineVariablesCommand inside the subflow body;
  // `YamlFluentCommand.runFlow` prepends the CALLER's env in front of that;
  // `Orchestra.runSubFlow` runs both in list order and
  // `GraalJsEngine.putEnv` assigns unconditionally — so the subflow's block
  // writes LAST and wins. Live-corroborated on
  // bednet-spot-check/20260728-2222, where a caller passing
  // "journey-learn-result"/"journey-learn-submitted" got
  // `form-submit-pre.png`/`form-submit-post.png` on disk.
  //
  // Therefore the contract is: palette subflows carry NO screenshot-name
  // `env:` defaults, and EVERY call site binds every name it needs. These
  // invariants pin both halves so #852 cannot recur through a third file.

  const paletteFiles = readdirSync(STATIC_DIR).filter((n) => n.endsWith('.yaml'));

  /** `${SCREENSHOT_NAME}` / `${SCREENSHOT_NAME_PRE_SUBMIT}` / ... refs in a body. */
  function screenshotNameRefs(yaml: string): string[] {
    return [
      ...new Set(
        [...yaml.matchAll(/\$\{(SCREENSHOT_NAME[A-Z0-9_]*)\}/g)].map((m) => m[1]),
      ),
    ].sort();
  }

  it('the lint contract matches the palette — no drift in either direction', () => {
    // The lint rule (and therefore the authoring-time gate) is driven by a
    // hardcoded map. If a new palette file starts naming a screenshot from
    // env, or an existing one stops, the map must move with it — otherwise
    // the gate silently stops covering a file, which is exactly how #852
    // recurred through form-advance.yaml.
    const derived: Record<string, string[]> = {};
    for (const filename of paletteFiles) {
      const refs = screenshotNameRefs(readFileSync(`${STATIC_DIR}${filename}`, 'utf8'));
      if (refs.length > 0) derived[filename] = refs;
    }
    const declared = Object.fromEntries(
      Object.entries(PALETTE_REQUIRED_SCREENSHOT_ENV).map(([k, v]) => [k, [...v].sort()]),
    );
    expect(
      declared,
      'PALETTE_REQUIRED_SCREENSHOT_ENV in mcp/mobile/recipe-lint.ts must list exactly the palette files that reference ${SCREENSHOT_NAME*}, with exactly those keys',
    ).toEqual(derived);
  });

  it('no palette file declares an `env:` default for a screenshot name', () => {
    // A subflow `env:` default SHADOWS the caller (see the block comment
    // above), so a default here does not merely add a fallback — it
    // silently overrides every per-journey name the caller passed. This is
    // the defect the #852 fix introduced into form-submit.yaml.
    for (const filename of paletteFiles) {
      const yaml = readFileSync(`${STATIC_DIR}${filename}`, 'utf8');
      // Front-matter is everything before the first `---` separator line.
      const sepIdx = yaml.search(/^---\s*$/m);
      const frontMatter = sepIdx === -1 ? yaml : yaml.slice(0, sepIdx);
      const uncommented = frontMatter
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');
      expect(
        uncommented,
        `${filename}: front-matter must not set a SCREENSHOT_NAME* env default — a subflow env: block OVERRIDES caller-passed runFlow env in Maestro 2.5.1, so this silently defeats per-call-site naming (ace#1033)`,
      ).not.toMatch(/^\s*SCREENSHOT_NAME[A-Z0-9_]*\s*:/m);
    }
  });

  it('every screenshot-naming palette documents its names as caller-bound', () => {
    // The header comment is the contract surface a recipe author reads.
    // If it does not say the name is required at the call site, the next
    // author writes a bare `runFlow: { file: form-advance.yaml }` — which
    // is literally what produced `undefined.png` on 20260728-2222.
    for (const [filename, keys] of Object.entries(PALETTE_REQUIRED_SCREENSHOT_ENV)) {
      const yaml = readFileSync(`${STATIC_DIR}${filename}`, 'utf8');
      expect(
        yaml,
        `${filename}: header must state that the screenshot name(s) are REQUIRED AT EVERY CALL SITE`,
      ).toMatch(/REQUIRED AT EVERY CALL SITE/);
      for (const key of keys) {
        expect(yaml, `${filename}: header must name \${${key}}`).toContain(`\${${key}}`);
      }
    }
  });

  it('every palette-internal runFlow into a screenshot-naming palette binds its names', () => {
    // Today no palette file composes another screenshot-naming palette, so
    // this is a forward guard: the moment one does, the lint rule that
    // gates generated recipes must also hold for the palette itself.
    for (const filename of paletteFiles) {
      const yaml = readFileSync(`${STATIC_DIR}${filename}`, 'utf8');
      const unbound = lintRecipeText(yaml).violations.filter(
        (v) => v.rule === 'runFlow-unbound-screenshot-name',
      );
      expect(
        unbound.map((v) => `${filename}:${v.line} ${v.detail}`),
        `${filename}: unbound screenshot-name runFlow call site(s)`,
      ).toEqual([]);
    }
  });

  it('every documented call site in app-test-cases/SKILL.md binds its names', () => {
    // SKILL.md is the authoring template — the generated journey recipes
    // are copied from these examples. `journey-learn.yaml` emitted a bare
    // `runFlow: { file: form-advance.yaml }` on 20260728-2222 because
    // SKILL.md showed exactly that. Pin the examples so the prose cannot
    // teach the defect back in (same precedent as the deliver-sync
    // composition contract below).
    const md = readFileSync(
      fileURLToPath(new URL('../../../skills/app-test-cases/SKILL.md', import.meta.url)),
      'utf8',
    );
    const lines = md.split('\n');
    const failures: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      // Shape (b): scalar shorthand `- runFlow: form-advance.yaml` — there
      // is nowhere to bind env at all, so it is always a violation.
      const scalar = lines[i].match(/^\s*-\s+runFlow:\s+([\w./-]+\.yaml)\s*(?:#.*)?$/);
      if (scalar) {
        const name = scalar[1].replace(/^.*\//, '');
        if (PALETTE_REQUIRED_SCREENSHOT_ENV[name]) {
          failures.push(
            `SKILL.md:${i + 1} scalar \`runFlow: ${name}\` cannot bind ${PALETTE_REQUIRED_SCREENSHOT_ENV[
              name
            ].join('/')} — use the mapping form with an \`env:\` block`,
          );
        }
        continue;
      }
      // Shape (a): `- runFlow:` / `    file: X.yaml` / `    env:` / keys.
      const fileLine = lines[i].match(/^(\s*)file:\s*([\w./-]+\.yaml)\s*(?:#.*)?$/);
      if (!fileLine) continue;
      const indent = fileLine[1].length;
      const name = fileLine[2].replace(/^.*\//, '');
      const required = PALETTE_REQUIRED_SCREENSHOT_ENV[name];
      if (!required) continue;

      // Collect the rest of this runFlow block: following lines that stay
      // at least as indented as the `file:` key. A shallower line (the next
      // list item, prose, or the closing fence) ends the block.
      const block: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim() === '') break;
        const lineIndent = line.length - line.trimStart().length;
        if (lineIndent < indent) break;
        block.push(line);
      }
      const body = block.join('\n');
      const missing = required.filter((key) => !new RegExp(`^\\s*${key}\\s*:\\s*\\S`, 'm').test(body));
      if (missing.length > 0) {
        failures.push(
          `SKILL.md:${i + 1} runFlow into ${name} does not bind ${missing.join(' + ')}`,
        );
      }
    }

    expect(
      failures,
      'every SKILL.md runFlow example targeting a screenshot-naming palette must bind its ${SCREENSHOT_NAME*} keys with a per-call-site name (ace#1033)',
    ).toEqual([]);
  });
});

describe('app-test-cases composition contract', () => {
  // The recipe above is dead code unless every Deliver journey actually
  // composes it. `journey-deliver.yaml` is authored per-run by the
  // app-test-cases skill, so the contract lives in that SKILL.md — pin it
  // here so the requirement cannot quietly disappear from the prose.
  it('requires deliver-sync.yaml as the last step of a Deliver journey', () => {
    const skill = readFileSync(
      fileURLToPath(new URL('../../../skills/app-test-cases/SKILL.md', import.meta.url)),
      'utf8',
    );
    expect(skill, 'SKILL.md must compose deliver-sync.yaml').toContain(
      'runFlow: deliver-sync.yaml',
    );
    expect(skill, 'SKILL.md must state that it is mandatory').toMatch(
      /deliver-sync\.yaml` is MANDATORY/,
    );
  });
});
