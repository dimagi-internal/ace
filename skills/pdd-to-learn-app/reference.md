# pdd-to-learn-app — reference

Extended rationale, worked examples, and incident history for
`pdd-to-learn-app/SKILL.md`. None of this is executable: the skill
executes the Process steps, decision rules, and verbatim `REQUIRED:`
blocks in SKILL.md. This file exists so that prose moved out of the
skill (to keep the per-run context small) is not lost.

## focus-group sentinel rationale

The focus-group Learn app is a **minimal sentinel** — a single 1-form
readiness check, not a full training curriculum — because it satisfies
two constraints simultaneously:

1. **Connect API requirement.** `connect_create_opportunity` requires a
   non-null `learn_app` at the schema, REST request, and
   cross-field-validator layers. A no-Learn-app focus-group cannot be
   wired into a Connect opp. One sentinel per FGD opp is the working
   pattern (operator decision, 2026-05-15).
2. **In-app readiness gate.** The sentinel form gates whether the
   facilitator has completed the out-of-band training (OCS chatbot +
   handbook gdoc + coordinator-graded practice-session audio review). A
   facilitator must acknowledge readiness in CommCare before Connect
   treats them as cleared to submit attestation forms.

The actual training content lives **out-of-band** (the sentinel doesn't
carry it). See
`docs/superpowers/specs/2026-05-15-focus-group-archetype-redefinition.md`
for the operational model. The sentinel brief is short (one form,
~7 fields, both Connect markers set); Nova autobuild typically completes
in 1-2 minutes.

**Why "sentinel" and not "real training":** the FGD content lives in a
Google Doc out-of-band, not in a CommCare form (see
`pdd-to-deliver-app/SKILL.md § Archetypes § focus-group`). The real
training is correspondingly out-of-band — putting it into CommCare would
mean re-authoring all the facilitation craft content as in-app quizzes,
which is the old-shape pattern that the operator explicitly walked back
("not a 'thin focus group' — the only way we will do the focus group").
The sentinel is the minimum needed to satisfy Connect's API and add one
operational gate. It **does not duplicate or replace** the out-of-band
training.

**Where the real facilitator training lives (out-of-band):**

