# 2026-08-17 — Nova shipped i18n: ACE builds multilingual again

## Lens

Jonathan: *"Nova released features for internationalization over the weekend,
can you review and then update ACE so it is now aware it can do
internationalization."*

Three days earlier (2026-08-14) ACE had gone **English-only** on Jon's explicit
call, because a live `tools/list` showed zero language surface. That decision's
premise was a fact about another system, and the fact changed. So the lens is
the one the 2026-08-14 log already named and this session got to exercise from
the other side: **a status question is a lens, and a decision resting on another
system's capability has a shelf life.** The English-only entry was three days
old and already wrong.

Corollary worth keeping: **"supersede, don't reverse."** Nothing about the
2026-08-14 reasoning was mistaken — inline stacking really was a fake, and
shipping it really was worse than the absence. The decision expired because its
premise did. Framing it that way is what let the ITN calibration anchor be
*restored* rather than re-argued: its original 2026-05-29 verdict had been right
all along, only the mechanism changed.

## Do it

PR #1463, 0.13.911 → 0.13.912. One commit, 17 files.

Reviewed at the source before touching anything — live `tools/list` against
`mcp.commcare.app`, not the session's MCP subprocess and not the docs:
**95 tools, up from 81 on 2026-08-14**, six itext-shaped language atoms.

