# Labs field page on the ACE emulator: e2e runbook

The connect-labs **field page** (`/supply/u/<token>/field/`, connect-labs #2787) is a lean
stock-count page a worker opens from an update link. This runbook drives it in the
**phone's own Chrome**, signed in as a pool test worker, and checks the result in labs.
No-PIN mode only (the link is issued without `require_verification`). ace#3348.

**The verdict is always labs, never the phone.** Chrome 113 on the emulator image stops
refreshing a page's accessibility tree after a network change, so Maestro can read a stale
page while the screen is right (§ Gotchas). The recipes produce screenshots; labs decides.

## Recipes (`mcp/mobile/recipes/static/`)

| Recipe | Does | Env |
|---|---|---|
| `labs-field-page-count.yaml` | Fresh Chrome (`clearState`), type the URL, assert "Stock for <org>" and no "Check it's you", choose Where and Product from their pickers, type qty and batch, Save, see it under "Sent from this phone" | `FIELD_URL ORG_NAME POINT_NAME ITEM_NAME QTY BATCH` |
| `labs-field-page-offline.yaml` | Reload the page, Airplane mode on from the shade, Save, see it under "Waiting to send" | `FIELD_URL ORG_NAME ITEM_NAME QTY BATCH` |
| `labs-field-page-reconnect.yaml` | Airplane mode off, wait, screenshot (no page assertions, by design) | none |
| `labs-field-page-photo.yaml` | Reload, choose Where and Product, type qty and batch, take a photo with the camera app (Shutter, Done), wait for "Photo ready", Save, see it sent | as `-count` |

Run each with `mobile_run_recipe` (`recipePath` = absolute path, `screenshotDir` under
`/tmp/ace-screenshots/`). Use a fresh `BATCH` per run: labs matches on it. `ITEM_NAME` is the
item's display **name** (e.g. "E2E co-pack"), not its sku: the picker lists names.

## Steps

1. **Preconditions.** `curl -s https://labs.connect.dimagi.com/supply/u/x/field/data.json`
   returns a body saying "This link is not valid" (a generic "Page not found" means the field
   page is not deployed). `supply_chain_update_link_issue`'s schema lists `connect_username`.
2. **Device.** `mobile_checkout_test_workers(n)`, then `mobile_release_test_workers(slots)` for
   any slot you must not use, then `mobile_ensure_avd_running`. The result's `test_worker.signed_in`
   names the slot.
3. **The worker's username** (not the phone number): `connect_list_flw_invites` on any opportunity
   the slot has claimed, with `phone`. The table's `connect_user_id` column holds the ConnectID
   username (20 hex chars). Cross-check: an HQ user in a domain the worker claimed into has that
   username as its local part (`lib/coach-session-capture.ts` `resolveAceTestUsername`).
   worker-3 (+74260000103) = `9396ba0f84bf47b63d85` (via ace-pm-org opp 2383, 2026-10-30).
4. **Labs data**, in a labs-only programme ACE owns (2026-10-30 used ACE Sandbox **10175**).
   Every write is an upsert by slug, so reruns reuse the rows:
   `supply_chain_commodity_upsert` → `supply_chain_org_upsert` (supplier org, buyer org) →
   `supply_chain_item_upsert` (`gtin_pack: "09501101530003"`) → `supply_chain_supplier_create` →
   `supply_chain_supply_point_upsert` (a warehouse) → `supply_chain_contract_create` →
   `supply_chain_supply_point_upsert` (`kind: user_held`, `connect_username` = step 3).
   Slugs used: `fieldpage-e2e-*`. IDs on 10175: org 376/377, item 280, supplier 983,
   points 503 / **504** (worker), contract 327.
5. **Link.** `supply_chain_update_link_issue` with `org_id`, `contract_ids`, `supply_point_ids`,
   `connect_username`, `expires_in_days: 1-2`, and NO `require_verification` and NO `send_via_bot`.
   Keep `field_url` out of the repo: the token is shown once and is a credential.
6. **Chrome needs Play services.** Registration leaves GMS disabled (face capture needs it off,
   `mcp/mobile/backends/avd.ts` `setGmsEnabled`), and Chrome then refuses to start. Re-enable it:
   `ANDROID_ADB_SERVER_PORT=<mobile_diagnose adb_server_port> adb -s <serial> shell pm enable com.google.android.gms`.
7. Run `labs-field-page-count.yaml`. **Verdict:** `supply_chain_stock_count_list(program_id,
   supply_point_id)` has exactly one new `physical_count` with your batch, quantity and
   `connect_username`; `supply_chain_update_link_list` shows `submission_count` up by one.
8. Offline leg: `labs-field-page-offline.yaml`, then read labs (**nothing new yet**), then
   `labs-field-page-reconnect.yaml`, then read labs (**exactly one** new count with that batch).
9. Photo leg: `labs-field-page-photo.yaml`, then `supply_chain_document_list(stock_count_id=<the new
   count>)` has one `photo` document (`photo.jpg`, ~15 KB). 2026-10-30: count 3747 + document 108.
10. Cleanup, always: `supply_chain_update_link_revoke`, `mobile_stop_avd` (releases workers),
   `mobile_release_test_workers({all: true})`. Labs records cannot be deleted; the programme is
   the isolation (`connect-labs-supply-chain.md` § What cannot be undone).

## On the `lease` backend: all legs pass (2026-11-02)

The 10-30 runs used the `local` backend. On a leased emulator (`mobile_ensure_avd_running`) the count, offline and
photo legs were run end to end on 2026-11-02 as worker-3, link revoked afterwards, results read from labs:

| Leg | Recipes (in this order) | Labs afterwards |
|---|---|---|
| count | `labs-field-page-count` | stock count 3768 (batch `LR1CNT`, qty 9), once |
| offline | `labs-field-page-airplane-settings` (`AIRPLANE_LABEL: on`) → `labs-field-page-offline-entry` → read labs: **no `LR1OFF`** → `labs-field-page-airplane-settings` (`AIRPLANE_LABEL: off`) → `labs-field-page-reconnect-entry` | stock count 3769 (`LR1OFF`, qty 4), once, only after the signal returned |
| photo | `labs-field-page-photo` | stock count 3770 (`LR1PHO`) + `photo` document 109 (`photo.jpg`, 15.6 KB) |

The link's `submission_count` read 3 at the end. What differs from the local backend, all of it observed:

- **No `adb`, so Chrome's "Enable Google Play services" dialog is dismissed with Back**, not `pm enable`. The count recipe
  does it only while the dialog is visible, then taps Chrome's "Continue" welcome button; a Back on a live page leaves Chrome.
- **The lease image's quick-settings shade has no Airplane tile** (Internet, Bluetooth, Flashlight, Do Not Disturb only), so
  `labs-field-page-offline` / `-reconnect` cannot run there. `labs-field-page-airplane-settings` toggles it from
  Settings → Network & internet instead (Settings then reads "Internet: Airplane mode is on"), and `-offline-entry` /
  `-reconnect-entry` are the same flow without the shade steps. The page stays open in Chrome while Settings is in front,
  which is the intended state: signal drops under an open page.
- **A first `Assert "Stock for <org>"` can fail right after an Airplane toggle** (the stale-accessibility-tree gotcha below)
  even though the dump shows the page; the same recipe passes on the next run.
- **Sign-in race.** `mobile_register_test_user` called while the baseline is still applying fails with `Failed to install
  apk ... Broken pipe` and leaves the device on a PIN lock screen; `mobile_ensure_avd_running` can fail the same way. Restore
  is `mobile_stop_avd` and a fresh lease, not adapting. Seen on 10-30 and again 11-01, and a lease can also fail with
  `LEASE_READINESS_FAILED: instance ... is gone before it was ready`. When canopy-web's lease API returned 500 on every
  call (2026-11-01), nothing helped; the broker frees an idle lease after 900 s.
- **Which worker you get.** `mobile_checkout_test_workers(n)` hands out the lowest free slots, so release the ones you do
  not want (`mobile_release_test_workers`) before `mobile_ensure_avd_running`, which signs in as the lowest held. worker-3 is
  the one with labs rows seeded (point 504); another slot needs its username from `connect_list_flw_invites` and a point.

## How the username was established

`connect_list_flw_invites` on ace-pm-org opp 2383, which worker-3 had claimed: its `connect_user_id`
column reads `9396ba0f84bf47b63d85` for +74260000103. The same column's values for worker-1 and
worker-2 match the local parts of their HQ usernames in connect-ace-prod, so it holds the ConnectID
username. The app's profile screen does not show it.

## Gotchas (all observed 2026-10-30, Chrome 113.0.5672.136, ACE_Pixel_API_34)

- **Stale accessibility tree.** After Airplane mode toggles, Maestro kept reading the page as it
  was (the pill "online", an entry "Waiting to send") for 90 s+ while the screen showed otherwise
  and labs had the record. A page load rebuilds it, which is why the offline recipe reloads first.
- **A `<select>` reads as its label** ("Where"), never its chosen option. Prove a list is
  populated by opening the picker and tapping the option.
- **The shade.** Target the tile as `Airplane mode, (On|Off)`: with Airplane mode on, the
  Internet tile also reads "…Airplane mode" and opens a dialog. Close the shade with Back only
  while a tile is visible; a stray Back navigates Chrome away.
- **Hide the keyboard between fields.** Otherwise the second tap can land in the first field.
  Once "E2E-OFF1" went into the number input, which kept "E21": the page saved **5E21 cartons**
  on the phone. Labs refused it on send with "Not accepted: Enter a quantity of zero or more."
- **Photo** (`capture="environment"`) opens the camera app directly, with no chooser and, on this
  image, no permission prompt: `com.android.camera2:id/shutter_button`, then `…:id/done_button`. The
  page shrinks it ("Photo ready (16 KB)") and labs stores it as a `photo` document linked to the
  count. The recipe guards the prompts a fresh profile could raise.
- **`send_via_bot` cannot be exercised on a labs-only programme**: the issue response carries
  `delivery: {sent: false, synthetic: true, reason: "Synthetic programme: nothing is sent."}`.
  Use ACE's own probe programme instead: **308** ("ACE-IT PM→NM probe", runner ace-pm-org) carries
  org 378, item 281 and worker-3's point 505 for this (slugs `fieldpage-bot-e2e-*`).
- **Sending by chatbot, observed 2026-10-30: labs and OCS work; the phone never received it.**
  `supply_chain_update_link_issue` with `send_via_bot` = the Chlorine Coach's public id
  (`b681ae47-…`, which has a `commcare_connect` channel) returned `delivery: {sent: true}`; the OCS
  session holds the Markdown link message and its trace reads Success. On worker-3 the "Chlorine
  Coach" channel appeared, its menu read "Unsubscribe" (subscribed), and a message typed on the phone
  reached OCS, but no OCS→phone message showed: not the two links, and not the bot's ordinary reply
  to that message, with Google Play services on or off. **Diagnosed 2026-11-01/02 (ace#3362): the send
  fails inside OCS, before the phone.** `POST /api/trigger_bot` answers 200 as soon as OCS accepts the
  request; the delivery to PersonalID happens afterwards and its failure is recorded only as the team
  notification "Message Delivery Failed for <bot>" (`An error occurred while delivering a message to
  <username> via Commcare_Connect`). A direct send to worker-1 (an old participant whose channel
  predates OCS #4715) fails the same way, so it is not new-participant channel creation, and not labs
  or the field page. OCS does not say why; the status PersonalID returned is in OCS's logs. **Read the
  failure, not the 200:** `scripts/ocs-delivery-failures.ts --participant <username> --since-minutes 5`
  ~25 s after the send (exit 2 = failed). `ocs_get_session` showing the message proves nothing. The link sent is the link's `url`
  (`/supply/u/<token>/`), not `field_url`.
