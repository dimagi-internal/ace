---
name: training-deck-outline
description: >
  Generate the slide-by-slide markdown outline that `training-deck-build`
  renders into a Google Slides deck. Owns one artifact only:
  `ACE/<opp>/training-materials/training-deck-outline.md`. First of the
  per-artifact training skills — siblings (FLW guide, LLO guide,
  quick-reference, FAQ, onboarding email, video script) follow the same
  one-skill-per-artifact pattern.
---

# Training Deck Outline

Produce the slide-by-slide markdown that `training-deck-build` parses
into a real Google Slides deck. Single artifact, single concern.

## When to run

Phase 5 (`qa-and-training`), after `app-screenshot-capture` has uploaded
the per-opp screenshots and after `training-materials` has produced the
LLO/FLW guides (so you can pull a few framing lines forward without
duplicating analysis). Upstream of `training-deck-build`.

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `ACE/<opp>/pdd.md` | opp framing, archetype, audience |
| Phase 2 | `ACE/<opp>/app-summaries/learn-app-summary.md` | Learn app modules → "what FLWs will see" slides |
| Phase 2 | `ACE/<opp>/app-summaries/deliver-app-summary.md` | Deliver app forms → walkthrough slides |
| Phase 5 Step 1 (`app-screenshot-capture`) | `ACE/<opp>/screenshots/manifest.yaml` | per-opp PNG fileIds |
| Common assets | `ACE/_common/connect-screenshots/<v>/manifest.yaml` | sign-in, claim-opp, sync, payments — common across opps |
| Phase 5 Step 3 (`training-materials`, sibling) | `ACE/<opp>/training-materials/flw-training-guide.md` | optional: pull caption phrasing forward so the deck and guide say the same thing |

## Output

Single file: `ACE/<opp>/training-materials/training-deck-outline.md`.

The format is the **strict contract** that `training-deck-build` parses
via `parseDeckOutline` in `lib/training-deck-spec.ts`. Producing
malformed markdown will cause `training-deck-build` to throw with a
clear error — that's intentional, the parser is opinionated.

```markdown
# <Deck Title>

<optional subtitle line — appears below the title on the title slide>

---

## Slide: <slide title>

<optional paragraph — short narrative context, max 2-3 sentences>

- bullet one
- bullet two
- bullet three (3-5 bullets ideal; 7+ overflows the body box)

![alt text](drive:<fileId>)        # Drive fileId — preferred
![alt text](https://...)            # raw HTTPS URL — also OK

> Speaker notes: <one or two sentences the presenter says aloud>

---

## Slide: <next slide title>

...
```

### Format rules (must obey)

- **Title slide is the leading section** — single `# Title` heading,
  optional subtitle paragraph, no `## Slide:` heading.
- **Each content slide starts with `## Slide: <title>`** as the first
  non-blank line. Sections are separated by `---` on its own line.
- **Image refs use `drive:<fileId>` or `https://...`.** No relative
  paths, no `screenshot:<alias>` (planned but not yet supported by
  `parseDeckOutline`). Resolve manifest aliases to fileIds during
  generation.
- **Speaker notes use `> Speaker notes: <text>`** as a markdown
  blockquote. The `Speaker notes:` prefix is stripped on parse.
- **One image per slide for v1.** Multi-image slides parse and render
  but the layout stacks them vertically in the lower half — works but
  not pretty. Prefer one image and a tight bullet list above.
- **Body text + image is OK** — a paragraph or 3-4 bullets above the
  image leaves clear space for the screenshot.

## Process

1. **Read inputs.** Drive paths in the table above.

2. **Resolve screenshot manifests.** Build a map
   `{ alias → drive_file_id }` from the per-opp manifest and the
   common-pool manifest. Use this during slide drafting so every
   `![](drive:...)` ref in the output is a real fileId, not a guess.
   If a screenshot referenced by an `app-test-cases` recipe is missing
   from the actual `screenshots/manifest.yaml`, emit a `[WARN]` line
   in the verdict — don't reference a nonexistent fileId.

