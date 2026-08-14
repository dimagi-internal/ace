---
name: feedback-ledger
description: >
  Capture an external reviewer's feedback verbatim, stamp every change made in response,
  and render the derived "where did my comment go?" view. Use when a domain expert or
  stakeholder reviews an ACE artifact (gdoc comments, an email of findings, a review
  meeting) and ACE is going to act on it — and again at the end of the next run, so the
  reviewer gets a DIFF instead of re-reviewing everything from scratch.
---

# Feedback ledger

**The ledger is a DERIVED VIEW, not a store.** It joins what ACE already keeps — GitHub
issues/PRs, a run's `decisions.yaml`, an opp's `open-questions.md` — against one small
new fact store: the verbatim inbound review. Implementation:
[`lib/feedback-ledger.ts`](../../lib/feedback-ledger.ts).

## Why it is built this way (read before changing it)

Origin: Sophie Feintuch's 2026-07-27 review of `hh-poverty-targeting/20260722-1341` —
the first time anyone outside the ACE authoring chain iterated on an ACE build. Nine
comments produced six skill defects (ace#979–#984), three run decisions, and one open
question. Two design constraints came out of it, both load-bearing:

1. **A defect is not a decision** (Jon, 2026-07-27: *"not everything can be constituted
   as a decision"*). ACE never weighed options and chose to ask `visit_outcome` first —
   it got it wrong. Writing that into `decisions.yaml` as a row with `options` and an
   `ai-default` fabricates a deliberation that never happened, and corrupts the one
   store whose worth depends on honestly recording what ACE actually considered. So
   feedback items are NOT forced into the decisions log.
2. **But a second hand-maintained changelog next to the decisions log would drift**
   (Jon, same exchange). So the ledger is *computed*, never curated. It reads the
   decisions log rather than shadowing it — the same posture as
   `docs/generated/playbook.md`, which is derived and explicitly not a source of truth.

Net: **one new fact store, one write-side convention, one derived view, zero new
judgment stores.**

## The completeness property (the point of the whole design)

The inbound record is the **denominator**. Every item renders whether or not anything
happened to it, so an item nobody actioned shows up as **UNROUTED** rather than
vanishing. A hand-written "what changed" note omits silently; this one accuses. A
`Feedback-Ref` pointing at an item that doesn't exist renders under **Broken stamps**,
so a typo can't quietly swallow a change either.

Do not "clean up" an UNROUTED row by deleting the item. Route it, or give it a
`declined` disposition with a reason.

## An edit is feedback too — and it is DERIVED, never double-written

A reviewer should not have to know or care which store their input landed in (Jonathan,
2026-08-14). Comment or edit, the experience and the visibility are the same.

ACE opportunities are co-created: `skills/share-run-access` grants named partner
collaborators **editor** access, and both the Workbench's authenticated editor and the
public run summary let a human CHANGE a decision. Those edits land in
`ACE/<opp>/inputs/decision-overrides.yaml` (`lib/decision-overrides.ts`, ace#933) and
bind on the next run. Before this, a reviewer who edited instead of commenting opened
their ledger and found it **empty**.

**The fix is a derivation, not a second write.** An edit must NOT also write a feedback
record — two stores holding the same fact drift, and this skill's whole premise is that
the ledger is derived and the stamp is the only write-side obligation. So the ledger now
reads `decision-overrides.yaml` as a **second source** and joins it into one per-person
view: `deriveEditEntries()` → `buildEngagements()` → `renderEngagementMarkdown()`.

### A comment RAISES; an edit ASSERTS — and only one of them can be dropped

Rendered in one list, in one time order, under one person — because to the reviewer it
was one conversation. But never blurred:

| | comment | edit |
|---|---|---|
| body | `> their words` (verbatim) | `**You changed it** \`old\` → \`new\`` + their reasoning if any |
| can it be dropped? | **yes** → `UNROUTED` | **no** — it already changed the next run's input |
| landing state | disposition status | `APPLIED` (a run recorded the value) / `PENDING NEXT RUN` (parked; binds when a run next raises the id) |
| ref | `<record-slug>/<item-id>` | `decision-edits/<decision-id>` |

**An edit is never UNROUTED.** That verdict means "your words were dropped"; an edit
cannot be dropped, so saying it would be a false accusation. What an edit CAN be is
not-yet-bound, which is a pending state, not a routing failure.

**But an edit still takes a stamp — for what follows FROM it.** "The value changed" and
"the work implied by the value changed" are different questions. A partner flipping
`photo-required: no → yes` binds the input by itself; the Deliver-form change that
follows still needs `Feedback-Ref: decision-edits/photo-required` like any other
response. Self-routing for its own value; stampable for its consequences. And the stamp
is *more* precise than a comment's — it names the decision row, not an opaque `[d]`.

`binding` is only `applied` when a run's `decisions.yaml` actually recorded that value.
Absent that evidence every edit reads `pending` — we do not claim an edit landed because
it was saved.

### Identity: a self-reported name is never a verified one

A record spells the reviewer `reviewer` + `reviewer_email`; an override row spells them
`decided_by_name` + `decided_by_verified`. They join on an **authenticated email only**.

Verification is baked into the identity KEY (`verified:<email>` vs
`self-reported:<name>`), so an unverified act is *structurally incapable* of landing in a
verified person's bucket — anyone can type "Sophie Feintuch" into the public summary's
name box. Unverified acts group by name among themselves, and the rendered page always
says **self-reported**. A `public-summary` record is self-reported by definition; every
other channel is a review ACE captured itself from a known counterpart.

Consequence worth knowing: a verified record with **no `reviewer_email`** cannot join to
that person's edits. Record the email if you want one unified list.

### Drive revisions are still NOT covered

`channel: revisions` exists so a record can be written, but deriving items from Drive's
`revisions.list`, using a diff as the item body in place of `verbatim`, and an "accepted
the partner's edit as-is" disposition are **not designed**. This section covers
STRUCTURED decision edits only. Do not transcribe someone's free-text document edit into
a fake `gdoc-comments` item — that fabricates words they never wrote.
Tracked: dimagi-internal/ace#1335.

## Provenance: a public reaction is not a colleague's comment

`channel: public-summary` marks a reaction left on the **public** per-run summary page —
an anonymous page with a **self-reported** name. ace-web writes these into
`ACE/<opp>/feedback/` as ordinary records, so this skill picks them up with no new
consumer, and the rendered ledger labels them self-reported so a reader can weigh them.

**The confidentiality boundary is a field, not a filename.** Use
`isPubliclyRepublishable(record)` (`lib/feedback-ledger.ts`) to decide whether a record
may appear on a page anyone can open — it is true only for `public-summary`. Everything
else was given in confidence, and a privately-captured review sits in the SAME folder.
Before ace#1362 the marker was smuggled into the record slug
(`<YYYYMMDD>-public-<reviewer>`) and ace-web filtered on it, which left a naming
convention one rename away from republishing a private review.

**Apply the boundary AT THE JOIN, not only per source.** Each source already filters
itself — ace-web republishes only `public-summary` feedback, and serves every override
row by policy (`project_override(include_email=False)`; attribution is the safety model
there, so names and reasoning are public and only the email is withheld). But a view
whose job is to MERGE them can reintroduce the leak both sources avoid: a private gdoc
review merged with public edits and published republishes the private review. Pass
`audience: 'public'` to `buildEngagements()` for anything destined for a page anyone can
open — it drops non-`public-summary` records and keeps edits, and merged output is
publishable only if every entry in it is. Default is `internal`, because the ledger gdoc
is an opp artifact, not a page.

Override rows carry **no** public/private marker at all, so this cannot be read off the
row — `isEditPubliclyRepublishable()` is where that policy lives, and it is the one place
a future private-edit surface would change.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Reviewer | gdoc comments / email / meeting notes | the verbatim items |
| Opp | `ACE/<opp>/feedback/<slug>.yaml` | the fact store (this skill creates it) |
| GitHub | issues + PRs carrying a `Feedback-Ref:` trailer | `skill-fix` dispositions |
| Run | `runs/<run-id>/decisions.yaml` rows with `feedback_ref` | `decision` dispositions |
| Opp | `ACE/<opp>/open-questions.md` | `open-question` dispositions |
| Opp | `ACE/<opp>/inputs/decision-overrides.yaml` | the reviewer's **edits** (derived, never written here) |

## Products

- `ACE/<opp>/feedback/<slug>.yaml` — the fact store (append-only)
- `ACE/<opp>/feedback/<slug>-ledger.gdoc` — the rendered view, one stable URL per review

## Process

### 1. Capture the review verbatim (once, on arrival)

Write `ACE/<opp>/feedback/<YYYYMMDD>-<reviewer-slug>.yaml` per `FeedbackRecordSchema`:

```yaml
schema_version: 1
slug: 20260727-sophie-feintuch      # MUST equal the filename stem
reviewer: Sophie Feintuch
reviewer_email: sfeintuch@dimagi-associate.com
received_at: 2026-07-27
channel: gdoc-comments
artifact: "PDD — Household Poverty Targeting Survey"
artifact_url: https://docs.google.com/document/d/1u-Qz.../edit
against_run: 20260722-1341
items:
  - id: d                            # prefer the reviewer's OWN anchor
    anchor: "§5 Visit definition"
    verbatim: >-
      visit_outcome is the first question in the form, which is impossible for an
      FLW to answer at that point.
```

**Rules that matter:**

- **`verbatim` is the reviewer's words, unedited.** Never paraphrase — the paraphrase is
  what drifts, and a reviewer must recognise their own comment on sight. If their point
  is unclear, keep the words and add your reading in the disposition, not here.
- **Reuse the reviewer's own ids.** A gdoc comment exported as `[a]`, `[b]`, `[c]` gives
  stable, mutually-legible anchors for free.
- **Append-only.** This file records what was *said*. It is never edited to reflect what
  was *done* — that is the join's job. Corrections get a new item, not a rewrite.
- **One file per review event**, not per reviewer. A second review from the same person
  is a new record with a new date slug.

### 2. Stamp every change you make in response

One field, three places. This is the ONLY write-side obligation:

| Disposition | Where the change lives | How to stamp |
|---|---|---|
| `skill-fix` | GitHub issue + PR | `Feedback-Ref: <slug>/<item-id>` trailer line in the issue body |
| `decision` | the run's `decisions.yaml` | `feedback_ref: <slug>/<item-id>` on the row |
| `open-question` | `ACE/<opp>/open-questions.md` | `<!-- feedback-ref: <slug>/<item-id> -->` on the entry |
| `declined` | the ledger call itself | pass a `declined` disposition with a reason |
| downstream of an **edit** | wherever the work lands | `Feedback-Ref: decision-edits/<decision-id>` — the edit itself needs no stamp; what follows from it does |

Stamp at the moment you act, not at the end — the same discipline as ACE's
issues-as-you-go convention, and for the same reason: batching loses the mapping.

### 3. Render the ledger (end of the responding run)

Collect dispositions from the three stores, then build + render:

```ts
import { parseFeedbackRecord, buildLedgerWithOrphans, renderLedgerMarkdown,
         extractFeedbackRefs } from '../../lib/feedback-ledger';
```

- **GitHub:** `gh issue list --search "Feedback-Ref <slug>" --state all --json number,title,url,body,state`
  then `extractFeedbackRefs(body)`. Map `state: CLOSED` + a merged PR → `shipped`;
  open → `pending`.
- **decisions.yaml:** rows carrying `feedback_ref` → `kind: 'decision'`, `link` the row
  id, `landedInRun` the run.
- **open-questions.md:** entries with the marker → `kind: 'open-question'`,
  `status: 'awaiting-human'` until answered.

- **decision-overrides.yaml:** `parseDecisionOverridesYaml()` → `deriveEditEntries(file,
  { boundValues, dispositions })`, where `boundValues` maps decision id → the value the
  run's `decisions.yaml` recorded. Without it every edit reads `PENDING NEXT RUN`.

For the unified per-person view, `buildEngagements({ records, edits, dispositions })` →
`renderEngagementMarkdown(engagement, orphans)`. `renderLedgerMarkdown(ledger, orphans)`
remains the single-review view. Publish to
`ACE/<opp>/feedback/<slug>-ledger.gdoc` via `drive_create_doc_from_markdown` — **one
stable URL per review**, updated in place on re-render so the reviewer can re-open the
same link after each run.

### 4. Put the diff in front of the reviewer

The gdoc is the durable artifact; the reply email is what they actually read. When
replying to the review thread, lead with the coverage line
(*"9 comments — 6 shipped, 2 need you, 1 unrouted"*), link the ledger, and name anything
still needing them. Never send a "here's the new run" with no diff — that is the
re-review-from-scratch failure this skill exists to prevent.

## Anti-patterns

- **Don't fold feedback items into `decisions.yaml` wholesale.** Only genuine decisions
  become rows (§ Why it is built this way).
- **Don't hand-maintain the ledger.** If you catch yourself editing the rendered doc,
  the stamp is missing upstream — fix that instead.
- **Don't delete an UNROUTED row to make the coverage line look better.** It is telling
  you something true.
- **Don't paraphrase into `verbatim`.**

## Mode Behavior

| Mode | Behavior |
|---|---|
| `default` | Capture + stamp + render; report the coverage line. |
| `auto` | Same; no pause. Ledger is read-only output. |
| `review` | Additionally surface every UNROUTED item as an explicit pause item. |

## Dry-Run Behavior

Print the rendered markdown; write nothing to Drive.
