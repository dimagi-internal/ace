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
    const scrollBlocks = [
      ...yaml.matchAll(
        /- scrollUntilVisible:\s*\n\s*element:\s*\n([\s\S]*?)\n\s*direction:/g,
      ),
    ];
    expect(scrollBlocks.length, 'expected one scrollUntilVisible per branch').toBeGreaterThanOrEqual(2);
    for (const m of scrollBlocks) {
      const elementClause = m[1];
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
});