- **OCS chatbot** (Phase 5, per-opp) — primary reference surface for
  facilitation craft (silence handling, neutral probing, anti-anchoring,
  group dynamics) + post-session writing guidance ("what should I put in
  section 3 of my gdoc?"). Loaded with the PDD's Facilitation Protocol +
  Question Guide + Output Specification + a handbook gdoc.
- **Facilitator handbook gdoc** — the LLO's prep doc; distributed
  out-of-band, referenced from the OCS chatbot's RAG content.
- **Practice-session audio review** — the pre-fielding certification
  gate. Facilitator records a practice FGD, uploads the audio,
  coordinator reviews and either passes (cleared for live fielding, $50
  training stipend released, and the facilitator can answer `yes` to the
  sentinel's `acknowledge_readiness`) or fails-with-notes.

## REQUIRED-paragraph rationale (Step 3)

These notes explain *why* the Step 3 `REQUIRED:` paragraphs exist; the
executable instruction is the verbatim paragraph in SKILL.md.

### Connect-marker language is load-bearing

Without explicit "every content form needs `connect.learn_module` and
every quiz form needs `connect.assessment`" language in the brief,
autobuild often skips the per-form Connect blocks. See
`docs/learnings/2026-04-29-nova-connect-marker-bugs.md` § Bug 1.

### Angle-bracket placeholder ban

Nova's XForm emitter does not entity-encode `<`/`>` in label text, so a
literal placeholder becomes invalid XML when CCHQ parses the form during
`make_build`. Filed upstream as voidcraft-labs/nova-plugin issue "XForm
emitter does not entity-encode `<`/`>` in label text"; the skill-side
constraint is the workaround. Phase 3's `app-release` Step 2.7 surfaces a
typed `BuildRejectedError` (with form name + line/col) if the architect
violates this anyway, so the operator gets a clear diagnostic instead of
"Cannot make new version" and a CCHQ UI peek.

### Explicit Connect ids (slug-vs-name separation)

Vellum-authored apps separate Module ID / Name into two UI fields and
humans naturally pick short identifiers; Nova's API exposes the same two
fields but the architect has to set both explicitly because there's no UI
to nudge the separation. See
`docs/learnings/2026-05-17-connect-slug-length-50-char-trap.md`
§ Generalization (Vellum-as-source-of-truth) for the full mechanism +
source citations.

### ≤40-char name fallback

`leep-paint-collection` run 20260517-1515 Phase 4 hit the overflow on M6
(52-char slug derived from "Stage 2: Sample Preparation, Drying, Bagging,
Shipment"). The structural backstop is `app-release` Step 6's
`projected_connect_state.oversized_slugs` gate — even if the architect
ships an over-length slug, the release-time projection halts before
Phase 4 ever calls Connect. Removal criteria: (a) drop the ≤40-char
fallback when the upstream commcare-connect PR widens
`LearnModule.slug` / `DeliverUnit.slug` to `max_length=255` (PR
dimagi/commcare-connect#1195) and `SLUG_LENGTH_LIMIT` in
`mcp/connect/backends/commcare.ts` is bumped in lock-step. (b) KEEP the
explicit-id rule even after the column widens — it's a cleanliness
invariant matching Vellum's slug-vs-name separation.

### add_fields verify-then-retry

Nova's `add_fields` has a partial-persistence quirk: a single call with N
items often persists only the first few. Mid-build sessions where the
architect skipped verification have shipped forms that look complete in
the build summary but render with missing questions. See
`docs/learnings/2026-04-29-nova-connect-marker-bugs.md` § Bug 3.

### user_score percentage scoring

Connect's `passing_score` field is on a 0-100 scale (`passing_score: 80`
= "pass at 80%"). Raw-sum scoring produces max 5 for a 5-Q quiz; Connect
compares 5 < 80 and the FLW always fails even with perfect answers.
Reproducer: malaria-rdt run 20260523-1257 Phase 6 — J1 Deliver smoke
blocked at the Learn assessment screen with "Training Failed: score 5,
passing score 80." The architect summed raw points but Connect compared
5 < 80 and gated the FLW even though every answer was correct.

### No `<case>` blocks in Learn forms

Connect's Learn-app contract is form-only; case state is the Deliver
app's domain. Reproducer: `malaria-itn-app/20260521-1400` Phase 3 —
architect bound `standardization_gate_cleared` + `*_passed` flags to case
properties, all 6 Learn forms blocked at form-patch (`commcare-form-patch`
Step 8 wrapper-strip hits a Vellum-cache-drift class whenever a patched
form carries a `<case>` block — CCHQ's form-designer cache isn't
refreshed by `edit_form_attr`, and `make_build` rejects with "Cannot use
Case Management UI if you already have a case block in your form"). Phase
6 then halted on Connect → Learn CCZ install with "Unknown failure during
app install." Removal criteria: drop when voidcraft-labs/nova-plugin#7
ships (no wrappers → no patcher → no drift class) OR when
`commcare_patch_xform` gains Vellum-cache invalidation.

### Deployability (fitness) components

A label-only curriculum + one trivial quiz is NOT a deployable training
instrument; `pdd-to-learn-app-eval` hard-fails it (the ITN 9.6-on-a-
hollow-build root cause: a label-only curriculum + single 5-Q quiz with
an unconditional pass message). The canonical parameterized text for each
component lives in `skills/_app-component-library.md`, paired 1:1 with the
eval fitness dimension (`assessment_gating`, `instructional_depth`,
`localization_match`) that hard-fails a build omitting it.

## Step 4a safety net

Why we run the post-build field-count recipe even though `validate_app`
will catch some shortfalls downstream: `validate_app`'s
reference-integrity check only catches missing fields that ARE referenced
elsewhere (e.g. a `user_score` sum referenced by the Connect `assessment`
block). A form that's missing 3 of 5 quiz questions with no cross-
reference between them passes `validate_app` cleanly and ships to the FLW
broken at training time. Step 4a is the coverage-on-the-brief safety net
`validate_app` is structurally unable to provide.

Seen on `malaria-itn-fgd/20260514-2007`: a cert assessment shipped 12/15
score fields + 0/1 `user_score`, caught downstream by `validate_app`
rather than at build time (jjackson/ace#303). The architect can also run
out of budget mid-final-module and silently persist N-of-M expected
fields with no error — the safety net catches that too.
