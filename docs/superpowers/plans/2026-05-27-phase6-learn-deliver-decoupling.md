# Phase 6 Learn/Deliver Decoupling + Deliver-Recipe Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Phase 6 capture Learn screenshots independently of Deliver (per-app legs + per-app verdicts), give recipes descriptive `journey-<app>` names, and restructure the Deliver smoke from an 80-step Learn-re-walk monolith into a short resume-from-unlocked recipe — so a Deliver gap never suppresses Learn and is clearly attributed.

**Architecture:** Three staged PRs against the ACE plugin. PR1 renames the recipe convention (mechanical). PR2 splits capture into independent Learn/Deliver legs with per-app verdicts and a per-app pre-flight. PR3 changes the `app-test-cases` composition contract (Learn-to-completion + Deliver-resume), adds a static anti-monolith probe check, and verifies end-to-end on a live AVD (selectors already calibrated 2026-05-26).

**Tech Stack:** TypeScript (`mcp/mobile/*.ts`, `lib/*.ts`) + vitest; Markdown skill/agent docs; Maestro YAML recipes; `ace-mobile` / `ace-gdrive` / `nova` MCP atoms.

**Spec:** `docs/superpowers/specs/2026-05-27-phase6-learn-deliver-decoupling-design.md`

---

## PR 1 — Naming convention

Rename the recipe convention from journey-id files (`J<n>.yaml`) to app-prefixed descriptive files (`journey-learn.yaml`, `journey-deliver.yaml`, `journey-<app>-<slug>.yaml`). Also fix the stale `app-test-cases/recipes/` path (should be `3-commcare/recipes/`). Pure convention/doc change; no runtime behavior change.

### Task 1.1: Fix the template's recipe paths + naming

**Files:**
- Modify: `templates/app-test-cases-template.yaml:29` (and any other `recipe_path` lines)

- [ ] **Step 1: Update `recipe_path` values**

Change every `recipe_path: app-test-cases/recipes/J<n>.yaml` to the new scheme. The smoke entries use the bare app name; non-smoke entries append a slug derived from `name`. For the template's J1 (typically the Learn smoke):

```yaml
    recipe_path: 3-commcare/recipes/journey-learn.yaml
```

Add a comment above `journeys:` documenting the convention:

```yaml
# recipe_path convention: 3-commcare/recipes/journey-<app>[-<slug>].yaml
#   - the single is_smoke:true journey per app uses the bare name
#     (journey-learn.yaml / journey-deliver.yaml)
#   - additional journeys append a kebab-case slug from `name`
#     (journey-learn-assessment-retry.yaml)
# `id: J<n>` stays as the stable internal key; recipe_path is the file.
```

- [ ] **Step 2: Verify nothing else references the old path**

Run: `grep -rn "app-test-cases/recipes/" templates/ skills/ agents/`
Expected: no matches after this + Task 1.2/1.5 edits.

- [ ] **Step 3: Commit**

```bash
git add templates/app-test-cases-template.yaml
git commit -m "fix(app-test-cases): template recipe_path -> 3-commcare/recipes/journey-<app>"
```

### Task 1.2: Rewrite the naming convention in `app-test-cases/SKILL.md`

**Files:**
- Modify: `skills/app-test-cases/SKILL.md` (§ Products line 35-36; § Step 3 line 139-140; § Step 3 "Write recipes to..." line 440-445; § Step 5 line 542-550)

- [ ] **Step 1: Update § Products**

Replace the two product bullets (lines 35-36) with:

```markdown
- `3-commcare/app-test-cases.yaml` — per-journey test entries (one per journey, exactly one `is_smoke: true` per app)
- `3-commcare/recipes/journey-<app>[-<slug>].yaml` — one Maestro recipe per journey. The single `is_smoke: true` journey per app uses the bare name (`journey-learn.yaml`, `journey-deliver.yaml`); additional journeys append a kebab-case slug from the journey title (`journey-learn-assessment-retry.yaml`). `id: J<n>` stays as the stable internal key in `app-test-cases.yaml`; `recipe_path` points at the descriptive file.
```

- [ ] **Step 2: Update § Step 3 naming bullet (line 139)**

Replace `- Recipes here are journey-keyed, not module-keyed (\`J1.yaml\`, \`J2.yaml\`)` with:

```markdown
- Recipes are named by app + intent, not journey-id: `journey-learn.yaml` / `journey-deliver.yaml` for the smokes, `journey-<app>-<slug>.yaml` for extras. The journey-id (`J<n>`) lives in `app-test-cases.yaml`, not the filename.
```

- [ ] **Step 3: Update the `takeScreenshot` final-step convention (line 140-141)**

Replace `Each journey's recipe MUST include a final \`takeScreenshot: "sc-J<n>-final"\`` with:

