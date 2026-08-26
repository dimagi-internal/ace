---
name: training-onboarding-email
description: >
  Generate the LLO onboarding email body, consumed by llo-onboarding
  and personalized per LLO at send time. Owns one artifact.
disable-model-invocation: false
---

# Training Onboarding Email

Produce the onboarding email body — the message Phase 9
`llo-onboarding` sends to each LLO admin once the opportunity is
configured and ready. Audience: an LLO admin opening their inbox who
needs to (a) understand they have a new opportunity, (b) know how to
accept and start, (c) know where to ask questions.

## When to run

Phase 6 (`qa-and-training`), after the Connect opportunity exists
(Phase 4) and the OCS widget is configured (Phase 5). Phase 9
(`llo-onboarding`) reads this file and substitutes per-LLO
personalization tokens at send time.

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `ACE/<opp>/runs/<run-id>/1-design/idea-to-pdd.md` | one-paragraph opp framing for the email body |
| Phase 4 | `ACE/<opp>/runs/<run-id>/4-connect/connect-opp-setup.md` | opportunity name + URL |
| Phase 4 (`run_state.yaml`) | `connect.payment_units` | payment-summary line |
| Phase 5 | `ACE/<opp>/runs/<run-id>/5-ocs/ocs-setup_widget-handoff.md` (`widget_url`) | widget link in the email |
| Phase 6 (per-artifact training siblings) | `6-qa-and-training/training-llo-guide.md`, `training-flw-guide.md`, `training-quick-reference.md` | links to the docs LLO will use |

## Output

Single file: `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-onboarding-email.md`.

## Format

Markdown email body. Phase 9 substitutes these tokens at send time:

- `{{LLO_NAME}}` — the LLO admin's display name
- `{{LLO_FIRST_NAME}}` — first name only, for the greeting
- `{{LLO_ORG}}` — the LLO's organization name

Everything else is opp-level and bakes into the source email body.

```markdown
Subject: Your new ACE opportunity is ready — <Opportunity Name>

Hi {{LLO_FIRST_NAME}},

Your team's new ACE opportunity is configured and ready for FLW
invites. Here's everything you need to start.

## What this opportunity is about

<one-paragraph opp framing from PDD intervention summary, ~3-4 sentences>

## Your one next step

**Accept the opportunity invite** here — it takes about 5 minutes, and
we'd like it done by <deadline: absolute date, or "within 3 working
days">:
<opportunity URL from connect-setup/opportunity.md>

## Then, before your FLWs start

- **Read the LLO Manager Guide** — your operations playbook:
  <Drive URL of training-llo-guide.md>
- **Print the FLW Quick Reference card** for each FLW:
  <Drive URL of training-quick-reference.md>
- **Send the FLW Training Guide to your roster**:
  <Drive URL of training-flw-guide.md>

## What FLWs get paid

<one-line summary from connect.payment_units — amount per visit + max-per-day>

## Where to ask questions

The OCS support widget at <widget_url> answers questions about this
opportunity in particular — payment rules, verification flags, the
education message script, what to do when X. Open it any time.

For platform-level questions or escalations, reply to this email.

## Next 48 hours

We'll check in once your first 5 FLW submissions land to make sure
quality looks right. If you have questions before then, ping the
widget or reply here.

Thanks for partnering with us, {{LLO_FIRST_NAME}} — looking forward
to seeing the data.

— The ACE team
ace@dimagi-ai.com
```

## Format rules

- **Personalization tokens use `{{TOKEN}}` syntax** so Phase 9 can
  substitute. The set is fixed: `LLO_NAME`, `LLO_FIRST_NAME`,
  `LLO_ORG`. Don't introduce new tokens without coordinating a
  Phase-7-side update.
- **Every URL is a real URL** — no `<insert link here>` placeholders.
  All inputs are available at the time this skill runs.
- **One paragraph per section.** This is an email, not a manual; LLOs
  scan and click.
- **Subject line on the first line, prefixed `Subject:`** so Phase 9
  can extract.
