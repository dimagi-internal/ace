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

## Revisions are a channel this ledger does not yet capture

The ledger models feedback as **comments** — `channel: gdoc-comments` is the canonical
example, items are keyed on the reviewer's own comment anchors, and `verbatim` is their
words. That covers a reviewer who reacts to a document.

It does **not** cover a partner who *edits* one. ACE opportunities are co-created with
partners (Jonathan, 2026-08-14), and `skills/share-run-access` now grants named partner
collaborators **editor** access on run artifacts (`drive_share_with_person`, default
`role: writer`). Feedback from a co-creator therefore also arrives as **Drive revisions**:
no anchor, no quote, nothing this schema can hold — so a partner who improves the PDD by
editing it directly produces zero ledger rows, and the completeness property above simply
doesn't apply to that channel.

Do not paper over it by transcribing someone's edit into a fake `gdoc-comments` item —
that fabricates words they never wrote, which is exactly what `verbatim` exists to prevent.
Until a revisions channel lands, note in the review record that edits were made and where,
and treat the ledger as covering the comment channel only.
Tracked: dimagi-internal/ace#1335.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Reviewer | gdoc comments / email / meeting notes | the verbatim items |
| Opp | `ACE/<opp>/feedback/<slug>.yaml` | the fact store (this skill creates it) |
| GitHub | issues + PRs carrying a `Feedback-Ref:` trailer | `skill-fix` dispositions |
| Run | `runs/<run-id>/decisions.yaml` rows with `feedback_ref` | `decision` dispositions |
| Opp | `ACE/<opp>/open-questions.md` | `open-question` dispositions |

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

Render with `renderLedgerMarkdown(ledger, orphans)` and publish to
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