```markdown
- Each journey's recipe MUST include a final `takeScreenshot: "<recipe-base>-final"` (e.g. `journey-learn-final`, `journey-deliver-final`) for the deep UX judge to grade
```

- [ ] **Step 4: Update the "Write recipes to" path block (lines 440-445)**

Replace the `Write recipes to ACE/<opp>/runs/<run-id>/3-commcare/recipes/J<n>.yaml` paragraph with the same path but `journey-<app>[-<slug>].yaml`, keeping the #106-finding-3 note about the path mirroring the output spec.

- [ ] **Step 5: Update § Step 5 coverage check (line 542-550)**

Replace `Every \`is_smoke: true\` journey has a \`recipes/J<n>.yaml\` file` with `Every \`is_smoke: true\` journey has its \`recipes/journey-<app>.yaml\` file`.

- [ ] **Step 6: Add a change-log row**

Append to the § Change log table:

```markdown
| 2026-05-27 | Recipe naming convention: `J<n>.yaml` → `journey-<app>[-<slug>].yaml` (smokes use bare `journey-learn`/`journey-deliver`). `id: J<n>` retained as internal key. Screenshot labels `sc-J<n>-*` → `<recipe-base>-*`. See spec 2026-05-27-phase6-learn-deliver-decoupling. | ACE team |
```

- [ ] **Step 7: Commit**

```bash
git add skills/app-test-cases/SKILL.md
git commit -m "docs(app-test-cases): journey-<app> recipe naming convention"
```

### Task 1.3: Update path/label references in `app-screenshot-capture/SKILL.md`

**Files:**
- Modify: `skills/app-screenshot-capture/SKILL.md` (§ Inputs/Products screenshot dirs; § Step 5 paths; verdict examples; § Step 2.6 inputs `J*.yaml`)

- [ ] **Step 1: Update screenshot output paths**

Replace every `6-qa-and-training/screenshots/<journey-id>/<step-name>.png` with `6-qa-and-training/screenshots/<recipe-base>/<step-name>.png` (where `<recipe-base>` is `journey-learn` / `journey-deliver`). Lines: 35, 308, 325, and the `.xml` sibling at 325.

- [ ] **Step 2: Update recipe-read references**

Replace `3-commcare/recipes/J*.yaml` (Step 2.6 inputs, line ~175) and any `J<n>.yaml` mentions with `3-commcare/recipes/journey-*.yaml`.

- [ ] **Step 3: Update per_item refs in verdict examples**

