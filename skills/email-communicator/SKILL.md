---
name: email-communicator
description: >
  Send/receive email via GOG CLI using the ACE Gmail account. Utility
  skill — other skills delegate here for any Gmail operation.
disable-model-invocation: true
---

# Email Communicator

Send and receive email through the ACE Gmail account using the GOG CLI. This is a utility skill — other skills delegate to it whenever they need to send or read email rather than reimplementing Gmail access themselves.

### Configuration (preamble)

Requires these environment variables in `.env`:

| Variable | Description |
|----------|-------------|
| `ACE_GMAIL_ACCOUNT` | The Gmail account to send/receive from |
| `ACE_GMAIL_CLIENT` | The GOG OAuth client name for this account |

The GOG CLI must be installed (`brew install steipete/tap/gogcli`) and authenticated for the configured account: `gog login $ACE_GMAIL_ACCOUNT --client $ACE_GMAIL_CLIENT --services gmail`.

## Process

1. **Resolve configuration.** Read `ACE_GMAIL_ACCOUNT` and `ACE_GMAIL_CLIENT` from environment. Abort with a clear error if either is unset.

2. **Determine the operation.** The calling skill specifies one of: **send**, **reply**, **search**, or **read**.

3. **For send operations:**
   - Compose the email with recipient(s), subject, and body
   - Use: `gog gmail send --account $ACE_GMAIL_ACCOUNT --client $ACE_GMAIL_CLIENT --to <recipient> --subject <subject> --body <body>`
   - For CC: add `--cc <address>`
   - For multiple recipients: repeat `--to` flags
   - Capture the returned `message_id` and `thread_id` for logging

4. **For reply operations:**
   - Read the original message first (step 6) to get the thread context
   - Use: `gog gmail reply --account $ACE_GMAIL_ACCOUNT --client $ACE_GMAIL_CLIENT <message_id> --body <body>`
   - Replies maintain the thread automatically

5. **For search operations:**
   - Use: `gog gmail search "<query>" --account $ACE_GMAIL_ACCOUNT --client $ACE_GMAIL_CLIENT --json`
   - Common queries:
     - `from:<address>` — messages from a specific sender
     - `to:<address>` — messages sent to a specific address
     - `subject:<text>` — messages with subject containing text
     - `in:inbox` — inbox messages
     - `is:unread` — unread messages
     - `newer_than:1d` — messages from the last day
   - Combine with spaces: `from:user@example.com subject:onboarding is:unread`
   - Returns thread list with IDs, dates, senders, subjects

6. **For read operations:**
   - Use: `gog gmail read --account $ACE_GMAIL_ACCOUNT --client $ACE_GMAIL_CLIENT <message_id> --json`
   - Returns full message content including headers and body

7. **Log the operation.** Return the operation result (message IDs, thread IDs, search results) to the calling skill for logging to the opportunity's comms log in GDrive.

## MCP Tools Used

None — this skill uses the GOG CLI via shell commands, not MCP tools.

## Mode Behavior
- **Auto:** Execute email operations directly, return results to calling skill
- **Review:** For send/reply, present the composed email for human approval before sending. Search/read execute immediately.

## Dry-Run Behavior

When `--dry-run` is active:
- **Send/reply:** Print the full email (to, cc, subject, body) to stdout but do not send. Return a synthetic message ID for logging.
- **Search/read:** Execute normally (read-only operations are safe in dry-run).
