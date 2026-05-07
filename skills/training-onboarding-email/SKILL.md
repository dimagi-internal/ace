---
name: training-onboarding-email
description: >
  Generate the LLO onboarding email body, consumed by llo-onboarding
  and personalized per LLO at send time. Owns one artifact.
disable-model-invocation: true
---

# Training Onboarding Email

Produce the onboarding email body — the message Phase 8
`llo-onboarding` sends to each LLO admin once the opportunity is
configured and ready. Audience: an LLO admin opening their inbox who
needs to (a) understand they have a new opportunity, (b) know how to
accept and start, (c) know where to ask questions.

## When to run

Phase 5 (`qa-and-training`), after the Connect opportunity exists
(Phase 3) and the OCS widget is configured (Phase 4). Phase 8
(`llo-onboarding`) reads this file and substitutes per-LLO
personalization tokens at send time.

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `ACE/<opp>/runs/<run-id>/1-design/idea-to-pdd.md` | one-paragraph opp framing for the email body |
| Phase 3 | `ACE/<opp>/runs/<run-id>/3-connect/connect-opp-setup.md` | opportunity name + URL |
| Phase 3 (`run_state.yaml`) | `connect.payment_units` | payment-summary line |
| Phase 4 | `ACE/<opp>/runs/<run-id>/4-ocs/ocs-setup_widget-handoff.md` (`widget_url`) | widget link in the email |
| Phase 5 (per-artifact training siblings) | `5-qa-and-training/llo-manager-guide.md`, `flw-training-guide.md`, `quick-reference.md` | links to the docs LLO will use |

## Output

Single file: `ACE/<opp>/runs/<run-id>/5-qa-and-training/training-onboarding-email.md`.

## Format

Markdown email body. Phase 8 substitutes these tokens at send time:

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

## Getting started

1. **Accept the opportunity invite** in your Connect dashboard:
   <opportunity URL from connect-setup/opportunity.md>
2. **Read the LLO Manager Guide** — your operations playbook:
   <Drive URL of llo-manager-guide.md>
3. **Print the FLW Quick Reference card** for each FLW:
   <Drive URL of quick-reference.md>
4. **Send the FLW Training Guide to your roster** before they start:
   <Drive URL of flw-training-guide.md>

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

- **Personalization tokens use `{{TOKEN}}` syntax** so Phase 8 can
  substitute. The set is fixed: `LLO_NAME`, `LLO_FIRST_NAME`,
  `LLO_ORG`. Don't introduce new tokens without coordinating a
  Phase-6-side update.
- **Every URL is a real URL** — no `<insert link here>` placeholders.
  All inputs are available at the time this skill runs.
- **One paragraph per section.** This is an email, not a manual; LLOs
  scan and click.
- **Subject line on the first line, prefixed `Subject:`** so Phase 8
  can extract.
- **Word count: 200-400.** Longer emails get skimmed and key links
  missed; shorter feels dismissive.

## Process

1. **Read inputs.** Drive paths in the table above.

2. **Resolve sibling-doc Drive URLs.** For each of llo-manager-guide,
   flw-training-guide, quick-reference, look up the file's
   webViewLink via `drive_list_folder` on
   `ACE/<opp>/runs/<run-id>/5-qa-and-training/`. If any of them
   doesn't exist yet, that's a phase-ordering bug — fail with a clear
   pointer.

3. **Compose the email body** using the format above. Keep it tight.

4. **Self-check before write.** Verify:
   - Subject line is present and ≤ 78 chars
   - Every URL is a real URL (no `<...>` placeholders, no `TODO`)
   - Word count 200-400
   - All three sibling docs are linked
   - Widget URL is the actual `widget_url` from
     `ocs-setup/widget-handoff.md`
   - The three personalization tokens are used (none more, none
     fewer)

5. **Write** to `ACE/<opp>/runs/<run-id>/5-qa-and-training/training-onboarding-email.md`
   via `drive_create_file`.

6. **Self-evaluate (LLM-as-Judge).** Four criteria:
   - **Subject + token discipline:** subject ≤ 78 chars, exactly
     `LLO_NAME`/`LLO_FIRST_NAME`/`LLO_ORG` tokens used
   - **URL hygiene:** all 4 URLs (opp + 3 docs + widget) are real
     URLs, not placeholders
   - **Word budget:** 200-400 words
   - **Audience fit:** professional but warm; no jargon-heavy
     phrasing

   Verdict to `ACE/<opp>/runs/<run-id>/5-qa-and-training/training-onboarding-email_verdict.yaml`.

7. **Hand off.** Print Drive URL + verdict summary.

## MCP Tools Used

- `ace-gdrive`: `drive_read_file`, `drive_create_file`,
  `drive_list_folder`

## Mode Behavior

- **Auto:** Run end-to-end.
- **Review:** Pause after step 4, show drafted email.
- **Dry-run:** Steps 1-4, skip write. Verdict with `dry_run: true`.

## Outputs

- `ACE/<opp>/runs/<run-id>/5-qa-and-training/training-onboarding-email.md`
- `ACE/<opp>/runs/<run-id>/5-qa-and-training/training-onboarding-email_verdict.yaml`

## Phase-ordering invariant

This skill must run **after** the other per-artifact training skills
(`training-llo-guide`, `training-flw-guide`, `training-quick-reference`,
`training-faq`) because the email body links to their outputs. Phase 5
sequencing in `agents/qa-and-training.md` enforces this.

## Why a separate skill

The onboarding email is consumed by Phase 8, not Phase 5. Pulling it
into its own skill makes the Phase-5 → Phase-7 boundary cleaner: this
skill produces the artifact Phase 8 reads, with no other Phase-5
side effects.

Sixth and final of the per-artifact training skills. The legacy
`training-materials` umbrella was removed in 0.10.89; the Phase 5
agent now dispatches each child directly.

## Change Log

- v1 (0.10.84): Initial skill. Owns `onboarding-email-body.md` only.