In the structural verdict example (line ~447), change `ref: "J1.yaml"` to `ref: learn` and add a `ref: deliver` item (this also seeds PR2's per-app model). Leave the shallow verdict's `ref: learn`/`ref: deliver` as-is (already correct).

- [ ] **Step 4: Commit**

```bash
git add skills/app-screenshot-capture/SKILL.md
git commit -m "docs(app-screenshot-capture): journey-<app> paths + per-app verdict refs"
```

### Task 1.4: Update agent + training-deck-generate references

**Files:**
- Modify: `agents/qa-and-training.md` (Step 1 paths line 232; pre-flight recipe check line 166-181)
- Modify: `agents/commcare-setup.md` (recipe path references)
- Modify: `skills/training-deck-generate/SKILL.md` (screenshot dir consumption)

- [ ] **Step 1: `qa-and-training.md` paths**

Replace `6-qa-and-training/screenshots/J*/*.png` (line 232) with `6-qa-and-training/screenshots/journey-*/*.png`. In the pre-flight bullet (line 166-181) replace `3-commcare/recipes/J<n>.yaml` with `3-commcare/recipes/journey-<app>.yaml`.

- [ ] **Step 2: `commcare-setup.md` paths**

Run `grep -nE "J<n>|recipes/J|J1\.yaml" agents/commcare-setup.md` and replace each with the `journey-<app>` equivalent.

- [ ] **Step 3: `training-deck-generate/SKILL.md` screenshot dirs**

Run `grep -nE "screenshots/<journey-id>|screenshots/J" skills/training-deck-generate/SKILL.md` and replace with `screenshots/journey-<app>/`.

- [ ] **Step 4: Commit**

```bash
git add agents/qa-and-training.md agents/commcare-setup.md skills/training-deck-generate/SKILL.md
git commit -m "docs(phase6): journey-<app> screenshot + recipe paths in agent/deck refs"
```

### Task 1.5: Update fixture + phase-closeout comment + run tests

**Files:**
- Modify: `test/fixtures/ACE-Test-001/3-commcare/app-test-cases.yaml:26,43`
- Modify: `lib/phase-closeout.ts:146` (comment example)
- Test: `npm test`

- [ ] **Step 1: Fixture recipe_path**

Change `recipe_path: app-test-cases/recipes/J1.yaml` → `3-commcare/recipes/journey-learn.yaml` and `...J2.yaml` → `3-commcare/recipes/journey-deliver.yaml`.

- [ ] **Step 2: phase-closeout comment**

Change the example `3-commcare/recipes/J1.yaml` in the line-146 comment to `3-commcare/recipes/journey-learn.yaml`.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS. If `artifact-manifest.test.ts` or `phase-closeout.test.ts` assert on the old path, update the assertion to the new path (search test files for `recipes/J` and `app-test-cases/recipes`).

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/ACE-Test-001/3-commcare/app-test-cases.yaml lib/phase-closeout.ts
git commit -m "test(fixtures): journey-<app> recipe_path in ACE-Test-001 + phase-closeout comment"
```

### Task 1.6: Ship PR 1

- [ ] **Step 1: Version bump**

Run: `bash scripts/version-bump.sh`

- [ ] **Step 2: Push + PR + auto-merge**

```bash
git push -u origin HEAD
gh pr create --title "Phase 6: journey-<app> recipe naming convention" --body "PR 1/3 of the Phase 6 Learn/Deliver decoupling. Renames J<n>.yaml -> journey-<app>[-<slug>].yaml, fixes stale app-test-cases/recipes/ path. No runtime behavior change. Spec: docs/superpowers/specs/2026-05-27-phase6-learn-deliver-decoupling-design.md"
gh pr merge --auto --merge
```

- [ ] **Step 3: After merge confirms, `/ace:update`** (see CLAUDE.md § Plugin updates). Then proceed to PR 2.

---

## PR 2 — Decoupling + per-app verdicts + failure policy

Split `app-screenshot-capture` capture into independent Learn-first / Deliver-second legs; write per-app `per_item` verdicts; map outcomes per the spec's Part-3 table; make `qa-and-training`'s pre-flight per-app; make `training-deck-generate` tolerate Learn-present/Deliver-missing.

### Task 2.1: Document canonical per-app `ref` values in verdict-schema

**Files:**
- Modify: `lib/verdict-schema.ts` (near `PerItemSchema`, ~line 96)
- Test: `test/lib/verdict-schema.test.ts` (if present) else skip test edit

- [ ] **Step 1: Add doc comment**

Above `PerItemSchema`, add:

```typescript
/**
 * For app-screenshot-capture (Phase 6), `ref` is the canonical app
 * name — `learn` or `deliver` — so the two capture legs are graded
 * independently. A non-pass top-level verdict still ships whatever the
 * passing leg captured; failure is attributed to a specific leg, never
 * a generic "smoke failed". See spec 2026-05-27-phase6-learn-deliver-decoupling.
 */
```

- [ ] **Step 2: Verify no schema change needed**

Run: `grep -n "per_item" lib/verdict-schema.ts`
Expected: `per_item: z.array(PerItemSchema).optional()` already exists — no enum/shape change.

- [ ] **Step 3: Run tests + commit**

Run: `npm test -- test/lib/`
Expected: PASS

```bash
git add lib/verdict-schema.ts
git commit -m "docs(verdict-schema): canonical learn/deliver per_item refs for phase 6"
```

### Task 2.2: Rewrite `app-screenshot-capture` Step 5 as two independent legs

**Files:**
- Modify: `skills/app-screenshot-capture/SKILL.md` (§ Step 5 lines 302-371; § Step 9 verdict shapes; § LLM-as-Judge Rubric)

- [ ] **Step 1: Replace the Step 5 loop with the two-leg structure**

Replace the "For each of the two smoke journeys (Learn first, then Deliver)... If a smoke recipe fails (status != pass), halt" framing with:

```markdown
### Step 5: Run the smoke recipes — two independent legs

Capture is split into a **Learn leg** and a **Deliver leg**. The legs
are graded independently; a Deliver failure never suppresses Learn
capture.

**Learn leg (always runs first).** Run `journey-learn.yaml` against the
AVD. Upload every captured screenshot to
`6-qa-and-training/screenshots/journey-learn/<step-name>.png`
(`shareAnyoneWithLink: true`, `mimeType: image/png`; upload any sibling
`<step-name>.xml` ui-dump with `mimeType: application/xml`). Record the
Learn leg outcome (`pass` iff the recipe status is pass AND every
screenshot is non-zero bytes). A Learn failure records the Learn
sub-verdict and does NOT abort the dispatch — but the Deliver leg then
cannot run (Connect gates Deliver behind Learn completion), so it is
recorded `blocked-by-learn`.

**Deliver leg (runs second; depends on the Learn leg).** Only attempt
if the Learn leg reached completion. `journey-deliver.yaml` resumes
from the now-unlocked state in the same device session (no re-login).
Upload to `6-qa-and-training/screenshots/journey-deliver/<step-name>.png`.
Record the Deliver leg outcome independently.

**Do NOT halt the dispatch on a single leg failure.** Run both legs (or
record why the Deliver leg couldn't run), then write the per-app
verdict in Step 9. The recipe-error → failure-mode table below is the
per-leg classifier — apply it to whichever leg failed.
```

Keep the existing "READ the failure screenshot" guidance and the failure-mode table (they apply per-leg now). Keep the `shareAnyoneWithLink` CRITICAL note verbatim.

- [ ] **Step 2: Replace the Step 9 structural-verdict example with per-app mapping**

Replace the structural verdict's `per_item` block + add the mapping table:

```yaml
per_item:
  - ref: learn
    score: 9.0
    verdict: pass
    note: "journey-learn walked to completion; 6 screenshots, all PNG"
  - ref: deliver
    score: 0
    verdict: incomplete       # or fail / pass
    note: "journey-deliver.yaml missing — Phase 3 deferred it"
```

Add the top-level verdict mapping table (from spec Part 3) right after the example:

```markdown
Top-level `verdict` from the two legs:

| Learn | Deliver | top-level verdict | phase proceeds clean? |
|---|---|---|---|
| pass | pass | `pass` | yes |
| pass | fail (ran, broke) | `fail` | no — blocks |
| pass | incomplete (recipe missing/scaffold) | `incomplete` | no — blocks |
| fail | blocked-by-learn | `fail` | no — blocks |
| incomplete | incomplete | `incomplete` | no — blocks |

A non-pass verdict still ships the Learn screenshots it captured.
Operator-authorized whole-step skip remains the separate explicit
escape (unchanged).
```

- [ ] **Step 3: Update the Mode/Rubric sections**

In § LLM-as-Judge Rubric, change the Coverage row to: "both legs attempted; Learn always; Deliver iff Learn completed." Add a Change Log row dated 2026-05-27 describing the two-leg split.

- [ ] **Step 4: Commit**

```bash
git add skills/app-screenshot-capture/SKILL.md
git commit -m "docs(app-screenshot-capture): independent Learn/Deliver legs + per-app verdict mapping"
```

### Task 2.3: Make `qa-and-training` pre-flight + failure policy per-app

**Files:**
- Modify: `agents/qa-and-training.md` (§ Pre-flight checklist line 166-192; § Step 1 line 228-244)

- [ ] **Step 1: Per-app recipe-presence pre-flight**

Replace the line-166 bullet ("Phase 3 produced the per-journey Maestro recipes...") so the check is per-app:

```markdown
- [ ] **Phase 3 produced the per-app smoke recipes.** Check each app
      independently:
      - `3-commcare/recipes/journey-learn.yaml` MUST resolve. Missing →
        halt (Learn capture is the floor; no Learn recipe is a real
        Phase-3 gap). Remediation: `/ace:step app-test-cases <opp>/<run-id>`.
      - `3-commcare/recipes/journey-deliver.yaml` SHOULD resolve. Missing
        → do NOT halt the phase before Step 1; let `app-screenshot-capture`
        run the Learn leg and record the Deliver leg `incomplete`. The
        phase verdict will be non-pass (per the per-app failure policy),
        but Learn screenshots still ship.
```

- [ ] **Step 2: Update the halt language**

In the post-checklist paragraph (line 183-192), change "Do not soft-skip screenshot capture and ship placeholders" to clarify: a **Learn** capability gap halts; a **Deliver-only** gap produces a non-pass phase verdict with Learn shipped, not a hard halt before Step 1.

- [ ] **Step 3: Update § Step 1 description**

Replace "Halts on smoke-recipe failure or UX judge < 2/3" (line 234) with "Runs the Learn leg then the Deliver leg independently; records a per-app verdict. A Deliver-leg failure yields a non-pass phase verdict but Learn screenshots still ship — it does not abort Learn capture."

- [ ] **Step 4: Commit**

```bash
git add agents/qa-and-training.md
git commit -m "docs(qa-and-training): per-app pre-flight + Deliver-gap-doesnt-block-Learn policy"
```

### Task 2.4: Make `training-deck-generate` tolerate Learn-only screenshots

**Files:**
- Modify: `skills/training-deck-generate/SKILL.md` (screenshot-consumption section)

- [ ] **Step 1: Document partial handling**

Find the section that reads the screenshot manifest and add:

```markdown
**Partial per-app screenshots.** The screenshot manifest may contain
`journey-learn/` screenshots but no `journey-deliver/` (or vice versa)
when one capture leg failed/was-deferred (see
`app-screenshot-capture` per-app legs). Use whichever app's screenshots
are present; for the missing app, emit the same "screenshot placeholder
— capture in a future AVD-enabled QA run" treatment already used when
the whole bundle is absent. Never fail the deck over a missing app
leg — the present leg's screenshots still go in.
```

- [ ] **Step 2: Commit**

```bash
git add skills/training-deck-generate/SKILL.md
git commit -m "docs(training-deck-generate): tolerate Learn-only (partial) screenshot bundle"
```

### Task 2.5: Add the anti-monolith static check to recipe-sanity-probe (TDD)

**Files:**
- Modify: `mcp/mobile/recipe-sanity-probe.ts` (SanityFailureClass union ~line 42; new check in the per-recipe loop ~line 173)
- Test: `test/mcp/mobile/recipe-sanity-probe.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/mcp/mobile/recipe-sanity-probe.test.ts` (reuse the existing `recipe(name, env)` helper; for these tests pass raw text via a `recipeText(name, body)` helper — if none exists, construct `{ name, text }` inline):

```typescript
describe('deliver-smoke-rewalks-learn', () => {
  const baseInputs = (recipes: { name: string; text: string }[]) => ({
    recipes,
    novaApps: [],
    connectOpp: { display_name: 'Opp' },
  });

  it('flags a journey-deliver recipe that runFlows learn-launch', () => {
    const text = [
      'appId: org.commcare.dalvik',
      '---',
      '- runFlow:',
      '    file: connect-login.yaml',
      '- runFlow:',
      '    file: learn-launch.yaml',
      '- takeScreenshot: "journey-deliver-final"',
    ].join('\n');
    const v = probeRecipeSanity(baseInputs([{ name: 'journey-deliver.yaml', text }]));
    expect(v.ok).toBe(false);
    expect(v.failures.map((f) => f.class)).toContain('deliver-smoke-rewalks-learn');
  });

  it('flags a journey-deliver recipe with >=2 learn-tap-module runFlows', () => {
    const text = [
      'appId: org.commcare.dalvik',
      '---',
      '- runFlow:',
      '    file: learn-tap-module.yaml',
      '- runFlow:',
      '    file: learn-tap-module.yaml',
    ].join('\n');
    const v = probeRecipeSanity(baseInputs([{ name: 'journey-deliver.yaml', text }]));
    expect(v.failures.map((f) => f.class)).toContain('deliver-smoke-rewalks-learn');
  });

  it('does NOT flag a resume-only journey-deliver recipe', () => {
    const text = [
      'appId: org.commcare.dalvik',
      '---',
      '- runFlow:',
      '    file: connect-resume-opp.yaml',
      '- runFlow:',
      '    file: deliver-launch.yaml',
      '- takeScreenshot: "journey-deliver-final"',
    ].join('\n');
    const v = probeRecipeSanity(baseInputs([{ name: 'journey-deliver.yaml', text }]));
    expect(v.failures.map((f) => f.class)).not.toContain('deliver-smoke-rewalks-learn');
  });

  it('does NOT flag a journey-learn recipe that walks Learn fully', () => {
    const text = [
      'appId: org.commcare.dalvik',
      '---',
      '- runFlow:',
      '    file: learn-launch.yaml',
      '- runFlow:',
      '    file: learn-tap-module.yaml',
      '- runFlow:',
      '    file: learn-tap-module.yaml',
    ].join('\n');
    const v = probeRecipeSanity(baseInputs([{ name: 'journey-learn.yaml', text }]));
    expect(v.failures.map((f) => f.class)).not.toContain('deliver-smoke-rewalks-learn');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/mcp/mobile/recipe-sanity-probe.test.ts`
Expected: FAIL (the new class isn't produced yet).

- [ ] **Step 3: Add the failure class to the union**

In `mcp/mobile/recipe-sanity-probe.ts`, add `| 'deliver-smoke-rewalks-learn'` to the `SanityFailureClass` type (after `'brief-label-drift'`).

- [ ] **Step 4: Implement the check inside the per-recipe loop**

Add after the brief-label-drift block (after line ~172, still inside `for (const recipe of inputs.recipes)`):

```typescript
    // 8. deliver-smoke-rewalks-learn → a Deliver-leg recipe (name
    // starts "journey-deliver") contains a full Learn walk. Post-
    // decoupling the journey-learn leg walks Learn to completion and
    // unlocks Deliver; the Deliver leg must only resume from the
    // unlocked state (connect-resume-opp -> deliver-launch). A Deliver
    // recipe that re-walks Learn is the pre-decoupling monolith
    // antipattern (the leep 20260527 J2 class).
    if (/^journey-deliver/.test(recipe.name)) {
      const learnLaunches = (recipe.text.match(/file:\s*learn-launch\.yaml/g) || []).length;
      const learnTaps = (recipe.text.match(/file:\s*learn-tap-module\.yaml/g) || []).length;
      if (learnLaunches > 0 || learnTaps >= 2) {
        failures.push({
          class: 'deliver-smoke-rewalks-learn',
          detail: `deliver recipe ${recipe.name} contains a Learn walk (learn-launch x${learnLaunches}, learn-tap-module x${learnTaps}) — post-decoupling the journey-learn leg completes Learn; the Deliver leg must resume from the unlocked state via deliver-launch.yaml only`,
          remediation: `re-compose the Deliver smoke as: connect-resume-opp -> runFlow deliver-launch.yaml -> first Deliver form. Remove the Learn-walk steps (journey-learn handles Learn completion).`,
          recipe: recipe.name,
          parameter: 'learn-walk-in-deliver',
          value: `learn-launch=${learnLaunches},learn-tap-module=${learnTaps}`,
        });
      }
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- test/mcp/mobile/recipe-sanity-probe.test.ts`
Expected: PASS (all four new cases + existing cases).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add mcp/mobile/recipe-sanity-probe.ts test/mcp/mobile/recipe-sanity-probe.test.ts
git commit -m "feat(recipe-sanity): flag deliver-smoke-rewalks-learn (anti-monolith)"
```

### Task 2.6: Reference the new check in `app-screenshot-capture` Step 2.6 + ship PR 2

**Files:**
- Modify: `skills/app-screenshot-capture/SKILL.md` (§ Step 2.6 failure-class table ~line 190-198)

- [ ] **Step 1: Add the new class to the Step 2.6 table**

Add a row:

```markdown
| `deliver-smoke-rewalks-learn` | Re-author the Deliver smoke as resume-only (`connect-resume-opp` → `deliver-launch.yaml`) via `/ace:step app-test-cases`. The Learn leg already completes Learn. |
```

- [ ] **Step 2: Commit**

```bash
git add skills/app-screenshot-capture/SKILL.md
git commit -m "docs(app-screenshot-capture): surface deliver-smoke-rewalks-learn in Step 2.6"
```

- [ ] **Step 3: Version bump + PR + auto-merge**

```bash
bash scripts/version-bump.sh
git push -u origin HEAD
gh pr create --title "Phase 6: independent Learn/Deliver capture legs + per-app verdicts" --body "PR 2/3. app-screenshot-capture runs Learn then Deliver independently; per-app per_item verdicts; per-app pre-flight; training-deck-generate tolerates partial bundle; new recipe-sanity anti-monolith check. Spec: docs/superpowers/specs/2026-05-27-phase6-learn-deliver-decoupling-design.md"
gh pr merge --auto --merge
```

- [ ] **Step 4: After merge, `/ace:update`. MCP code changed (`recipe-sanity-probe.ts`) → also restart Claude** per CLAUDE.md § MCP changes need a full restart. Then proceed to PR 3.

---

## PR 3 — Deliver authoring hardening + live verification

Change the `app-test-cases` Deliver-composition contract to Learn-to-completion (Learn leg) + Deliver-resume (Deliver leg); add the `connect-resume-opp` palette helper if needed; verify end-to-end on the live AVD.

### Task 3.1: Rewrite the Deliver-composition rule in `app-test-cases/SKILL.md`

**Files:**
- Modify: `skills/app-test-cases/SKILL.md` (§ Step 2 "Deliver-smoke composition" lines 75-130; § Step 3 entry-point template lines 220-271)

- [ ] **Step 1: Replace the "faithful Deliver walk OR BLOCKER" rule**

Replace the "Deliver-smoke composition for two-app opps" block (lines 75-98) with the split model:

```markdown
**Deliver-smoke composition — Learn leg completes Learn, Deliver leg
resumes.** Connect gates the Deliver app behind Learn-assessment
completion (`docs/learnings/2026-05-18-connect-gates-deliver-on-learn-completion.md`).
Rather than re-walk Learn inside the Deliver recipe (the old ~80-step
monolith that was fragile and got deferred — leep 20260527 J2), the
two smoke recipes share device state within one Phase 6 dispatch:

- **`journey-learn.yaml` walks Learn to completion.** All modules
  (content form + assessment per module) through the final
  assessment-pass + sync. This both produces the Learn training
  screenshots (module list → content → quiz → completion/certificate)
  AND unlocks Deliver as a side effect. The Learn smoke is a *complete*
  walk, not a land-at-M1 thin walk.
- **`journey-deliver.yaml` resumes from the unlocked state.** It assumes
  the immediately-preceding `journey-learn` leg (same dispatch, warm
  session) completed Learn. Steps: navigate to the opp list → Resume the
  In-Progress card (`connect-resume-opp.yaml`) → `runFlow:
  deliver-launch.yaml` (certificate/opp-detail → Download gate →
  Deliver home, all ID-anchored in `connect-2.63.0.yaml`) → tap into
  the first Deliver module → first Deliver form screenshot. ~12 steps,
  NO Learn duplication.

State the warm-state dependency in `journey-deliver.yaml`'s header
comment: it is NOT independently cold-runnable; runners execute
journey-learn → journey-deliver in order.
```

- [ ] **Step 2: Keep the composition-escape ban; narrow the BLOCKER**

Replace the "Emitting the legacy Learn-launch-only Deliver smoke is a [BLOCKER]" block (lines 99-130) with:

```markdown
**The `composition_status` escape stays banned.** Do NOT write
`composition_status: <anything>` on any `is_smoke: true` journey — its
presence is a contract violation (it self-declares a known-broken
recipe). With the Learn-completes / Deliver-resumes split, the common
case IS composable, so the old "monolith or BLOCKER" binary is gone.

Halt with a `[BLOCKER]` only when the structure genuinely can't be
composed — e.g. the Learn blueprint is missing the modules the walk
needs, or `deliver-launch.yaml`'s anchors don't resolve against the
active selector map. A `journey-deliver.yaml` that re-walks Learn
(`learn-launch` or ≥2 `learn-tap-module`) is rejected by the
`deliver-smoke-rewalks-learn` recipe-sanity check (Step 3.4-adjacent) —
re-compose it as resume-only.
```

- [ ] **Step 3: Update the § Step 3 entry-point template**

In the "Entry-point template" (lines 220-271), replace the Deliver-journey guidance with the resume-only chain: `connect-resume-opp.yaml` → `deliver-launch.yaml` → first Deliver form, and point Learn journeys at the full walk-to-completion template (the existing 2-menu-level template already covers Learn navigation).

- [ ] **Step 4: Add change-log row**

```markdown
| 2026-05-27 | Deliver-smoke composition: split the 80-step Learn-re-walk monolith into journey-learn (walks Learn to completion) + journey-deliver (resumes from unlocked state via connect-resume-opp -> deliver-launch). Closes the leep 20260527 J2 deferral class — composition is now the default, BLOCKER reserved for genuinely un-composable structures. | ACE team |
```

- [ ] **Step 5: Commit**

```bash
git add skills/app-test-cases/SKILL.md
git commit -m "docs(app-test-cases): Learn-to-completion + Deliver-resume split composition"
```

### Task 3.2: Add the `connect-resume-opp` palette helper if absent

**Files:**
- Possibly create: `mcp/mobile/recipes/static/connect-resume-opp.yaml`
- Modify (if created): selector refs already in `connect-2.63.0.yaml`

- [ ] **Step 1: Check whether Resume navigation already exists**

Run: `ls mcp/mobile/recipes/static/ && grep -rln "Resume\|resume\|In-Progress\|viewJobCard\|connect_resume" mcp/mobile/recipes/static/`
If a recipe already covers opp-list → Resume the In-Progress card, reuse it (note its name in Task 3.1's recipe template) and SKIP to Task 3.3.

- [ ] **Step 2: If absent, create the helper**

Create `mcp/mobile/recipes/static/connect-resume-opp.yaml`. Header documents pre-state (Connect opp list, opp already Learn-in-progress/complete) and post-state (certificate or opp-detail surface that `deliver-launch.yaml` expects). Body (selectors to be confirmed against the live dump in Task 3.5; use existing `${SELECTOR:...}` rows where they resolve):

```yaml
# Navigate Connect's opp list to the target opp's In-Progress card and
# tap Resume, landing on the post-Learn certificate/opp-detail surface
# that deliver-launch.yaml consumes. Warm-session only (assumes the
# journey-learn leg just completed Learn in this dispatch).
appId: org.commcare.dalvik
---
- runFlow:
    file: connect-claim-opp.yaml   # reused: scrolls to + opens the opp card
    env:
      OPP_NAME: ${OPP_NAME}
- takeScreenshot: "connect-resume-opp-landed"
```

If `connect-claim-opp.yaml` already lands on the certificate/opp-detail surface for a Learn-complete opp, this thin wrapper is enough; otherwise add the explicit Resume tap discovered in Task 3.5.

- [ ] **Step 3: Lint + commit**

Run: `npm test -- test/mcp/mobile/static-palette-health.test.ts`
Expected: PASS (palette parses + selectors resolve).

```bash
git add mcp/mobile/recipes/static/connect-resume-opp.yaml
git commit -m "feat(mobile-palette): connect-resume-opp helper for the Deliver resume leg"
```

### Task 3.3: Live AVD — Learn-to-completion leg

**Files:** none (live verification; produces Drive screenshots)

- [ ] **Step 1: Verify AVD health**

Call `mobile_diagnose` then `mobile_ensure_avd_running`. Expected: returns ready (booted, Maestro driver responsive, snapshot restored). If it throws `DeviceUserStateError`/`MaestroDriverError`, run `/ace:mobile-bootstrap` and retry. If no AVD is available on this machine, STOP PR 3 here and ship Tasks 3.1-3.2 as the static half; flag the live verification as a follow-up on an AVD-enabled machine.

- [ ] **Step 2: Compose + write the two recipes for the leep opp**

Run `/ace:step app-test-cases leep-paint-collection/20260527-1528` (now uses the new split contract) to (re)compose `journey-learn.yaml` (full walk) + `journey-deliver.yaml` (resume-only). Confirm both land in `3-commcare/recipes/` and pass `mobile_validate_recipe` + `mobile_resolve_selectors` (`unresolved: []`).

- [ ] **Step 3: Run the Learn leg**

`mobile_run_recipe` on `journey-learn.yaml` with `OPP_NAME` read verbatim from `run_state.yaml.phases.connect-setup.products.connect.opportunity.name` ("LEEP Paint Surveillance - India (run 20260527-1528)"), `ACE_E2E_PHONE_LOCAL`, `ACE_E2E_PIN`.
Expected: recipe completes; the final assessment passes and syncs; screenshots captured at module list / content / quiz / completion.

- [ ] **Step 4: Confirm Deliver is unlocked**

After the Learn leg, `mobile_capture_ui_dump` on the opp's Resume/certificate surface. Confirm `${SELECTOR:deliver-opp-detail-view-button}` (or the certificate `Congratulations` text) is reachable. If a needed selector is missing, harvest its resource-id and add the row to `connect-2.63.0.yaml` (calibration-on-gap), then commit that one-line addition.

### Task 3.4: Live AVD — Deliver resume leg + verdict

**Files:** none (live verification; produces Drive screenshots + verdict)

- [ ] **Step 1: Run the Deliver leg**

`mobile_run_recipe` on `journey-deliver.yaml` in the same session (warm).
Expected: `connect-resume-opp` → `deliver-launch.yaml` lands on Deliver home (`viewJobCard` visible) → taps into the first Deliver form → `journey-deliver-final` screenshot captured.

- [ ] **Step 2: Confirm per-app screenshots on Drive**

`drive_list_folder` on `6-qa-and-training/screenshots/` for the leep run. Expected: both `journey-learn/` and `journey-deliver/` dirs with non-zero PNGs.

- [ ] **Step 3: Confirm the per-app verdict**

Re-read `app-screenshot-capture_verdict.yaml`. Expected: `per_item` shows `learn: pass` and `deliver: pass`; top-level `verdict: pass`. (This is the acceptance evidence for the whole effort.)

- [ ] **Step 4: Commit any calibration-on-gap selector additions**

If Task 3.3 Step 4 added a selector row:

```bash
git add mcp/mobile/selectors/connect-2.63.0.yaml
git commit -m "fix(selectors): add <name> row surfaced by leep Deliver-leg verification"
```

### Task 3.5: Self-review + ship PR 3

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 2: Version bump + PR + auto-merge**

```bash
bash scripts/version-bump.sh
git push -u origin HEAD
gh pr create --title "Phase 6: Deliver-recipe hardening (Learn-completion + Deliver-resume)" --body "PR 3/3. app-test-cases composes journey-learn (walks Learn to completion) + journey-deliver (resume-only), killing the 80-step monolith that caused the leep J2 deferral. Verified end-to-end on the live AVD against leep-paint-collection/20260527-1528 (both legs pass). Spec: docs/superpowers/specs/2026-05-27-phase6-learn-deliver-decoupling-design.md"
gh pr merge --auto --merge
```

- [ ] **Step 3: After merge, `/ace:update` + restart Claude** (palette/selector changes are MCP-bound).

---

## Self-Review (run before execution)

**Spec coverage:**
- Part 1 (naming) → Tasks 1.1-1.5. ✓
- Part 2 (decouple) → Task 2.2. ✓
- Part 3 (per-app verdict + policy) → Tasks 2.1, 2.2, 2.3, 2.4. ✓
- Part 4 (Deliver hardening) → Tasks 3.1, 3.2, 3.3, 3.4. ✓
- Anti-monolith probe → Task 2.5. ✓
- Live verification → Tasks 3.3, 3.4. ✓
- All file-by-file spec entries have a task. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to" — each step names exact files + content. The one conditional (Task 3.2 "create only if absent") has an explicit check step + both branches specified. ✓

**Type consistency:** `deliver-smoke-rewalks-learn` used identically in probe union, impl, test, and SKILL doc. `per_item` refs `learn`/`deliver` consistent across verdict-schema, app-screenshot-capture, qa-and-training. Recipe names `journey-learn.yaml`/`journey-deliver.yaml` consistent across all tasks. ✓
