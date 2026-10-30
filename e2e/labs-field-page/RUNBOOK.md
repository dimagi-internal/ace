# Labs supply field page on the ACE emulator (ace#3348, no-PIN mode)

Status: **the field page was exercised from a phone-side browser on 2026-10-30 (verified in labs below); this runbook
as a script has NOT been run end to end.** The turn that wrote it could not reach the device (emulator lease failed
readiness twice), and the earlier session that did reach it left no script and no screenshots.

## What labs shows from the earlier run (2026-10-30 12:16-12:46 UTC) — read back by Hal, not asserted by ACE
Programme 10175, supply point 504 "ACE Test 3 (field page e2e)", update link **105** (no `require_verification`,
no `send_via_bot` = the no-PIN mode; created 12:16:58, last used 12:46:07, revoked 12:46:45, `submission_count` 5):

| count id | batch | qty | what it exercises |
|---|---|---|---|
| 3740 | E2E-B7 | 12 | online entry |
| 3741 | E2E-B8 | 7 | online entry |
| 3742 | E2E-OFF2 | 4 | entered offline, sent later |
| 3743 | E2E-OFF3 | 3 | entered offline, sent later |
| 3744 | E2E-PH1 | 2 | with a photo: document 107, `image/jpeg`, 15,798 bytes (shrunk on the phone), `stock_count_id` 3744 |

All five: `physical_count`, `source=partner_reported`, `connect_username` `9396ba0f84bf47b63d85`, one org (376).
Link 106 (`send_via_bot` attempt) sent nothing (`sent_at` null, no error recorded).

**Still unproven:** that `9396ba0f84bf47b63d85` is worker-3's PersonalID username (not read from the app profile);
that it was the emulator's Chrome rather than another browser; and the live-camera scan. No screenshots survive. The
laptop session that did it ("c-note-this-brief-was-first-queued-0814", spawned 12:11 UTC on jj-mbp-cdp) may still hold
them (`/tmp/ace-screenshots/fieldpage/`).

## Run order
1. Precondition: `curl -s https://labs.connect.dimagi.com/supply/u/x/field/data.json` body says "This link is not valid"
   (verified 2026-10-30 ~16:00 UTC, HTTP 404). `supply_chain_update_link_issue` schema lists `connect_username`.
2. Check out a pool worker with `mobile_checkout_test_workers(3)`, then `mobile_release_test_workers` the lowest slots
   you must not use (the pool hands out the lowest free slot; worker-1/2 are not ours to use).
3. `mobile_ensure_avd_running(cc-2.64.0, prewarm)`, wait for baseline (~75 s after boot), then
   `mobile_register_test_user(slot=worker-3)`. Do NOT call register while the baseline is still applying:
   the first attempt failed with `Failed to install apk ... Broken pipe`, and the half-finished
   registration left the device on a PIN lock screen (`recipes/00-reset.yaml` swipes the lock screen but cannot pass a PIN).
   Restore = `mobile_stop_avd` and lease again, not adapt.
4. Labs seed (programme 10175, ACE Sandbox, synthetic): see "Existing seed" below. Issue a link with
   `connect_username`, no `require_verification`, no `send_via_bot`. Keep the raw `url` and `field_url`.
5. In Chrome type `field_url` into the address bar. Assert "Stock for <org>", never "Check it's you".
   Pick Where/Product, enter How many + Batch, Save. Assert it shows under "Sent from this phone", pill "online".
6. Verify in labs: `supply_chain_stock_count_list(supply_point_id)` has one `physical_count` with that quantity and
   `connect_username` = the worker's; `supply_chain_update_link_list` shows `submission_count` 1.
7. Cleanup: `supply_chain_update_link_revoke`, `mobile_stop_avd`, `mobile_release_test_workers(all=true)`.

## Existing seed (found, not created by this turn; made by an earlier session today)
Programme 10175; org 376 "Field Page E2E Distributor"; commodity `fieldpage-e2e-ors-zinc`; item 280 (gtin_pack 09501101530003);
supplier 983; contract 327; user_held supply point 504 with connect_username `9396ba0f84bf47b63d85`.
The username's provenance is unverified by this turn: confirm it against the app profile before trusting it.

## Blockers seen
- `ACE_E2E_*` / `ACE_CONNECT_APK_VERSION` absent from this runner's env, so `mobile_ensure_avd_running` (blocking) returns
  DEVICE_USER_STATE_WIPED; only the `slot=` register path avoids it. Needs `/ace:setup --force-env` + restart.
- Two consecutive `LEASE_READINESS_FAILED: instance ... is gone before it was ready`.
