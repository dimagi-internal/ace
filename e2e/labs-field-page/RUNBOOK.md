# Labs supply field page on the ACE emulator (ace#3348, no-PIN mode)

Result of the run on 2026-10-30: **PASS** for the success criterion (labs shows the entry the phone sent).
Offline, photo, bot delivery and scan legs were not completed; see "Not done".

## What it proves
The connect-labs field page (`/supply/u/<token>/field/`) opens in Chrome on the ACE emulator, signed in as a
test PersonalID worker (pool slot worker-3), with NO code prompt (link issued without `require_verification`),
and a Save reaches labs exactly once, attributed to the worker's `connect_username`.

## Run order
1. Precondition: `curl -s https://labs.connect.dimagi.com/supply/u/x/field/data.json` says "This link is not valid"
   (404). `supply_chain_update_link_issue` schema lists `connect_username`.
2. `mobile_checkout_test_workers(3)`, then `mobile_release_test_workers(["worker-1","worker-2"])`. The pool hands out the
   lowest free slots; keep worker-3 or higher.
3. `mobile_ensure_avd_running(cc-2.64.0)` (blocking) signs in as the held worker. Do not call
   `mobile_register_test_user` while the baseline is still applying: it fails with `Failed to install apk ... Broken pipe`
   and leaves the device on a PIN lock screen. Recover by `mobile_stop_avd` and leasing again, not by adapting.
4. Labs data (synthetic programme 10175, "ACE Sandbox"; nothing real): org 376, commodity `fieldpage-e2e-ors-zinc`,
   item 280 (`gtin_pack` 09501101530003), supplier 983, contract 327, user_held supply point 504 whose
   `connect_username` is the worker's. Issue the link: `supply_chain_update_link_issue(program_id=10175,
   data={org_id:376, connect_username, contract_ids:[327], supply_point_ids:[504], expires_in_days:1})`.
   No `require_verification`, no `send_via_bot`. The raw `url`/`field_url` is shown once.
5. `recipes/03-open-field-page.yaml` with `envVars {FIELD_URL: <field_url>}`. Asserts "Stock for.*".
6. `recipes/05-enter-count.yaml` with `envVars {QTY, BATCH}`.
7. Verify in labs, not on the phone: `supply_chain_stock_count_list(program_id, supply_point_id=504)` shows ONE new
   `physical_count` with that quantity/batch and the worker's `connect_username`; `supply_chain_update_link_list` shows
   the link's `submission_count` 1.
8. Cleanup: `supply_chain_update_link_revoke`, `mobile_release_test_workers(all=true)`, `mobile_stop_avd`.

## Gotchas found (each cost a failed run)
- A fresh lease can sit on the lock screen; swiping up (`00-reset.yaml`) unlocks it. A PIN lock means a half-finished registration: re-lease.
- The image has no Google Play services: Chrome opens a blocking "Enable Google Play services" dialog. Back dismisses it
  (the recipe does this only when the dialog is visible; an unconditional Back exits Chrome).
- Chrome's new-tab search box has no matchable id/text; tap it by position. Maestro rejects decimal percentages ("8.8%").
- Do not declare an `env:` default in a recipe: it overrides the value passed in `envVars` (the empty default was typed).
- `inputText` of the ~100-character link takes ~40 s; that is normal.
- Failure output of `mobile_run_recipe` is ~80 KB; read the `-FAILURE.png` in the screenshot dir instead of the text.

## Result (2026-10-30, link 107, since revoked)
| Step | Result | Evidence |
|---|---|---|
| Labs deploy live, schema has `connect_username` | PASS | 404 "This link is not valid"; schema read |
| Page opens, "Stock for Field Page E2E Distributor", pill "online", no "Check it's you" | PASS | evidence/01-field-page-open.png |
| Product and place lists populated | PASS | same screenshot (Where: ACE Test 3, Product: E2E co-pack) |
| Enter 6 / batch E2ER2A, Save | PASS | evidence/02-after-save.png ("Saved on this phone", "Sent from this phone" card) |
| Labs has ONE `physical_count`, qty 6, username matches | PASS | stock_count 3745; link 107 `submission_count` 1 |

## Not done
- Offline leg: the quick-settings shade here has only Internet, Bluetooth, Flashlight, Do Not Disturb (evidence/03); no
  airplane tile, and the emulator also has a cellular path, so turning Wi-Fi off may not cut connectivity. Needs a way to
  cut the network that is proven to (not attempted further).
- Photo via camera, bot delivery (`send_via_bot`), tap-to-scan: not attempted this run.
- The username `9396ba0f84bf47b63d85` came from the existing supply point (seeded by an earlier session today); it was not
  read from the app. The page header shows it ("For 9396ba0f..."), but whether it is the worker-3 PersonalID username is unconfirmed.