- **Word count: 200-350 (excluding URLs).** Longer emails get skimmed
  and key links missed; shorter feels dismissive. This band is the
  eval's, not an independent judgement — `training-onboarding-email-eval`
  scores `length_discipline` 10 only inside 80–350, so 200–350 is the
  intersection of "not dismissive" and "scores clean". Do not restate it
  as a wider band here; the eval is authoritative (ace#1673).
- **Exactly ONE primary call to action, and it carries a deadline, a
  time estimate, and a real link.** Everything else is a follow-on, not
  a competing ask — a four-item numbered "getting started" list reads as
  four CTAs and the independent eval scores that shape at 3 (ace#1654).
  Preserve the "Your one next step" / "Then, before your FLWs start"
  split above; don't collapse them back into one numbered list.

## Process

1. **Read inputs.** Drive paths in the table above.

2. **Resolve sibling-doc Drive URLs.** For each of llo-manager-guide,
   flw-training-guide, quick-reference, look up the file's
   webViewLink via `drive_list_folder` on
   `ACE/<opp>/runs/<run-id>/6-qa-and-training/`. If any of them
   doesn't exist yet, that's a phase-ordering bug — fail with a clear
   pointer.

3. **Compose the email body** using the format above. Keep it tight.

4. **Self-check before write.** Verify:
   - Subject line is present and ≤ 78 chars
   - Every URL is a real URL (no `<...>` placeholders, no `TODO`)
   - Word count 200-350, excluding URLs
   - All three sibling docs are linked
   - Widget URL is the actual `widget_url` from
     `ocs-setup/widget-handoff.md`
   - The three personalization tokens are used (none more, none
     fewer)
   - Exactly one primary CTA, and it carries a deadline, a time
     estimate, and a real link (ace#1654)

5. **Write** to `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-onboarding-email.md`
   **as a NATIVE Google Doc via `drive_create_doc_from_markdown`** — NOT
   `drive_create_file`, which uploads the body as `text/plain` so every `##`,
   `**`, `|` and `---` stays a literal character on the page. This document is
   read by a human (the LLO contact who receives this email body), and a partner opening it should see headings,
   bold and tables, not markdown source. The renderer round-trips: a properly
   formatted doc exports back to clean markdown via
   `drive_read_file(exportAs: 'text/markdown')`, so nothing machine-readable is
   lost — whereas a `text/plain` upload exports ESCAPED (`\---`, `run\_id`).
   Same find-or-create semantics: a same-name file under the parent is
   overwritten IN PLACE, so the fileId — and any sharing already applied to it —
   survives. (dimagi-internal/ace#1338; sibling of the PDD fix, ace#1061.)

6. **Self-evaluate (LLM-as-Judge).** Five criteria:
   - **Subject + token discipline:** subject ≤ 78 chars, exactly
     `LLO_NAME`/`LLO_FIRST_NAME`/`LLO_ORG` tokens used
   - **URL hygiene:** all 4 URLs (opp + 3 docs + widget) are real
     URLs, not placeholders
   - **Word budget:** 200-350 words, excluding URLs
   - **Audience fit:** professional but warm; no jargon-heavy
     phrasing
   - **Call to action:** grade all four of —
     1. **exactly one PRIMARY ask.** "Getting started" is a numbered
        list of four actions; name which one is the ask (accept the
        opportunity invite) and let the other three read as what
        follows, not as four competing CTAs.
     2. **a deadline.** Absolute ("by Friday 12 Sept") or relative
        ("within the next 3 working days"). "Soon" is not a deadline.
     3. **a time estimate** for the primary ask ("takes about 5
        minutes").
     4. **a named link or contact** for that ask — the actual
        opportunity URL, not "your Connect dashboard".

     Score 10 only with all four present. Missing a deadline OR a time
     estimate caps this criterion at 6. No CTA at all, or multiple
     competing CTAs, caps it at 3 — and cap the OVERALL self-score at
     6.5, because that is where the independent eval lands.

   Verdict to `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-onboarding-email_verdict.yaml`.

   **Why the CTA criterion exists (ace#1654).** This rubric had four
   criteria and none of them was CTA, while
   `training-onboarding-email-eval` weights **call-to-action
   effectiveness at 0.25** with a `-5` hard deduct — so 25% of the
   independent score rode on an axis the producer was never asked to
   check. On bednet-check-2-visit/20260825-1310 the producer self-graded
   **9.3** and the independent eval returned **6.90 / warn** (no
   deadline, no time estimate, diluted CTA): a **2.40** delta, well
   outside the ±1.5 target. The artifact was revised to **8.95 / pass**,
   so the artifact was never the defect — the missing axis was. A
   self-eval that cannot see the axis it is graded on inflates on it
   every time. The anchors above are deliberately the eval's own, so the
   two rubrics agree; **keep them in sync with
   `skills/training-onboarding-email-eval/SKILL.md § LLM-as-Judge
   Rubric` — if they diverge, the eval is authoritative.**

7. **Hand off.** Print Drive URL + verdict summary.


8. **Share it anyone-with-link.** The onboarding email is a deliverable a partner opens from
   the run summary — a private Doc opens only for accounts explicitly shared on
   it, so a recipient following the link hits *You need access*. Nothing
   upstream catches this: the doc exists, has the right words, passes every
   content eval, and returns a 401 that a link checker reasonably reads as
   "auth-gated" (the correct verdict for a Connect/HQ/OCS login gate, the wrong
   one here).

   ```
   drive_set_anyone_with_link(fileId: <docId>, role: 'commenter')
   ```

   `role: 'commenter'` rather than `reader` — a partner reviewing a training
   deliverable should be able to leave feedback on it. Do this at creation, not
   as a cleanup step: on hh-poverty-targeting/20260722-1341 all six training
   links shipped private and were shared by hand afterwards. (ace#902; enforced
   by `test/lib/recipient-facing-artifacts.test.ts`.)

## MCP Tools Used
- `ace-gdrive`: `drive_set_anyone_with_link` — share the deliverable (ace#902).

- `ace-gdrive`: `drive_read_file`, `drive_create_doc_from_markdown` (the guide —
  human-facing prose, must render), `drive_create_file` (the verdict YAML —
  machine-parsed, must stay literal text), `drive_list_folder`

## Mode Behavior

- **Auto:** Run end-to-end.
- **Review:** Pause after step 4, show drafted email.
- **Dry-run:** Steps 1-4, skip write. Verdict with `dry_run: true`.

## Products

- `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-onboarding-email.md`
- `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-onboarding-email_verdict.yaml`
- `run_state.yaml.phases.qa-and-training.products.training.docs.onboarding_email` — `{file_id, title: "Onboarding email", web_view_link}` typed handoff. Multi-writer block: apply via read-modify-write per `skills/synthetic-data-generate/SKILL.md § Step 6`. See `agents/qa-and-training.md § Products` for the full slot table.

## Phase-ordering invariant

This skill must run **after** the other per-artifact training skills
(`training-llo-guide`, `training-flw-guide`, `training-quick-reference`,
`training-faq`) because the email body links to their outputs. Phase 6
sequencing in `agents/qa-and-training.md` enforces this.

## Why a separate skill

The onboarding email is consumed by Phase 9, not Phase 6. Pulling it
into its own skill makes the Phase-6 → Phase-8 boundary cleaner: this
skill produces the artifact Phase 9 reads, with no other Phase-6
side effects.

Sixth and final of the per-artifact training skills. The legacy
`training-materials` umbrella was removed in 0.10.89; the Phase 6
agent now dispatches each child directly.

## Change Log

- v3 (0.13.1000): Tighten the word band **200-400 → 200-350 (excluding
  URLs)** in all three places it is stated (§ Format rules, Process step 4,
  Process step 6). The producer authorised a band its own eval penalised:
  `training-onboarding-email-eval` scored `length_discipline` (0.05) 10 only
  inside 80–350, and `clarity` (0.30) capped at 6 at ≥ 350 — so an email in
  the upper half of the producer's own band lost **0.35 of total weight** for
  complying. Measured on hh-poverty-targeting/20260824-1404: a 390-word email
  scored clarity 6.5 and length_discipline 6.0, ~0.5 of overall 8.375 being
  the divergence rather than the artifact. Same class as ace#1654 (a producer
  graded on an axis it cannot see) and resolved the same way — the eval is
  authoritative, the producer moves. The eval side dropped `clarity`'s
  length anchors so length is scored in exactly one dimension. Closes
  ace#1673; enforced by `test/skills/onboarding-email-word-band.test.ts`.
- v2 (0.13.99x): Add the **call to action** criterion to the Step 6
  self-eval, and split the format template's four-item "Getting started"
  list into one primary ask plus follow-ons. Closes ace#1654 — the
  self-eval had no CTA dimension at all while
  `training-onboarding-email-eval` weights it 0.25 with a `-5` hard
  deduct, producing a 2.40 self-vs-independent delta on
  bednet-check-2-visit/20260825-1310 (9.3 self → 6.90/warn independent →
  8.95/pass after revision). The eval was NOT weakened to match.
- v1 (0.10.84): Initial skill. Owns `training-onboarding-email.md` only.