3. **Draft the deck.** Default structure for `atomic-visit` archetype:

   - Slide 1: Title + subtitle (deck title = "<opp> — FLW Training")
   - Slide 2: "What you're doing" — paragraph from PDD intervention
     summary, no image
   - Slide 3: "Before you start" — bullets: open Connect, accept the
     invite, install the app + common Connect screenshots
   - Slide 4-N: One slide per Deliver form section, each with the
     relevant per-opp screenshot, a short bullet list of "what to do
     here", and speaker notes
   - Slide N+1: "Common pitfalls" — pull from PDD's stress-test
     appendix
   - Slide N+2: "Where to get help" — OCS widget URL (from
     `ocs-setup/widget-handoff.md`), escalation contacts
   - Slide N+3: Closing thanks + "Now you're ready"

   For `focus-group` archetype: replace the per-form walkthrough slides
   with per-session-stage slides (consent, group-task-1, group-task-2,
   debrief).

   For `multi-stage`: combine — initial-stage slides like
   atomic-visit, follow-up-stage slides treat the FLW as a returning
   user.

4. **Self-check the format.** Before writing, confirm the output:
   - Starts with exactly one `# Title` heading
   - Has at least 4 content slides (`## Slide:` count)
   - Every image ref is `drive:<fileId>` or `https://...`
   - Every slide with `> Speaker notes:` has at least one sentence

5. **Write the output** to
   `ACE/<opp>/training-materials/training-deck-outline.md` via
   `drive_create_file` (overwrite if it already exists).

6. **Self-evaluate (LLM-as-Judge inline).** A 4-criterion check:
   - **Coverage:** every Learn module + every Deliver form is referenced
     by at least one slide
   - **Concreteness:** speaker notes are specific to this opp, not
     generic boilerplate that would fit any deck
   - **Image hygiene:** zero `[unresolved-screenshot]` markers, zero
     missing fileIds
   - **Length:** 8-15 slides total — fewer feels skeletal, more is too
     long for one training session

   Write a verdict YAML to
   `ACE/<opp>/verdicts/training-deck-outline.yaml` in the standard
   shape (see `lib/verdict-schema.ts`). `passed: true` only if all
   four criteria pass.

7. **Hand off.** Print the deck-outline Drive URL + the verdict
   summary. Phase 5 orchestrator dispatches `training-deck-build` next.

## MCP Tools Used

- `ace-gdrive`: `drive_read_file`, `drive_create_file`, `drive_list_folder`

No live Slides API or AVD — this skill is pure document generation. The
Slides side is `training-deck-build`'s job.

## Mode Behavior

- **Auto:** Run end-to-end. Write outline, write verdict.
- **Review:** Pause after step 4 (self-check), present the drafted
  outline, resume on approval.
- **Dry-run:** Execute steps 1-4 in memory but skip the
  `drive_create_file` call. Verdict still written with `dry_run: true`.

## Outputs

- `ACE/<opp>/training-materials/training-deck-outline.md` — the deck
  outline markdown
- `ACE/<opp>/verdicts/training-deck-outline.yaml` — self-eval verdict

## Known limitations (and the fix path)

- **Single archetype default ("atomic-visit").** A real `multi-stage`
  archetype gets a hybrid structure but the slide-count target is
  still 8-15; complex multi-stage opps may need a 20+ slide deck.
  Address by extending step 3's per-archetype branching once we have
  3+ multi-stage opps to calibrate against.
- **No automatic image alignment.** v1 stacks images vertically. A
  future iteration could add a hint syntax like
  `![alt](drive:fileId#side-by-side)` that `training-deck-build` lays
  out as two columns.

## Why a separate skill (and where the rest are headed)

`training-materials` was a single skill emitting 7 artifacts at once.
Splitting per artifact gives independent iteration, eval, and rerun:
each output gets its own LLM context, its own self-check, its own
verdict. Re-running the FAQ doesn't re-emit the entire LLO guide.

This skill is the **first of the per-artifact training skills**.
Planned siblings (next migration cycle):
- `training-llo-guide` — `llo-manager-guide.md`
- `training-flw-guide` — `flw-training-guide.md`
- `training-quick-reference` — `quick-reference.md`
- `training-faq` — `faq.md`
- `training-onboarding-email` — `onboarding-email-body.md`

After all six exist, `training-materials` becomes a thin umbrella that
dispatches them (or is removed entirely; orchestrator dispatches
each child directly).

## Change Log

- v1 (0.10.79): Initial skill. Owns `training-deck-outline.md` only.
  Format contract synced to `lib/training-deck-spec.ts`
  `parseDeckOutline`.
