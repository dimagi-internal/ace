import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
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

const SELECTORS_DIR = fileURLToPath(
  new URL('../../../mcp/mobile/selectors/', import.meta.url),
);

/** Escape a literal string for embedding in a RegExp source. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function selectorMap(apk: string): {
  selectors: Record<string, { type: string; value: string; unverified?: boolean; purpose?: string }>;
} {
  return parseYaml(readFileSync(`${SELECTORS_DIR}connect-${apk}.yaml`, 'utf8')) as ReturnType<
    typeof selectorMap
  >;
}

// The RESOLVED menu-container matcher, read from the map rather than
// duplicated here — so an intentional widening of the anchor (a third
// display mode) updates these structural regexes in one place instead of
// silently failing five of them (dimagi-internal/ace#1127).
const MENU_ID_RE = escapeRe(selectorMap('2.63.0').selectors['learn-suite-menu'].value);

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
    // implementation.
    //
    // RESTATED 2026-08-20 (ace#1289, second clause). The original form of
    // this test said "nothing may follow the FIRST title-scroll". That
    // over-constrained: the fallback re-hunt added for #1289 legitimately
    // scrolls after the primary scroll, and then re-establishes the
    // centering itself. What #800 actually requires is weaker and exact:
    //
    //   (a) the LAST viewport-moving step before Branch A is a centered
    //       DOWN hunt for the run-id — so the card (title + button) is in
    //       the viewport when the `below:`-scoped guards evaluate; and
    //   (b) every runFlow that sits before Branch A scopes its `when:`
    //       guard to `${OPP_RUN_ID}` — which is the property the
    //       2026-07-29 wedge blocks lacked (their guards were UNSCOPED, so
    //       a stale In-Progress tile's btn_resume entered the body).
    //
    // Both halves of the original defect still fail here.
    const branchAIdx = yaml.indexOf('# --- BRANCH A:');
    expect(branchAIdx, 'expected Branch A marker').toBeGreaterThan(-1);

    // Strip comments — the rationale prose legitimately names these steps.
    const preBranch = yaml
      .slice(0, branchAIdx)
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    // (a) The last scroll before the guards must be the centered run-id hunt.
    const lastScrollIdx = preBranch.lastIndexOf('scrollUntilVisible:');
    expect(lastScrollIdx, 'expected a tile scroll before Branch A').toBeGreaterThan(-1);
    const lastScroll = preBranch.slice(lastScrollIdx);
    expect(
      lastScroll,
      'the last scroll before the branch guards must hunt the run-id tile',
    ).toMatch(/text: "\.\*\$\{OPP_RUN_ID\}\.\*"/);
    expect(
      lastScroll,
      'the last scroll before the branch guards must center the card (#800) — ' +
        'without it btn_view_opportunity/btn_resume is clipped and both guards evaluate false',
    ).toMatch(/centerElement: true/);
    expect(
      lastScroll,
      'the last scroll before the branch guards must run DOWN onto the tile',
    ).toMatch(/direction: DOWN/);

    const after = preBranch.slice(lastScrollIdx + 'scrollUntilVisible:'.length);
    expect(
      after,
      'nothing may move the list after the centered run-id scroll — it destroys the centering',
    ).not.toMatch(/(scrollUntilVisible|swipe|scroll):/);

    // (b) Every guard in the TILE-DISCOVERY region — i.e. from the first
    //     run-id scroll to Branch A — must be scoped to THIS run's tile.
    //     (Earlier runFlows in this recipe handle app first-start and are
    //     legitimately unscoped; they run before any tile exists.)
    const firstTileScrollIdx = preBranch.search(
      /-\s*scrollUntilVisible:\s*\n\s*element:\s*\n\s*text: "\.\*\$\{OPP_RUN_ID\}\.\*"/,
    );
    expect(firstTileScrollIdx, 'expected a run-id tile scroll').toBeGreaterThan(-1);
    const guards = preBranch.slice(firstTileScrollIdx).split(/-\s*runFlow:/).slice(1);
    for (const [i, chunk] of guards.entries()) {
      const when = chunk.split(/commands:/)[0];
      expect(
        when,
        `pre-branch runFlow ${i}: its \`when:\` guard must reference \${OPP_RUN_ID} — ` +
          'an unscoped guard matches a STALE tile and wedges a claimable opp (2026-07-29)',
      ).toMatch(/\$\{OPP_RUN_ID\}/);
    }
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
      new RegExp(
        `when:\\s*\\n\\s*visible:\\s*\\n\\s*id: "${MENU_ID_RE}"\\s*\\n\\s*notVisible:\\s*\\n\\s*id: "org\\.commcare\\.dalvik:id/nav_btn_next"`,
      ),
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
      'expected Branch B to tapOn text:${MODULE_NAME} scoped to the menu body (below: the menu container)',
    ).toMatch(
      new RegExp(
        `- tapOn:\\s*\\n\\s*text: "\\$\\{MODULE_NAME\\}"\\s*\\n\\s*below:\\s*\\n\\s*id: "${MENU_ID_RE}"`,
      ),
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
      'expected a Branch C guard matching text:${FORM_NAME} scoped to the menu body',
    ).toMatch(
      new RegExp(
        `visible:\\s*\\n\\s*text: "\\$\\{FORM_NAME\\}"\\s*\\n\\s*below:\\s*\\n\\s*id: "${MENU_ID_RE}"`,
      ),
    );
    // And the body must TAP that form row (scoped the same way) to open
    // the form — not merely probe for it.
    expect(
      yaml,
      'expected Branch C to tapOn the ${FORM_NAME} form row scoped to the menu body',
    ).toMatch(
      new RegExp(
        `- tapOn:\\s*\\n\\s*text: "\\$\\{FORM_NAME\\}"\\s*\\n\\s*below:\\s*\\n\\s*id: "${MENU_ID_RE}"`,
      ),
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
    // body (via `below: id: <the menu container>`). When form-name
    // != module-name, no such body node exists, so Branch B skips and
    // the caller's next learn-tap-module invocation (with FORM_NAME)
    // drills the form row by its own label.
    //
    // Expressed as a nested runFlow because Maestro `when:` clauses
    // accept ONE `visible:` element selector — combining two visible-
    // predicate semantics (outer: list-id visible; inner: text-in-
    // body visible) requires a nested flow.
    expect(yaml).toMatch(
      new RegExp(
        `visible:\\s*\\n\\s*text: "\\$\\{MODULE_NAME\\}"\\s*\\n\\s*below:\\s*\\n\\s*id: "${MENU_ID_RE}"`,
      ),
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

  // Regression guard for dimagi-internal/ace#1494. The back-walk climbs from
  // wherever form-submit left the device to StandardHomeActivity, where the
  // "Sync with Server" tile lives. A CASE-BOUND Deliver form sits one level
  // DEEPER than the shallow path: deliver-form-walk.yaml composes
  // deliver-case-select.yaml between the module row and the form row, whose
  // live-observed order is
  //   module row -> CASE LIST -> case detail -> CONTINUE -> FORM LIST -> form
  // (2.63.2, ace#1138). With only two backs the assert below fired on the
  // module grid, so the Deliver leg could never return `pass` on a multi-stage
  // opp — a blocks-e2e defect that looked like a flaky sync.
  //
  // Every back is guarded on `notVisible` the home tile, so over-provisioning
  // is a provable no-op on the shallow path: this count is a floor, not an
  // exact figure, and raising it cannot regress the shallow leg.
  it('walks back deep enough for a case-bound Deliver form (>= 4 guarded backs)', () => {
    const beforeAssert = yaml.slice(0, yaml.indexOf('assertVisible'));
    const guarded = [...beforeAssert.matchAll(/notVisible:/g)].length;
    expect(
      guarded,
      'deliver-sync.yaml must guard-walk back at least 4 levels before asserting the ' +
        'home sync tile — a case-bound Deliver form adds a case list + case detail ' +
        'above the form list (ace#1494).',
    ).toBeGreaterThanOrEqual(4);
  });

  it('makes every back conditional, so the extra depth is a no-op when already home', () => {
    // If a `back` were unguarded, over-provisioning the count would pop past
    // the home surface and break the shallow leg. The guard is what makes the
    // floor above safe.
    const backs = [...yaml.matchAll(/^\s*- back\s*$/gm)].length;
    const guards = [...yaml.matchAll(/notVisible:/g)].length;
    expect(backs).toBeGreaterThan(0);
    expect(guards, 'every `back` in deliver-sync must sit inside a guarded runFlow').toBeGreaterThanOrEqual(backs);
  });

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

// ─────────────────────────────────────────────────────────────────────────
// CLASS-LEVEL PREVENTER — menu-container anchors must be display-mode-complete
//
// dimagi-internal/ace#1127. Two subsystems were each individually right and
// jointly broken: #1082/PR #1100 taught Phase 3 `app-hq-settings` to apply
// GRID menu display app-wide (correctly), while every Phase 6 menu anchor
// resolved to the LIST container `screen_suite_menu_list` alone. CommCare
// renders the SAME MenuActivity rows (`row_img` + `row_txt`) in either
// container — only the container's resource-id changes with the display
// setting — so the moment grid was applied, NO shipped palette recipe could
// execute. bednet-spot-check/20260731-1353: Learn halted at learn-launch's
// first menu assertion, Deliver walled the same way, Phase 6 wrote
// `verdict: blocked`. Blast radius was every ACE opportunity.
//
// The per-file edit is the instance fix. THIS is the fix: a display-mode
// change can no longer silently take out the palette, because any anchor
// naming one known menu container must name them all.
//
// Two rules, closing both the direct and the indirect path:
//
//   1. No palette file may hardcode a menu-container resource-id. The
//      indirection through the selector map is what makes "teach the palette
//      a new display mode" a ONE-LINE change. (deliver-form-walk.yaml had two
//      raw literals, which is precisely why the Deliver leg walled even
//      though its selector-map siblings could have been fixed centrally.)
//
//   2. Every selector-map row whose value mentions a menu container must
//      mention ALL of them. This is the rule the pre-fix map failed:
//      `learn-suite-menu` / `deliver-suite-menu` named only the ListView.
//
// Adding a third display mode = add its container id to KNOWN_MENU_CONTAINERS
// below; CI then goes red until every map row accepts it.
const KNOWN_MENU_CONTAINERS = [
  // ListView container — list menu display. Live-verified 2026-06-02
  // (2.63.0), bednet-spot-check/20260601-2009 Phase 6 Learn suite-root dump.
  'screen_suite_menu_list',
  // GridView container — grid menu display (what #1082 now applies app-wide).
  // Live-observed 2026-07-31 (2.63.0) in the FAILURE ui-dump of
  // bednet-spot-check/20260731-1353 Phase 6, quoted verbatim in that run's
  // app-screenshot-capture_verdict.yaml (Drive
  // 12dooLEt1CYS5XaKI8Y6PmOwAfQmvrBXyURVJxAApDj4): "Failure dump: container
  // is org.commcare.dalvik:id/grid_menu_grid (GridView)."
  'grid_menu_grid',
] as const;

/** Strip whole-line YAML comments — prose may legitimately name one container. */
function stripComments(yaml: string): string {
  return yaml
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
}

