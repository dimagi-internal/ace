---
name: llo-invite
description: >
  Phase 6 step 2 (auto, default run). For each PDD-named candidate LLO,
  send an invitation email with the public solicitation URL. No-op when
  the PDD has no preferred_llos (long-term solicitation flow). Makes no
  Connect API calls — those happen for the awardee only, in
  llo-onboarding (Phase 7).
---

# LLO Invite

Phase 6 default-run skill. Runs after `solicitation-create` has captured
`opp.yaml.solicitation.public_url`. Sends each PDD-named candidate LLO an
email containing the solicitation URL, deadline, and a scope summary.

This skill replaces the previous Phase-7 (was Phase-6) `llo-invite` that
prepared a Connect-side invite roster. The Connect program-level invite
(`connect_send_llo_invite`) is now `llo-onboarding`'s responsibility and
fires only for the awardee.

## Inputs

- `ACE/<opp-name>/inputs/pdd.md` (specifically `## LLO Preference` →
  Preferred LLOs)
- `opp.yaml.solicitation.public_url`
- `opp.yaml.solicitation.deadline`
- `opp.yaml` (opp display name)

## Process

1. **Read `Preferred LLOs`** from the PDD's `## LLO Preference` section.
   Parse names + contact emails + organization slugs (each entry should
   declare all three; missing fields disqualify the entry).

2. **If empty (or all entries malformed):** write
   `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/llo-invite_invitations.md`:

   ```markdown
   # Solicitation Invitations

   Status: empty (long-term solicitation flow — no PDD-named candidates).

   The solicitation is publicly listed at <public_url>; orgs find it on
   the labs portal.
   ```

   Exit successfully.

3. **For each preferred LLO**, compose an email:

   ```
   Subject: Invitation to respond — <pdd.title>
   To: <preferred_llo.contact_email>

   Hi <name>,

   <Dimagi greeting + program summary, 2-3 sentences from PDD>

   We are inviting your organization to respond to a solicitation for
   <pdd.title>. The full description, scope of work, and response template
   are at:

       <opp.yaml.solicitation.public_url>

   Responses are due by <opp.yaml.solicitation.deadline> (UTC).

   To respond, sign into labs.connect.dimagi.com with your organization
   account, open the solicitation linked above, and click "Submit
   Response."

   Questions? Reply to this email.

   — The ACE team
   ace@dimagi-ai.com
   ```

   Send via the `email-communicator` skill (which uses ACE's Gmail
   account `ace@dimagi-ai.com`).

4. **Log every send** to
   `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/llo-invite_invitations.md`:

   ```markdown
   # Solicitation Invitations

   Solicitation: <public_url>
   Deadline: <deadline>
   Sent at: <ISO-8601 timestamp of this run>

   ## Recipients

   | Recipient | Org | Sent at | Status |
   |---|---|---|---|
   | <name>    | <org> | <ISO>  | sent |
   | <name>    | <org> | <ISO>  | failed: <reason> |
   ```

## Review-mode gate

If invoked under `/ace:run --review` mode, present the prepared email
list to the human before sending and pause. Default mode sends without
a gate (the orchestrator's external-comms gate is the Phase 6→7
boundary, not here — these emails are non-binding "please consider
applying" notes, not commitments).

## Error handling

- Per-recipient email failure: log `status: failed: <reason>` for that
  row, continue with the rest.
- All recipients fail: halt with a surfaced error pointing at the Gmail
  config in `/ace:doctor`.
- PDD has no `Preferred LLOs`: no-op per Step 2 above.
- `opp.yaml.solicitation.public_url` empty or
  `opp.yaml.solicitation.status != open`: halt with "run
  solicitation-create first" message.

## Output

- `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/llo-invite_invitations.md` — recipient log

## MCP Tools Used

- (Indirectly via `email-communicator`): GOG CLI for Gmail send.
- `ace-gdrive`: `drive_create_file`, `drive_read_file`,
  `drive_update_file`.

No Connect or Connect-Labs API calls in this skill.

## Mode Behavior

- **Auto:** Send all invitations.
- **Review:** Pause after composing, present recipient list + sample
  email body for approval.
- **Dry-run:** Steps 1-3 (no send), write `invitations.md` with
  `Status: dry-run`.
