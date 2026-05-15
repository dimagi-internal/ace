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

  it('anchors scrollUntilVisible on btn_view_opportunity (not just the title text)', () => {
    // Regression guard for the 2026-05-15 turmeric run halt: anchoring
    // scrollUntilVisible on `text:${OPP_NAME}` alone left the button
    // beneath the title clipped off-screen, so the subsequent
    // `tapOn(id:btn_view_opportunity, below:text:${OPP_NAME})` matched a
    // node that wasn't actually rendered. Driving the scroll by the
    // element we need to tap is the structural fix.
    //
    // Match the scrollUntilVisible block and assert its `element:` clause
    // targets the button id.
    const scrollBlock = yaml.match(
      /- scrollUntilVisible:\s*\n\s*element:\s*\n([\s\S]*?)\n\s*direction:/,
    );
    expect(scrollBlock, 'scrollUntilVisible block not found').toBeTruthy();
    const elementClause = scrollBlock![1];
    expect(elementClause).toContain('id: "org.commcare.dalvik:id/btn_view_opportunity"');
    // Card-scoping must still pin to OPP_NAME so a stale prior-run invite
    // higher in the list isn't matched first.
    expect(elementClause).toContain('below:');
    expect(elementClause).toContain('text: ${OPP_NAME}');
  });

  it('still scopes the final tapOn to the OPP_NAME card', () => {
    // The `below: text: ${OPP_NAME}` scoping on the tapOn is the original
    // safeguard against tapping a stale prior-run invite. Keep it.
    expect(yaml).toMatch(
      /- tapOn:\s*\n\s*id: "org\.commcare\.dalvik:id\/btn_view_opportunity"\s*\n\s*below:\s*\n\s*text: \$\{OPP_NAME\}/,
    );
  });
});
