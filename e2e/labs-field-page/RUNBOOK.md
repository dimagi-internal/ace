# Labs supply field page on the ACE emulator (ace#3348, no-PIN mode)

Status: PARTIAL. Preconditions and labs-side seed verified; the on-device legs were NOT run by this turn
(emulator lease failed readiness twice). Nothing here has been run end to end by this code.

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
