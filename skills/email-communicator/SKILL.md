---
name: email-communicator
description: >
  Send/receive email via GOG CLI using the ACE Gmail account. Utility
  skill — other skills delegate here for any Gmail operation. Sends go
  ONLY through bin/ace-email (hook-enforced, approval-gated).
disable-model-invocation: true
---

# Email Communicator

Send and receive email through the ACE Gmail account using the GOG CLI. This is a utility skill —
other skills delegate to it whenever they need to send or read email rather than reimplementing
Gmail access themselves.

**The send path is a rail, and approval is procedural.** Raw `gog gmail send`/`reply` under the ACE
identity is hard-blocked by the plugin's PreToolUse deny rail (`hooks/gating_guard.py` +
`config/gating.json`) — `bin/ace-email` is the only way email leaves ACE, which also guarantees the
comms-log threadId capture. The rail never prompts; *whether* a send is appropriate is governed by
the calling context's procedure (a run's pause-point mode, a turn's review posture) — see
`docs/superpowers/specs/2026-07-01-agent-operating-model-adoption.md § Gating`.

### Configuration (preamble)

Requires these environment variables in `.env` (also resolved by `bin/ace-email` itself from the
plugin data dir when not exported):

| Variable | Description |
|----------|-------------|
| `ACE_GMAIL_ACCOUNT` | The Gmail account to send/receive from (default `ace@dimagi-ai.com`) |
| `ACE_GMAIL_CLIENT` | The GOG OAuth client name for this account (default `ace`) |

The GOG CLI must be installed (`brew install steipete/tap/gogcli`) and authenticated for the
configured account: `gog login $ACE_GMAIL_ACCOUNT --client $ACE_GMAIL_CLIENT --services gmail`.
ACE uses its OWN gog client — never another agent's identity (and vice versa: echo never uses `ace`).

## Process

1. **Resolve configuration.** Read `ACE_GMAIL_ACCOUNT` and `ACE_GMAIL_CLIENT` from environment.
   Abort with a clear error if gog itself is missing.

2. **Determine the operation.** The calling skill specifies one of: **send**, **reply**, **search**,
   or **read**.

3. **For send operations:**
   - Write the body to a temp file (single-line paragraphs separated by blank lines; bullet lines
     one per line — `bin/ace-email` builds a reflowing HTML body + plain-text alternative; put the
     sign-off on its own paragraph, blank-line-separated).
   - Use: `bin/ace-email --to <recipient(s), comma-separated> [--cc <address>] --subject <subject> --body-file <path>`
   - Approval is procedural, per the calling context: in a turn or review-mode run, present the
     composed email (to/cc/subject/body) and get the human's yes before invoking; in auto-mode runs,
     the phase's pause-point governance applies. Use `--dry-run` to preview the rendered bodies.
   - Capture `message_id` and `thread_id` from the JSON result.

4. **For reply operations:**
   - Read the original message first (step 6) to get the thread context and the message id.
   - Use: `bin/ace-email --to <reply-all recipients> --subject "Re: <original>" --body-file <path> --reply-to-message-id <message_id>`
   - Replies maintain the Gmail thread via the message id.

5. **For search operations:**
   - Use: `gog gmail search "<query>" --account $ACE_GMAIL_ACCOUNT --client $ACE_GMAIL_CLIENT --json`
   - Common queries: `from:<address>`, `to:<address>`, `subject:<text>`, `in:inbox`, `is:unread`,
     `newer_than:1d` — combined with spaces.
   - Returns thread list with IDs, dates, senders, subjects.

6. **For read operations:**
   - Use: `gog gmail read --account $ACE_GMAIL_ACCOUNT --client $ACE_GMAIL_CLIENT <message_id> --json`
   - Returns full message content including headers and body.
   - **Always read with `--json` (the structured reader), never a raw text view.** A raw
     `gog gmail read` text dump hides `Cc:` — so a reply built from it silently drops the cc'd
     recipients. Take the recipient set (To + Cc) from the JSON headers, and choose reply-all vs.
     direct on purpose (`bin/ace-email --to <reply-all set>`). Per canopy
     `docs/agent-operating-model.md § 1b` reply-quality rule 5 (adopted by reference, jjackson/ace#828).

7. **Log the operation — the routing contract.** For every send/reply, the calling skill MUST record
   `thread_id` + `message_id` + recipients + date in the run's comms-log
   (`ACE/<opp>/runs/<run-id>/<N>-<phase>/<skill>_comms-log.md`). This is not optional bookkeeping:
   `inbox-triage` routes inbound replies to their opp/run by matching `thread_id` against comms-logs.
   A send without a logged `thread_id` produces an unroutable reply.

8. **Mark-read** (turn housekeeping, not part of normal skill sends): `bin/ace-mark-read <threadId> …`
   removes the UNREAD label after a turn fully handles a thread.

## MCP Tools Used

None — this skill uses the GOG CLI and the guarded `bin/ace-email` wrapper via shell commands, not
MCP tools.

## Mode Behavior
- **Auto:** Execute email operations directly (the phase's pause-point governance decides whether the
  send-bearing step runs at all), return results to the calling skill.
- **Review:** For send/reply, present the composed email in-conversation for human approval before
  invoking `bin/ace-email`. Search/read execute immediately.

## Dry-Run Behavior

When `--dry-run` is active:
- **Send/reply:** `bin/ace-email … --dry-run` prints the rendered plain + HTML bodies without sending
  (and without the approval gate). Also write the composed email to `comms-log/dry-run-<step>.md` per
  the skills README contract. Return a synthetic message ID for logging.
- **Search/read:** Execute normally (read-only operations are safe in dry-run).