Then **proved the contract on a scratch Nova app (`b4e2c8fd`, created,
exercised, deleted)** before writing a single skill instruction, because the
change is exactly the class CLAUDE.md warns about: build-skill text that
predicts another system's behaviour, with Phase 3 deadlock as the failure mode
(ace#1238). Six findings, none of them guessable:

| Finding | Why it mattered |
|---|---|
| `add_language` COPIES, does not translate | Otherwise ACE ships an English app wearing another language's name |
| Auto-translation covers only a checked-in **57-language set**, no MCP trigger; Chichewa = `not-evaluated` | The languages ACE actually needs are the ones outside it — ACE authors the strings |
| **`needs-review` text IS served to workers** | The honesty story had to change. `review` is bookkeeping, NOT a publish gate |
| Editing English → `out-of-date`, `effective` falls back to English | Produced the load-bearing **translate-LAST** rule |
| Writes auto-tag `origin: "ai"` | Provenance is free; ACE must not claim review it did not do |
| `prose` units reject bare strings | A one-line reproducer instead of a guessed payload shape |

Also read `get_agent_prompt(autonomous_build)` — 70,643 chars, **zero** hits for
`itext`/`locale`/`multiling`, no language step in its numbered workflow. So the
tools being reachable was never going to be enough; the brief has to ask. That
single check is what turned this from a docs edit into a build-skill change.

Design calls worth recording:

- **The dimension inverted a SECOND time, and the rubric says so out loud.**
  `language_conformance` kept its 8% and its null-when-N/A for the third
  configuration running, so no reweighting and every other anchor holds. The
  criteria now open by telling the judge this has flipped twice in four days and
  to read the criteria rather than its priors — the 2026-08-14 log identified
  judge priors as the failure mode here, and two flips make it worse, not better.
- **Table B row DELETED, not rewritten.** Multilingual UI was in Table B as a
  toolchain gap. It is now neither table. Leaving a softened row would have kept
  Phase 1 hedging about a capability that ships.
- **No bespoke native-speaker gate**, per Jon: *"english obviously also needs to
  be reviewed so its not special, just one of the things that needs to be
  reviewed."* Translation review folds into the existing eval machinery.
  Explicitly encoded as `needs-review` is NOT a deduction — because Nova serves
  that text live, the state is an audit trail, not a defect.

## Closed

- Superseded the 2026-08-14 English-only decision (PR #1463, superseding ace#968/#1391). #1391 and
  the component brief both carry the reason.
- **Latent bug fixed:** `pdd-to-deliver-app-eval` still carried the
  **pre-2026-08-14** weight comment (`HARD-FAIL on English-only … inline
  coverage = the sanctioned mechanism`). The 2026-08-14 sweep updated Learn's
  and missed Deliver's, and the old preventer's regexes missed it on word order.
  It had been silently teaching the retired mechanism for three days.

## Backlog

- ~~**`defaultLanguage` stays `en`.**~~ **RESOLVED same day.** Flagged to Jon in
  the PR as a product decision rather than a build detail; his answer: *"all
  screenshots for review for now should stay english."* Confirmed for the
  current review posture and recorded in the component brief so it is not
  re-raised. Still one atom to flip if a live deployment later needs the
  worker's language first.
- **No multilingual build has actually run yet.** The contract is proven atom by
  atom on a 4-string scratch app; the ordering rule is proven; but no Learn or
  Deliver app has been built through `app-language-layer` end-to-end. First real
  run is the validation — watch translation volume against `update_translations`'
  50-unit cap and `commcare-nova#459` truncation.
- **Chichewa/Tumbuka quality is unmeasured.** ACE authors these. Nobody has
  judged an LLM-authored Chichewa form label for a low-literacy cohort. This is
  the direct descendant of the still-open "measure the OCS chatbot in a
  non-English working language" item — same gap, now on a surface that ships.

## Meta-observations

- **`git checkout --` cost the session three files.** Used it to revert
  negative-control edits; it restores from HEAD, which meant it discarded my own
  uncommitted work on `_app-component-library.md`, `pdd-to-deliver-app` and
  `pdd-to-learn-app-eval`. Cheap to redo only because every edit was a scripted
  python block rather than a hand edit — that is the actual lesson. **Back up
  the working tree before a negative control, or stash; never `git checkout --`
  a file carrying uncommitted work.**
- **The negative control caught a hole in the preventer itself.** Five controls;
  four failed correctly. The fifth — reverting only the rubric *criteria*
  wording — stayed **green**, because the change-log row carried the same
  keywords and the assertion read the whole file. That is precisely the
  silent-mis-grade class the suite exists to catch, and the old preventer had
  the same blind spot. The check is now scoped to non-change-log content. A test
  that has never been red is not yet a test.
- **Sweep width, again.** The 2026-08-14 log's own closing lesson was that its
  first pass missed `playbook/` and `CLAUDE.md`. Ran the residual grep as an
  explicit step this time and it paid: two `[INFO]` guidance blocks in the
  rubrics still told the judge to record "the app correctly shipped an
  English-only UI."
- **Proving the contract cost ~8 tool calls and removed every guess from the
  build skills.** Worth restating because the cheap path — reading the six atom
  descriptions and writing plausible instructions — would have produced
  translate-first ordering, which fails silently and only shows up as English
  strings in a shipped app.

- **Filed two issues that should not have been issues, and closed them same
  day.** #1466 ("shipped unvalidated") and #1468 ("translation quality
  unmeasured") were both really *"this new thing has not had a real run yet"* —
  which is the normal state of newly shipped code, not a finding. Jon: *"there
  are plenty of things that we haven't proven but they don't deserve issues, the
  next AI will think there is something specific to test there and be confused …
  the entire CommCare app has the issue of needing to be validated."* Both closed
  `not planned`. **The bar for filing is a specific defect or a specific piece of
  work, not a general validation residual** — CLAUDE.md's "file the moment you've
  confirmed one" is about *confirmed defects*, and I over-applied it to
  not-yet-exercised code.
- **A closed issue is a bad anchor for current behaviour, and so is a new issue.**
  I correctly spotted that docs citing the CLOSED #1391 point at the opposite
  decision — then fixed it by filing #1466 as a "forward anchor," which is the
  same mistake wearing a different hat (and created the phantom work item above).
  The durable citation is a **merged PR** (stable history that cannot contradict
  itself) plus the **in-repo brief** (`_app-component-library.md §
  app-language-layer`), which is current by construction because the preventer
  test pins it. All 20 citations now read "PR #1463, superseding ace#968/#1391."
