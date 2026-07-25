
## Probes must not mutate shared demo-user state

`${ACE_E2E_PHONE}` is a **singleton**: every Phase 6 run, on every workstation,
uses that one Connect worker. Anything a probe does to it (invite, claim,
complete Learn) is a permanent edit to global state — `/ace:sweep connect`
does **not** clear `OpportunityAccess`, so the damage accumulates until the
phone is rotated in 1Password.

This is not theoretical. `scripts/probe-flw-invite.ts` (deleted 2026-07-25)
hardcoded three opportunity ids and invited the demo phone to all of them.
Two of those opportunities had a **null `end_date`**, which NPEs the CommCare
Android jobs-list sync — so the probe bricked every local mobile run until the
rows were repaired by hand. See dimagi-internal/ace#949 / #938, and
dimagi/commcare-connect#1401 for the server-side half.

Rules for any `scripts/probe-*.ts` that writes:

1. **Never hardcode an opportunity/program id.** Take it as an argv so the
   caller owns the blast radius, or create a scratch opportunity.
2. **Validate the target before writing to it** — an opportunity with a null
   `end_date` or a failing `is_setup_complete` must be refused, not invited to.
3. **Clean up in a `finally`.** If the probe cannot undo what it did, it should
   not do it.
4. **Prefer read-only.** Most questions ("is this invite linked?") are
   answerable from the workers table without mutating anything.