describe('menu-container anchors are display-mode-complete (ace#1127)', () => {
  const paletteFiles = readdirSync(STATIC_DIR).filter((n) => n.endsWith('.yaml'));
  const selectorMapFiles = readdirSync(SELECTORS_DIR).filter((n) => n.endsWith('.yaml'));

  it('the palette is non-empty and the selector maps were found (sanity)', () => {
    expect(paletteFiles.length).toBeGreaterThan(0);
    expect(selectorMapFiles.length).toBeGreaterThan(0);
  });

  it.each(paletteFiles)(
    '%s hardcodes no menu-container resource-id (must go through the selector map)',
    (filename) => {
      const body = stripComments(readFileSync(`${STATIC_DIR}${filename}`, 'utf8'));
      const hits = KNOWN_MENU_CONTAINERS.filter((id) => body.includes(id));
      expect(
        hits,
        `${filename}: hardcodes menu container(s) ${hits.join(', ')}. Reference ` +
          '`${SELECTOR:learn-suite-menu}` / `${SELECTOR:deliver-suite-menu}` instead so a ' +
          'display-mode change is a one-line selector-map edit (ace#1127).',
      ).toEqual([]);
    },
  );

  it.each(selectorMapFiles)(
    '%s: every menu-container selector row accepts EVERY known display mode',
    (filename) => {
      const map = parseYaml(readFileSync(`${SELECTORS_DIR}${filename}`, 'utf8')) as {
        selectors?: Record<string, { value?: string }>;
      };
      const failures: string[] = [];
      for (const [name, entry] of Object.entries(map.selectors ?? {})) {
        const value = entry?.value ?? '';
        const named = KNOWN_MENU_CONTAINERS.filter((id) => value.includes(id));
        // A row that mentions no menu container is not a menu anchor.
        if (named.length === 0) continue;
        const missing = KNOWN_MENU_CONTAINERS.filter((id) => !value.includes(id));
        if (missing.length > 0) {
          failures.push(
            `${name} = ${JSON.stringify(value)} accepts only [${named.join(', ')}] — ` +
              `missing [${missing.join(', ')}]`,
          );
        }
      }
      expect(
        failures,
        `${filename}: menu-container anchors must be display-mode-agnostic. Maestro matches ` +
          '`id:` as a regex (Filters.idMatches), so use an alternation covering every ' +
          'container — e.g. "org.commcare.dalvik:id/(screen_suite_menu_list|grid_menu_grid)". ' +
          'A single-container anchor silently kills the whole Phase 6 palette the moment the ' +
          'app ships the other display mode (ace#1127).',
      ).toEqual([]);
    },
  );

  it('every palette menu anchor RESOLVES to a display-mode-complete matcher', () => {
    // The end-to-end statement: whatever a palette file writes, what Maestro
    // actually receives must accept both containers. Catches an anchor that
    // routes through some third selector row nobody thought to audit.
    const failures: string[] = [];
    for (const filename of paletteFiles) {
      const raw = readFileSync(`${STATIC_DIR}${filename}`, 'utf8');
      if (!/\$\{SELECTOR:[a-z0-9-]+\}/.test(raw)) continue;
      const resolved = stripComments(resolveSelectorsInYaml(raw, '2.63.0').yaml);
      for (const line of resolved.split('\n')) {
        const named = KNOWN_MENU_CONTAINERS.filter((id) => line.includes(id));
        if (named.length === 0) continue;
        const missing = KNOWN_MENU_CONTAINERS.filter((id) => !line.includes(id));
        if (missing.length > 0) {
          failures.push(`${filename}: ${line.trim()} — missing [${missing.join(', ')}]`);
        }
      }
    }
    expect(
      failures,
      'resolved palette menu anchors must accept every known menu container (ace#1127)',
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CLASS-LEVEL PREVENTER — a positional `row_txt` tap must be a GUARDED
// FALLBACK, never the unconditional path
//
// dimagi-internal/ace#1138. `deliver-form-walk.yaml` tapped the FIRST
// `row_txt` row at each of its two menu levels and documented the choice as
// a "SINGLE-MODULE SMOKE assumption". That assumption is false for every ACE
// Deliver app that registers an entity and then files repeat visits against
// it, because ONE FORM PER MODULE IS A LOAD-BEARING ACE PATTERN: Connect
// dedups deliver units by module slug, so a registration form plus a payable
// followup is multi-module BY CONSTRUCTION. On
// spark-facilitator/20260731-0656 the walk entered `CBF Registration` and
// never reached `Community Meeting Record`, so `app-test-cases` could not
// author `journey-deliver.yaml` at all — Phase 6 got zero Deliver
// screenshots.
//
// The per-file edit is the instance fix. THIS is the fix: a positional row
// tap can no longer be the thing a recipe does by default. It has to sit
// inside a `runFlow` whose `when:` guard references a row-name variable —
// i.e. it may only run as the "no name was bound" fallback. A future palette
// recipe that reaches for "just tap row 1" goes red here instead of shipping
// another silent wrong-row walk.
//
// Deliberately NOT a ban on positional taps: the legacy single-module
// callers still need one, and removing it would be a breaking change to
// every shipped Deliver journey. The invariant is about REACHABILITY, not
// existence.
const ROW_TXT_RE = /row_txt/;
const ROW_NAME_VAR_RE = /\$\{(MODULE_NAME|FORM_NAME)\}/;

type PaletteStep = Record<string, unknown>;

/** Parse a recipe's step list (everything after the `---` front-matter separator). */
function parseSteps(yamlText: string): PaletteStep[] {
  const sepIdx = yamlText.search(/^---\s*$/m);
  if (sepIdx === -1) return [];
  const body = yamlText.slice(yamlText.indexOf('\n', sepIdx) + 1);
  const parsed = parseYaml(body);
  return Array.isArray(parsed) ? (parsed as PaletteStep[]) : [];
}

/**
 * Walk the step tree collecting every POSITIONAL `row_txt` tap — a `tapOn`
 * matching the row TextView by resource-id with no `text:` scoping, i.e. "tap
 * whichever row Maestro finds first". `guarded` records whether the tap sits
 * inside a `runFlow` whose `when:` clause references ${MODULE_NAME} /
 * ${FORM_NAME}.
 */
function collectPositionalRowTaps(
  steps: PaletteStep[] | undefined,
  guarded: boolean,
  out: { guarded: boolean }[],
): void {
  for (const step of steps ?? []) {
    if (!step || typeof step !== 'object') continue;
    for (const [key, value] of Object.entries(step)) {
      if (key === 'tapOn') {
        const sel = value as Record<string, unknown> | string | undefined;
        if (
          sel &&
          typeof sel === 'object' &&
          typeof sel.id === 'string' &&
          ROW_TXT_RE.test(sel.id) &&
          sel.text === undefined
        ) {
          out.push({ guarded });
        }
      } else if (key === 'runFlow') {
        const rf = value as { when?: unknown; commands?: PaletteStep[] } | undefined;
        if (!rf || typeof rf !== 'object') continue;
        const nameGuarded =
          guarded || ROW_NAME_VAR_RE.test(JSON.stringify(rf.when ?? null));
        collectPositionalRowTaps(rf.commands, nameGuarded, out);
      }
    }
  }
}

describe('positional row taps are name-scoped fallbacks only (ace#1138)', () => {
  const paletteFiles = readdirSync(STATIC_DIR).filter((n) => n.endsWith('.yaml'));

  it.each(paletteFiles)(
    '%s never taps a menu row positionally outside a ${MODULE_NAME}/${FORM_NAME} guard',
    (filename) => {
      const taps: { guarded: boolean }[] = [];
      collectPositionalRowTaps(parseSteps(readRecipe(filename)), false, taps);
      const unguarded = taps.filter((t) => !t.guarded).length;
      expect(
        unguarded,
        `${filename}: ${unguarded} positional \`row_txt\` tap(s) run unconditionally. ` +
          'Tapping "whichever row is first" walks into the WRONG module the moment the ' +
          'app has more than one — which every registration+followup Deliver app does by ' +
          'construction (ace#1138). Wrap it in a `runFlow` whose `when:` guard references ' +
          '${MODULE_NAME} or ${FORM_NAME}, so it can only fire as the no-name-bound fallback.',
      ).toBe(0);
    },
  );

  it('a positional row tap is guarded POSITIVELY on the menu still being on screen', () => {
    // Regression guard for the live failure on 2026-08-01
    // (spark-facilitator/20260731-0656, ace#1138 Gap 2 validation).
    //
    // deliver-form-walk's two Level-1 branches were a bare `visible` /
    // `notVisible` pair on the SAME predicate, evaluated in sequence. The
    // named branch TAPS AND NAVIGATES AWAY — at which point the module row is
    // no longer below the menu, so the fallback's `notVisible` guard flips
    // TRUE and it fires on whatever screen the tap just opened. On a followup
    // module that screen is the case list, which has no `row_txt` at all, so
    // the walk died on `Element not found: row_txt` one step after a
    // successful module tap.
    //
    // It survived PR #1154's tests because a REGISTRATION module happens to
    // hold the guard false by luck: its form list still renders a row carrying
    // the module's own name (form name == module name).
    //
    // The fix is the same one connect-resume-opp.yaml already encodes in
    // "Branch B guards POSITIVELY, not on btn_resume absence": require a
    // positive `visible:` precondition that a successful prior tap destroys.
    // Here that is the menu container itself.
    // `hasPositive` accumulates down the tree: a positive precondition on ANY
    // enclosing runFlow is enough, because Maestro evaluates the outer guard
    // first and skips the whole subtree when it is false. (deliver-form-walk's
    // Level-2 fallback relies on exactly that — its innermost guard is
    // notVisible-only, but the outer branch already requires the menu.)
    const failures: string[] = [];
    for (const filename of paletteFiles) {
      const steps = parseSteps(readRecipe(filename));
      const walk = (list: PaletteStep[] | undefined, hasPositive: boolean): void => {
        for (const step of list ?? []) {
          if (!step || typeof step !== 'object') continue;
          for (const [key, value] of Object.entries(step)) {
            if (key === 'tapOn') {
              const sel = value as Record<string, unknown> | string | undefined;
              const positional =
                sel &&
                typeof sel === 'object' &&
                typeof sel.id === 'string' &&
                ROW_TXT_RE.test(sel.id) &&
                sel.text === undefined;
              if (positional && !hasPositive) {
                failures.push(
                  `${filename}: positional row_txt tap has no positive \`visible:\` ` +
                    'precondition anywhere in its guard chain — a `notVisible`-only guard flips ' +
                    'TRUE the moment the branch above it taps and navigates away (ace#1138)',
                );
              }
            } else if (key === 'runFlow') {
              const rf = value as { when?: unknown; commands?: PaletteStep[] } | undefined;
              if (!rf || typeof rf !== 'object') continue;
              const when = rf.when as { visible?: unknown } | undefined | null;
              walk(rf.commands, hasPositive || (when != null && when.visible !== undefined));
            }
          }
        }
      };
      walk(steps, false);
    }
    expect(failures, 'ace#1138 — positional fallbacks need a positive guard').toEqual([]);
  });

  it('a palette that keeps a positional fallback also offers a name-scoped path', () => {
    // The guard above is satisfiable by burying the positional tap under an
    // unrelated guard. This is the other half: if a file taps rows at all, it
    // must actually be able to tap them BY NAME — otherwise the multi-module
    // case is still unauthorable, which was the substance of #1138.
    const failures: string[] = [];
    for (const filename of paletteFiles) {
      const resolved = readRecipe(filename);
      const taps: { guarded: boolean }[] = [];
      collectPositionalRowTaps(parseSteps(resolved), false, taps);
      if (taps.length === 0) continue;
      if (!ROW_NAME_VAR_RE.test(stripComments(resolved))) {
        failures.push(
          `${filename}: has a positional row tap but no ${'${MODULE_NAME}'}/${'${FORM_NAME}'} ` +
            'scoped tap — a multi-module app cannot be walked at all',
        );
      }
    }
    expect(failures, 'ace#1138').toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CLASS-LEVEL PREVENTER — a case-list row tap must be NAME-MATCHED and
// CONTAINER-SCOPED, never positional and never unscoped
//
// dimagi-internal/ace#1138 Gap 2. `deliver-case-select.yaml` crosses
// CommCare's EntitySelectActivity, which a `followup` form renders between
// the module row and the form. Two traps live on that surface, both read
// straight off the live 2.63.2 ui-dump captured 2026-08-01:
//
//   1. The COLUMN-HEADER strip (`entity_select_header`) renders one
//      `entity_view_text` per column — the SAME resource-id the data rows
//      use — so an unscoped match can resolve to a non-clickable header cell.
//   2. The TOOLBAR carries the MODULE name (the ace#590 anti-toolbar class).
//
// And unlike a menu row, a WRONG case tap does not fail one screen later: the
// form opens and submits happily against the wrong entity, which for a payable
// deliver unit means a payment keyed to the wrong `entity_id`. Hence the rule
// here is strictly stronger than the `row_txt` one above — a positional tap is
// BANNED outright rather than merely required to be guarded.
//
// The case-list rows exist only from connect-2.63.2.yaml onward (that is the
// map that was calibrated live), so this block resolves against 2.63.2 rather
// than the 2.63.0 the older blocks use.
const CASE_LIST_APK = '2.63.2';

function readRecipeAt(name: string, apk: string): string {
  return resolveSelectorsInYaml(readFileSync(`${STATIC_DIR}${name}`, 'utf8'), apk).yaml;
}

/**
 * True when `yaml` contains a `tapOn` that matches the case-list cell id
 * WITHOUT scoping it to the case-list container — i.e. a tap that a column
 * header could satisfy. This is the predicate the invariant is built on; it is
 * exercised against a synthetic pre-fix recipe below so the assertion is
 * demonstrably non-vacuous.
 */
function hasUnscopedCaseCellTap(yaml: string, cellId: string, containerId: string): boolean {
  const steps = parseSteps(yaml);
  let found = false;
  const walk = (list: PaletteStep[] | undefined): void => {
    for (const step of list ?? []) {
      if (!step || typeof step !== 'object') continue;
      for (const [key, value] of Object.entries(step)) {
        if (key === 'tapOn') {
          const sel = value as Record<string, unknown> | string | undefined;
          if (!sel || typeof sel !== 'object') continue;
          const touchesCell =
            (typeof sel.id === 'string' && sel.id.includes(cellId)) ||
            typeof sel.text === 'string';
          if (!touchesCell) continue;
          const scope = JSON.stringify(sel.childOf ?? sel.below ?? null);
          if (!scope.includes(containerId)) found = true;
        } else if (key === 'runFlow') {
          const rf = value as { commands?: PaletteStep[] } | undefined;
          if (rf && typeof rf === 'object') walk(rf.commands);
        }
      }
    }
  };
  walk(steps);
  return found;
}

describe('deliver-case-select.yaml (ace#1138 Gap 2)', () => {
  const map = selectorMap(CASE_LIST_APK).selectors;
  const yaml = readRecipeAt('deliver-case-select.yaml', CASE_LIST_APK);

  it('the 2.63.2 map carries every live-calibrated case-list row', () => {
    // These four rows ARE the calibration. If one goes missing the recipe
    // silently stops resolving and the followup leg is unauthorable again.
    for (const name of [
      'case-list-container',
      'case-list-header',
      'case-list-row-cell',
      'case-list-detail-continue',
    ]) {
      expect(map[name], `connect-${CASE_LIST_APK}.yaml must define ${name}`).toBeDefined();
      expect(
        map[name].unverified,
        `${name} was captured from a live device dump — it must not be flagged unverified`,
      ).toBeUndefined();
    }
    // The header and the row cell genuinely share an id on this surface. That
    // collision is the whole reason the scoping rule exists, so pin it: if a
    // future APK separates them, this test should force a re-read of the rule
    // rather than let it quietly become cargo-cult.
    expect(map['case-list-row-cell'].value).toBe('org.commcare.dalvik:id/entity_view_text');
  });

  it('taps the case row BY NAME and scoped to the case-list container', () => {
    const containerId = map['case-list-container'].value;
    expect(yaml, 'expected a ${CASE_NAME}-matched tap scoped childOf the case-list body').toMatch(
      new RegExp(
        `- tapOn:\\s*\\n\\s*text: "\\$\\{CASE_NAME\\}"\\s*\\n\\s*childOf:\\s*\\n\\s*id: "${escapeRe(
          containerId,
        )}"`,
      ),
    );
  });

  it('never taps a case row positionally', () => {
    // Stronger than the row_txt rule: no guarded-fallback escape hatch. A
    // wrong-case tap is SILENT (the form opens against the wrong entity), and
    // the container also holds a trailing "SEARCH" action_card, so "the first
    // clickable child" is not even reliably a case.
    const steps = parseSteps(yaml);
    const positional: string[] = [];
    const walk = (list: PaletteStep[] | undefined): void => {
      for (const step of list ?? []) {
        if (!step || typeof step !== 'object') continue;
        for (const [key, value] of Object.entries(step)) {
          if (key === 'tapOn') {
            const sel = value as Record<string, unknown> | string | undefined;
            if (
              sel &&
              typeof sel === 'object' &&
              typeof sel.id === 'string' &&
              sel.id.includes(map['case-list-row-cell'].value) &&
              sel.text === undefined
            ) {
              positional.push(JSON.stringify(sel));
            }
          } else if (key === 'runFlow') {
            const rf = value as { commands?: PaletteStep[] } | undefined;
            if (rf && typeof rf === 'object') walk(rf.commands);
          }
        }
      }
    };
    walk(steps);
    expect(positional, 'a case row must never be tapped positionally (ace#1138)').toEqual([]);
  });

  it('crosses the case-DETAIL confirmation screen under a guard', () => {
    // Live-discovered 2026-08-01: tapping a case row does NOT open the form
    // when the module declares a case-list `details` block (every ACE-built
    // Deliver module does). CommCare shows a per-case detail screen whose
    // CONTINUE button is what proceeds. A recipe transcribed from a sibling
    // APK, or guessed, would stop dead here — which is exactly what ace#1138
    // meant by "needs live-device calibration".
    const continueId = map['case-list-detail-continue'].value;
    expect(yaml, 'expected a guarded tap on the detail CONTINUE button').toMatch(
      new RegExp(
        `when:\\s*\\n\\s*visible:\\s*\\n\\s*id: "${escapeRe(continueId)}"[\\s\\S]*?` +
          `- tapOn:\\s*\\n\\s*id: "${escapeRe(continueId)}"`,
      ),
    );
  });

  it('fails loud on a no-op tap by asserting the case list is GONE', () => {
    // And deliberately NOT by asserting any particular next screen: with a
    // `details` block the next screen is the module's form list, without one it
    // can be the form itself. An earlier draft asserted `nav_btn_next` here and
    // failed live against the form list.
    const containerId = map['case-list-container'].value;
    expect(yaml, 'expected a fail-loud notVisible assertion on the case list').toMatch(
      new RegExp(
        `- extendedWaitUntil:\\s*\\n\\s*notVisible:\\s*\\n\\s*id: "${escapeRe(containerId)}"`,
      ),
    );
    // Strip comments: the header legitimately NAMES nav_btn_next to explain
    // why asserting it here was wrong. It is the executable steps that must
    // not contain it.
    expect(
      stripComments(yaml),
      'the form assertion belongs to deliver-form-walk (after Level 2), not here — ' +
        'after CONTINUE the device is on the FORM LIST, not the form',
    ).not.toContain('nav_btn_next');
  });

  it('the scoping assertion is NON-VACUOUS — an unscoped tap is detected', () => {
    // Proves the rule has teeth rather than passing because nothing matches.
    // The shipped recipe is clean; the synthetic pre-fix shape is not.
    const containerId = map['case-list-container'].value;
    const cellId = map['case-list-row-cell'].value;

    expect(
      hasUnscopedCaseCellTap(yaml, cellId, containerId),
      'the shipped recipe must scope its case tap',
    ).toBe(false);

    const unscoped = [
      'appId: org.commcare.dalvik',
      '---',
      '- tapOn:',
      '    text: "${CASE_NAME}"',
      '',
    ].join('\n');
    expect(
      hasUnscopedCaseCellTap(unscoped, cellId, containerId),
      'a bare `tapOn: text: ${CASE_NAME}` must be REJECTED — it can resolve to a ' +
        'column-header cell or the toolbar title',
    ).toBe(true);
  });
});

describe('deliver-form-walk.yaml composes the case list in the right ORDER (ace#1138)', () => {
  const yaml = readRecipeAt('deliver-form-walk.yaml', CASE_LIST_APK);

  it('hands off to deliver-case-select BEFORE the Level-2 form-row branches', () => {
    // CommCare collects the CASE BEFORE THE FORM:
    //   module row -> case list -> detail -> CONTINUE -> form list -> form
    // so the case handoff must sit between Level 1 and Level 2. Live-proven
    // 2026-08-01: with the handoff placed AFTER Level 2 the walk selected the
    // case correctly and then stalled on the untapped form list, because
    // Level 2 had already run and skipped (its `visible: <menu>` guard is
    // false while the case list is up).
    const handoffIdx = yaml.indexOf('file: deliver-case-select.yaml');
    expect(handoffIdx, 'expected deliver-form-walk to compose deliver-case-select').toBeGreaterThan(
      -1,
    );

    // Anchor on content rather than a comment: this screenshot is taken inside
    // Level-2 branch 2a, so it marks where the form-row handling begins.
    const level2Idx = yaml.indexOf('takeScreenshot: "deliver-form-walk-form-list"');
    expect(level2Idx, 'expected the Level-2 form-list screenshot').toBeGreaterThan(-1);

    expect(
      handoffIdx,
      'the case-select handoff must precede the Level-2 form-row branches — CommCare ' +
        'shows the case list BEFORE the form list (ace#1138)',
    ).toBeLessThan(level2Idx);
  });

  it('guards the handoff so non-case (registration) modules are unaffected', () => {
    const containerId = selectorMap(CASE_LIST_APK).selectors['case-list-container'].value;
    expect(yaml).toMatch(
      new RegExp(
        `when:\\s*\\n\\s*visible:\\s*\\n\\s*id: "${escapeRe(containerId)}"[\\s\\S]*?` +
          'file: deliver-case-select\\.yaml',
      ),
    );
  });
});

/**
 * dimagi-internal/ace#1191 — the canonical two-leg Deliver sequence in
 * `app-test-cases` cannot execute, and nothing said so.
 *
 * This runs the chain linter over the REAL palette files rather than a
 * fixture, so the assertion tracks what is actually checked in. The palette
 * entry that fixes the gap (`deliver-home-reentry.yaml`) needs live-device
 * validation and is deliberately not in this change — what ships is the
 * preventer, so the SKILL cannot go back to teaching a sequence whose own
 * recipes do not meet.
 */
describe('two-leg Deliver chain continuity (#1191)', () => {
  const read = (name: string) => readFileSync(`${STATIC_DIR}${name}`, 'utf8');

  it('the un-bridged two-leg sequence does NOT connect', async () => {
    const { checkChainContinuity } = await import('../../../lib/recipe-state-contract.js');
    const r = checkChainContinuity([
      { recipe: 'deliver-form-walk.yaml', text: read('deliver-form-walk.yaml') },
      { recipe: 'form-submit.yaml', text: read('form-submit.yaml') },
      { recipe: 'deliver-form-walk.yaml', text: read('deliver-form-walk.yaml') },
    ]);
    expect(r.ok, 'if this ever passes un-bridged, the palette changed — re-read #1191').toBe(false);
  });

  it('form-submit is the step that cannot be shown to land anywhere', async () => {
    const { parseStateContract } = await import('../../../lib/recipe-state-contract.js');
    const c = parseStateContract(read('form-submit.yaml'));
    // Its header says "Post-state: depends on the form ... Deliver forms (TBD)".
    expect(c.postIsUndetermined).toBe(true);
  });

  it('deliver-form-walk requires the Deliver home, which is why the gap bites', async () => {
    const { parseStateContract, anchorsIn } = await import('../../../lib/recipe-state-contract.js');
    const c = parseStateContract(read('deliver-form-walk.yaml'));
    expect(anchorsIn(c.pre)).toEqual(expect.arrayContaining(['deliver-home-job-card']));
  });
});

/**
 * dimagi-internal/ace#1291 — `form-advance.yaml` tapped `nav_btn_next` and
 * THEN took its screenshot, so every frame was saved under the name of the
 * screen it had just LEFT while showing the one it advanced TO.
 *
 * Verified visually on bednet-check-2-visit/20260814-0357, Learn leg:
 *
 *   journey-learn-m1-intro.png        held the b1 question, not the intro
 *   journey-learn-m2-t2-payment.png   held t3, not t2
 *
 * — a systematic one-screen offset across all 8 teaching screens and every
 * `*-answered` step.
 *
 * It matters because the manifest is the input contract for
 * `training-flw-guide` and `training-deck-generate`, both of which caption
 * slides and steps BY STEP NAME. A deck built from that manifest asserts the
 * wrong screen for every advance-derived frame — the ace#866 class (presenting
 * frames as moments they are not), and invisible unless someone opens the
 * PNGs. Capturing first also means the FIRST screen of a form is finally
 * captured under its own name.
 */
describe('form-advance captures BEFORE it advances (#1291)', () => {
  const steps = () => {
    const text = readFileSync(`${STATIC_DIR}form-advance.yaml`, 'utf8');
    const body = text.split(/^---$/m).slice(1).join('---');
    return parseYaml(body) as Array<Record<string, unknown>>;
  };

  it('takeScreenshot is the FIRST step, before any tap', () => {
    const s = steps();
    expect(Object.keys(s[0])[0]).toBe('takeScreenshot');
  });

  it('the tap comes after the capture', () => {
    const s = steps();
    const shot = s.findIndex((x) => 'takeScreenshot' in x);
    const tap = s.findIndex((x) => 'tapOn' in x);
    expect(shot).toBeGreaterThanOrEqual(0);
    expect(tap).toBeGreaterThan(shot);
  });

  it('still binds the caller-supplied name (the ace#1033 guard is intact)', () => {
    const s = steps();
    expect(s[0].takeScreenshot).toBe('${SCREENSHOT_NAME}');
  });

  it('still advances via the resource-id selector, not a text match', () => {
    const raw = readFileSync(`${STATIC_DIR}form-advance.yaml`, 'utf8');
    expect(raw).toMatch(/\$\{SELECTOR:form-nav-next\}/);
  });
});

// ---------------------------------------------------------------------------
// Tile-discovery scroll budget parity (dimagi-internal/ace#1289).
//
// The defect #1289 names is DRIFT, not a wrong number. connect-claim-opp.yaml
// was recalibrated by #647 (2026-06-01) and again by #800; connect-resume-opp
// .yaml received neither and sat on the pre-#647 defaults (timeout 20000,
// visibilityPercentage 60, no explicit speed) for two and a half months. Two
// recipes that solve the same problem — find the target opp's tile in an
// unbounded, ever-growing list — silently diverged, and only the un-tuned one
// failed.
//
// So the invariant is not "the numbers are >= X" alone; it is "both recipes
// carry the SAME budget". A future tuner who raises one and forgets the other
// fails here.
//
// Direction note, because it is counter-intuitive and was got wrong once:
// raising `speed` does NOT buy depth. A faster fling overshoots the matcher
// between samples, so depth is bought with `timeout`. #1289 lowered speed
// 80 -> 40 and raised timeout 40000 -> 120000; that pair is the live-proven
// one (bednet-check-2-visit/20260814-0357).
// ---------------------------------------------------------------------------
// The live-proven tile-discovery budget. ONE constant, asserted by
// identity against every tile scroll in every tile-finding recipe.
//
// Parity used to be INFERRED (`new Set(budgets).size === 1`), which would
// have passed if a future tuner changed BOTH recipes to a non-proven pair.
// Naming the triple makes the budget structural: a change to it is a change
// to this line, reviewed as such, and has to cite its own device evidence.
//
// Provenance: run on-device 2026-08-14, bednet-check-2-visit/20260814-0357.
// The scroll reported COMPLETED, the assert COMPLETED, and the Learn leg
// then walked green (Connect: learn_complete: true).
const LIVE_PROVEN_TILE_BUDGET = { speed: 40, timeout: 120000, visibility: 30 };

describe('tile-discovery scroll budgets stay in lockstep (#1289)', () => {
  const RECIPES = ['connect-claim-opp.yaml', 'connect-resume-opp.yaml'];

  /**
   * Every `scrollUntilVisible` that hunts the run-id tile, with its budget.
   *
   * Split-on-keyword rather than one big lookahead regex. The original form
   * bounded each block with a fixed `[\s\S]{0,400}` window, which is a
   * silent-zero-match hazard the moment blocks get nested (the #1289
   * fallback re-hunt lives inside a `runFlow`, adding indentation and two
   * more keys) — and widening the window instead lets one block reach
   * FORWARD into the next block's matcher and mis-attribute a budget.
   * Splitting has neither failure mode, and the match count is asserted
   * explicitly below so an empty set can never read as a pass.
   */
  function tileScrolls(yamlText: string) {
    const out: { speed: number; timeout: number; visibility: number }[] = [];
    // Comment prose in these recipes legitimately quotes keys
    // (`# WHY `direction: UP` ...`, `# `optional: true` ...`), so strip it.
    const code = yamlText
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    for (const raw of code.split(/scrollUntilVisible:/).slice(1)) {
      // One block ends where the next step (`- ...`) or a column-0 line begins.
      const body: string[] = [];
      for (const line of raw.split('\n')) {
        if (/^\s*-\s/.test(line)) break;
        if (line.trim() !== '' && /^\S/.test(line)) break;
        body.push(line);
      }
      const blk = body.join('\n');
      // Only the run-id hunts. The fallback's section anchor
      // ("New Opportunities") is a different step with a different contract:
      // it deliberately omits `centerElement`, so it must not be judged here.
      if (!/text:\s*"\.\*\$\{OPP_RUN_ID\}\.\*"/.test(blk)) continue;
      out.push({
        speed: Number(blk.match(/speed:\s*(\d+)/)?.[1] ?? NaN),
        timeout: Number(blk.match(/timeout:\s*(\d+)/)?.[1] ?? NaN),
        visibility: Number(blk.match(/visibilityPercentage:\s*(\d+)/)?.[1] ?? NaN),
      });
    }
    return out;
  }

  it('every tile scroll declares an explicit budget (no silent Maestro defaults)', () => {
    // The pre-#647 resume recipe omitted `speed` entirely, which is how it
    // drifted invisibly — an absent key reads as "fine" in review.
    for (const r of RECIPES) {
      const scrolls = tileScrolls(readRecipe(r));
      expect(scrolls.length, `${r}: expected at least one run-id tile scroll`).toBeGreaterThan(0);
      scrolls.forEach((s, i) => {
        expect(s.speed, `${r} scroll ${i}: missing explicit speed`).not.toBeNaN();
        expect(s.timeout, `${r} scroll ${i}: missing explicit timeout`).not.toBeNaN();
        expect(s.visibility, `${r} scroll ${i}: missing explicit visibilityPercentage`).not.toBeNaN();
      });
    }
  });

  it('every tile scroll equals the ONE live-proven budget constant', () => {
    // Stronger than the parity check this replaces. Parity alone
    // (`new Set(budgets).size === 1`) would pass if a future tuner changed
    // BOTH recipes to a pair no device has ever run. Identity against a
    // single named constant makes the budget structural: it is one line,
    // and moving it is a reviewable act that must carry its own evidence.
    for (const r of RECIPES) {
      const scrolls = tileScrolls(readRecipe(r));
      expect(scrolls.length, `${r}: expected at least one run-id tile scroll`).toBeGreaterThan(0);
      scrolls.forEach((s, i) => {
        expect(
          s,
          `${r} scroll ${i}: every tile-finding scroll must carry LIVE_PROVEN_TILE_BUDGET. ` +
            `#1289: resume-opp missed the #647 recalibration entirely because nothing pinned ` +
            `the two recipes together, and nothing pinned either to a device-observed value.`,
        ).toEqual(LIVE_PROVEN_TILE_BUDGET);
      });
    }
  });

  it('every tile-finding recipe has a fallback re-hunt after its primary scroll', () => {
    // ace#1289 second clause. The primary scroll is O(unbounded invite
    // list) and the list grows one card per /ace:run — accepted
    // OpportunityAccess rows are unprunable (lib/invite-pruning.ts:88-91),
    // so a single fixed budget re-exhausts on a schedule. Each recipe
    // therefore gets a second, guarded pass.
    for (const r of RECIPES) {
      const yaml = readRecipe(r);
      const code = yaml
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');

      // (1) The PRIMARY run-id scroll is optional, so an exhausted budget
      //     reaches the fallback instead of aborting the flow.
      const primaryIdx = code.search(
        /-\s*scrollUntilVisible:\s*\n\s*element:\s*\n\s*text: "\.\*\$\{OPP_RUN_ID\}\.\*"/,
      );
      expect(primaryIdx, `${r}: expected a primary run-id scroll`).toBeGreaterThan(-1);
      const primaryBlock = code.slice(primaryIdx).split(/\n-\s/)[0];
      expect(
        primaryBlock,
        `${r}: the primary tile scroll must be \`optional: true\` — otherwise an exhausted ` +
          `budget aborts the flow and the fallback re-hunt is unreachable`,
      ).toMatch(/optional: true/);

      // (2) A runFlow guarded on the tile being ABSENT follows it.
      const fallbackIdx = code.indexOf('- runFlow:', primaryIdx);
      expect(fallbackIdx, `${r}: expected a fallback runFlow after the primary scroll`).toBeGreaterThan(-1);
      const fallback = code.slice(fallbackIdx).split(/\n#/)[0];
      expect(
        fallback,
        `${r}: the fallback must be guarded on \`notVisible\` of the run-id tile — ` +
          `an unguarded second scroll would run on the happy path and destroy the centering (#800)`,
      ).toMatch(/when:\s*\n\s*notVisible:\s*\n\s*text: "\.\*\$\{OPP_RUN_ID\}\.\*"/);

      // (3) …and it re-hunts the run-id tile inside that guard.
      expect(
        fallback.split(/commands:/)[1] ?? '',
        `${r}: the fallback body must contain a second run-id scrollUntilVisible`,
      ).toMatch(/scrollUntilVisible:[\s\S]*?text: "\.\*\$\{OPP_RUN_ID\}\.\*"/);
    }
  });

  it('the final run-id scroll is the last viewport-moving step before the branch guards', () => {
    // The #800 / 2026-07-29 invariant this change is closest to breaking:
    // whatever scrolls last must leave the whole card (title + CTA) in the
    // viewport, or the card-scoped `below:` / `childOf` guards evaluate
    // false and the recipe SKIPs on a perfectly claimable tile.
    for (const r of RECIPES) {
      const code = readRecipe(r)
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');

      // The first guard that scopes itself to this run's tile — i.e. the
      // start of the branch region the centering must survive into.
      let guardIdx = -1;
      for (const m of code.matchAll(/-\s*runFlow:/g)) {
        const when = code.slice(m.index!).split(/commands:/)[0];
        if (/\$\{OPP_RUN_ID\}/.test(when) && !/notVisible:/.test(when)) {
          guardIdx = m.index!;
          break;
        }
      }
      expect(guardIdx, `${r}: expected a card-scoped branch guard`).toBeGreaterThan(-1);

      const pre = code.slice(0, guardIdx);
      const lastScrollIdx = pre.lastIndexOf('scrollUntilVisible:');
      expect(lastScrollIdx, `${r}: expected a tile scroll before the branch guards`).toBeGreaterThan(-1);

      const lastScroll = pre.slice(lastScrollIdx);
      expect(
        lastScroll,
        `${r}: the last scroll before the branch guards must hunt the run-id tile`,
      ).toMatch(/text: "\.\*\$\{OPP_RUN_ID\}\.\*"/);
      expect(
        lastScroll,
        `${r}: the last scroll before the branch guards must set \`centerElement: true\` (#800)`,
      ).toMatch(/centerElement: true/);

      const after = pre.slice(lastScrollIdx + 'scrollUntilVisible:'.length);
      expect(
        after,
        `${r}: nothing may scroll/swipe between the centered run-id scroll and the branch guards`,
      ).not.toMatch(/(scrollUntilVisible|swipe|scroll):/);
    }
  });

  it('the budget is the live-proven one, and speed is not raised to buy depth', () => {
    const all = RECIPES.flatMap((r) => tileScrolls(readRecipe(r)));
    for (const s of all) {
      expect(
        s.timeout,
        'depth is bought with TIME: >=120s, live-proven on bednet-check-2-visit/20260814-0357',
      ).toBeGreaterThanOrEqual(120000);
      expect(
        s.speed,
        'a faster fling overshoots the matcher between samples — speed must stay <=40',
      ).toBeLessThanOrEqual(40);
      expect(
        s.visibility,
        'a wrapped multi-line title may never present 60% of itself; <=30 keeps it matchable',
      ).toBeLessThanOrEqual(30);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CLASS-LEVEL PREVENTER — a Learn finalize/re-entry PAIR must agree on the
// surface between them, and the skill must name the discriminator
//
// dimagi-internal/ace#1566 (the finalize half of #1071). `app-test-cases`
// carried two sibling sections that disagreed. § Suite re-entry between
// modules branched on `get_form().post_submit` (that was the #1071 fix);
// § Multi-screen content forms prescribed `content-form-finish.yaml`
// UNCONDITIONALLY. But `content-form-finish.yaml` guards its whole bounded
// advance loop on `notVisible: learn-home-start-tile` and terminates on
// `assertVisible: learn-home-start-tile` — a home-grid surface that is
// simply not where a `post_submit: previous` form (Nova's default) lands.
// It finalizes to the module's own form list, one level inside the suite.
//
// Cost: the walk burns its 12 bounded advance slots doing nothing and dies
// on `Assertion is false: "Start" is visible` — Learn never reaches 100%,
// Connect never unlocks Deliver, Phase 6 lands `verdict: blocked` with zero
// Deliver screenshots. Live on bednet-check-2-visit/20260820-0832 (2
// modules, 5 forms, all `previous`); the re-entry half of the same
// signature was live on spark-facilitator/20260728-1338 (#1071).
//
// The prose fix is the instance fix. THIS is the class fix, and it is
// DERIVED from the palette rather than restated:
//
//   1. A finalize recipe's EXIT anchor is its LAST ${SELECTOR:…}; a
//      re-entry recipe's ENTRY anchor is its FIRST. A composed pair is
//      correct iff those two anchors are the same surface. Any yaml block
//      in the skill that chains a mismatched pair is the #1071/#1566 bug,
//      whichever half is wrong.
//   2. The home-anchored finalize is only ever correct for one value of
//      `post_submit`, so any section prescribing it must name the field AND
//      name the counterpart recipe — otherwise an author reading that
//      section alone routes a `previous` app into a recipe that cannot
//      terminate, which is exactly what happened.
//
// Adding a third Learn shape = add its finalize/re-entry pair to the
// palette; the derivation picks it up and this stays honest.
// ─────────────────────────────────────────────────────────────────────────
describe('home-anchored finalize is post_submit-gated (ace#1566)', () => {
  const SKILL_PATH = fileURLToPath(
    new URL('../../../skills/app-test-cases/SKILL.md', import.meta.url),
  );
  const skill = readFileSync(SKILL_PATH, 'utf8');

  const FINALIZE_RECIPES = ['content-form-finish.yaml', 'content-form-finish-to-suite.yaml'];
  const REENTRY_RECIPES = ['learn-suite-reentry.yaml', 'learn-suite-reentry-from-module.yaml'];

  /** Every selector placeholder in a palette file, comments stripped, in order. */
  function selectorRefs(filename: string): string[] {
    const body = stripComments(readFileSync(`${STATIC_DIR}${filename}`, 'utf8'));
    return [...body.matchAll(/\$\{SELECTOR:([a-z0-9-]+)\}/g)].map((m) => m[1]);
  }

  /** Where the recipe leaves the device: its last selector reference. */
  const exitAnchor = (f: string) => selectorRefs(f).at(-1)!;
  /** What the recipe expects on entry: its first selector reference. */
  const entryAnchor = (f: string) => selectorRefs(f)[0];

  it('the two finalize recipes leave the device on DIFFERENT surfaces (sanity)', () => {
    expect(exitAnchor('content-form-finish.yaml')).toBe('learn-home-start-tile');
    expect(exitAnchor('content-form-finish-to-suite.yaml')).toBe('learn-suite-menu');
  });

  it('the two re-entry recipes expect DIFFERENT surfaces on entry (sanity)', () => {
    expect(entryAnchor('learn-suite-reentry.yaml')).toBe('learn-home-start-tile');
    expect(entryAnchor('learn-suite-reentry-from-module.yaml')).toBe('learn-suite-menu');
  });

  it('every finalize-to-re-entry pair the skill composes agrees on the surface between them', () => {
    const blocks = [...skill.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);
    const composed = (block: string, recipe: string) => block.includes(`file: ${recipe}`);

    let checked = 0;
    for (const block of blocks) {
      const finalize = FINALIZE_RECIPES.filter((r) => composed(block, r));
      const reentry = REENTRY_RECIPES.filter((r) => composed(block, r));
      if (finalize.length === 0 || reentry.length === 0) continue;

      expect(
        finalize.length,
        `a yaml block composes two finalize recipes (${finalize.join(', ')}) — one block, one shape`,
      ).toBe(1);
      expect(
        reentry.length,
        `a yaml block composes two re-entry recipes (${reentry.join(', ')}) — one block, one shape`,
      ).toBe(1);

      checked += 1;
      expect(
        entryAnchor(reentry[0]),
        `${finalize[0]} leaves the device on \`${exitAnchor(finalize[0])}\`, but the ` +
          `${reentry[0]} chained after it opens by waiting on ` +
          `\`${entryAnchor(reentry[0])}\`. That wait can never fire — this is the ` +
          'ace#1071 / ace#1566 hang. Pair the finalize and re-entry halves that share a ' +
          'surface, and pick BOTH from `get_form().post_submit`.',
      ).toBe(exitAnchor(finalize[0]));
    }

    expect(
      checked,
      'no yaml block in app-test-cases composes a finalize + re-entry pair — the ' +
        'per-module Learn loop template has moved or been deleted; re-point this rail',
    ).toBeGreaterThanOrEqual(2);
  });

  it('every section prescribing the home-anchored finalize names post_submit and its counterpart', () => {
    // Split on markdown headings of any depth; a "prescription" is a runFlow
    // composition (`file: <recipe>`), not a passing mention in a palette list.
    const sections = skill.split(/\n(?=#{2,6} )/);
    const prescribing = sections.filter((s) => s.includes('file: content-form-finish.yaml'));

    expect(
      prescribing.length,
      'no section composes content-form-finish.yaml — the rail has lost its target',
    ).toBeGreaterThan(0);

    for (const section of prescribing) {
      const heading = section.split('\n')[0].trim();
      expect(
        section,
        `${heading}: composes the home-anchored \`content-form-finish.yaml\` without naming ` +
          '`post_submit`. It only terminates on a `post_submit: module` app; on `previous` ' +
          "(Nova's default) the finalize lands on the module form list and the recipe's " +
          'terminal home assert cannot fire (ace#1566).',
      ).toContain('post_submit');
      expect(
        section,
        `${heading}: names the home-anchored finalize but not the \`previous\` counterpart ` +
          '`content-form-finish-to-suite.yaml`, so an author reading this section alone has ' +
          'nowhere to route a `post_submit: previous` app (ace#1566).',
      ).toContain('content-form-finish-to-suite.yaml');
    }
  });
});
