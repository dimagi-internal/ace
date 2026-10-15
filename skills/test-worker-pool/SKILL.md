---
name: test-worker-pool
description: >
  Check out, add, or retire Connect test workers in ACE's named pool, one device session each. Use when a test needs more workers than are free, or a worker's invite list has grown too long.
disable-model-invocation: false
---

# Test Worker Pool

ACE signs every device session (local AVD, leased emulator, phone) into Connect
as one **test worker**, a `+7426` demo PersonalID account. Each sign-in is a
PersonalID recovery that moves the account to the newest device. If two sessions
use the same worker at once, the older one gets "Account in use on another
device" (ace#2934). So the workers form a small **named pool**. A device session
checks one worker out exclusively and holds it for as long as it is signed in.

The owner's direction (Jon, 2026-10-15, ace#2955): *"a clear process for multiple
test users and creating more if we need to, but I don't want to proliferate users
on every run."* Adding a worker is a deliberate step, taken rarely. Never mint a
worker per run: `ACE_PER_RUN_TEST_USER` stays off.

## How the pool works

| Piece | Where |
|---|---|
| Slot names (`worker-1`…) | `infra/capabilities/test-worker/capability.yaml` `slots:` (published to canopy-web) |
| `worker-1` credentials | 1Password item `connect-test-user` → `ACE_E2E_*` |
| `worker-2+` credentials | 1Password item `connect-test-workers`, field `pool-json` → `ACE_E2E_WORKERS` (JSON keyed by slot) |
| Credential parsing + validation | `lib/test-worker-pool.ts` |
| Exclusive checkout (the lock) | canopy-web `test-worker` pool capability, via `lib/test-worker-lease.ts` |
| Doctor signal | `/ace:doctor` → `test_worker_pool` |

- `mobile_ensure_avd_running` checks out **one** worker before it registers, signs
  the device in as that worker, heartbeats the lease while the session lives, and
  reports the worker as `test_worker` in its result. `mobile_stop_avd` and process
  exit release it.
- A multi-worker test (the case-sharing test needs 4 workers on one opportunity)
  calls `mobile_checkout_test_workers({count: 4})`. It then signs the device in as
  each worker in turn with `mobile_register_test_user({slot})` and ends with
  `mobile_release_test_workers` or `mobile_stop_avd`.
- When the pool is full, a checkout waits up to 10 minutes. After that it fails
  `TEST_WORKER_POOL_EXHAUSTED` and names who holds each slot. **It never shares a
  worker.**
- **Passing an explicit `testUser` to `mobile_ensure_avd_running`, or an explicit
  `phone` to `mobile_register_test_user`, takes no lock.** No pool slot describes
  that identity. The case for this is the add-worker walk below, which registers a
  number before it joins the pool.
- **Rollout fallback.** Sometimes the lock cannot be taken: the `test-worker`
  capability is not yet published or granted on canopy-web (422 or 403), or the
  machine has no canopy-web PAT. In that case a single-worker session goes ahead
  **unlocked as worker-1**, which is the behaviour before ace#2955. It prints a loud
  warning that names ace#2955 and the publish step. `mobile_diagnose`
  (`test_workers`) and `/ace:doctor` (`test_worker_pool` WARN) keep showing the
  fallback until it is fixed. A multi-worker checkout never falls back: it fails
  with `TEST_WORKER_POOL_UNAVAILABLE`.

## When to add a worker

- **The pool is too small for a test.** A test needs k workers at once and the pool
  has fewer than k slots. Running out because other sessions hold them is
  different: wait, or ask the holders named in the error.
- **Concurrent sessions keep queueing.** `TEST_WORKER_POOL_EXHAUSTED` is a routine
  result, not a one-off.
- **Replacing a retired worker** (see below).

## When to retire a worker

- **Its invite list has grown too long.** Claiming an opportunity flips its invite
  to `accepted`. `connect_delete_unaccepted_flw_invites` cannot remove accepted
  invites, so each worker's In Progress list grows by one card per claimed
  opportunity, forever. That makes the Phase 6 tile scroll slower (the ace#1289
  scroll cost). Retiring the worker and adding a fresh one resets it. This
  replaces per-run minting as the fix for #1289.
- **Its account is broken** server-side and recovery does not heal it.

## Inputs

- The pool as this machine sees it: `ACE_E2E_*` (worker-1) and `ACE_E2E_WORKERS`
  in ACE's `.env`.
- The manifest slots in `infra/capabilities/test-worker/capability.yaml`.
- A device (`mobile_ensure_avd_running`) for the one-time registration walk.

## Products

- A new worker, registered once on Connect and stored in the 1Password pool item.
- Its slot listed in the manifest and published to canopy-web.

## Process

### Add a worker

1. **Plan it.** Run the planner from the installed plugin:

   ```bash
   ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/test-worker-add.ts" [--avoid +7426…,+7426…]
   ```

   It prints the next slot
   and the next unused `+7426` number. The slot is the first manifest slot with no
   credentials behind it, or else one past the highest slot. The number is one past
   the highest pool number. Pass `--avoid <phone,…>` to skip numbers you know are
   taken, such as retired workers, whose Connect accounts still exist and must
   never be reissued. The script is read-only.
2. **Invite the number to a Connect opportunity first.** PersonalID refuses a
   sign-up from a device that fails Google Play Integrity ("this device did not
   pass the security checks required to sign up for PersonalID"), and ACE's
   emulators fail it. The one exception is a number Connect already holds an
   invite for: `dimagi/connect-id` `utils/app_integrity/decorators.py`
   `require_app_integrity` lets the request through when
   `check_number_for_existing_invites` is true, and Connect answers that from
   `UserInvite.objects.filter(phone_number=…).exists()`. So call
   `connect_send_flw_invite` for the new number on any active ACE test
   opportunity (not a partner's, and never Smallholder Seasonal), then confirm
   the row exists with `connect_list_flw_invites`. Observed 2026-10-15
   (ace#2955): worker-2 was refused with no invite and signed up once invited.
3. **Register it once on a device, using the fresh-signup path.** With a device up,
   call `mobile_register_test_user` with the new identity: `phone`, `phoneLocal`,
   `countryCode: "+7"`, and `name`. Leave `pin` and `backupCode` unset so the
   demo-range values from `ACE_E2E_*` are used. An explicit phone takes no lock,
   which is correct here because the number is not in the pool yet.
   - This is the **fresh-signup** branch of `connect-register-from-otp.yaml`: the
     create-backup-code and confirm screens, then face capture. Its 7 camera ids
     are still uncalibrated (the `PER_RUN_TEST_USER_FLIP_PRECONDITION` gate). This
     one-time walk **doubles as their calibration**: take a
     `mobile_capture_ui_dump` at the photo-capture screen, compare the ids with the
     selector map, and fix any drift (§ Selector discovery loop in
     `playbook/integrations/mobile-integration.md`).
   - If the walk takes the **recovery** path instead (the number already has an
     account, so you see "enter your backup code" rather than "create"), stop.
     Someone else owns that number. Re-plan with `--avoid <that number>`.
   - Confirm the device reaches the Connect home with `mobile_capture_ui_dump`.
4. **Store it. Owner approval required.** Add the slot to the `pool-json` field of
   the 1Password item `connect-test-workers` in the ACE instance vault. The value is
   one JSON object for the whole pool:
   `{"worker-2": {"phone": "+7426…", "phoneLocal": "426…", "pin": "…", "backupCode": "…", "name": "ACE Test 2"}, …}`.
   - The **first time** (when the item does not exist yet), create it. Then, in the
     same PR as step 5, add this line to `.env.tpl` under the test-worker block
     and uncomment the `ace-e2e-workers` entry in `runtime.yaml`:
     `ACE_E2E_WORKERS=op://${AGENT_VAULT}/connect-test-workers/pool-json`.
     Neither is live before the item exists, because `op inject` is
     all-or-nothing: a reference to a missing item would break `/ace:setup` for
     everyone.
5. **Declare the slot.** If `scripts/test-worker-add.ts` said the slot is new, add it
   to `slots:` in `infra/capabilities/test-worker/capability.yaml`. Ship the PR with
   `skills/shipping`.
6. **Publish. Owner approval required.**
   `canopy-runtime publish-capabilities --spec runtime.yaml --agent ace`. The first
   publish also needs a workspace admin to grant `test-worker` to agent `ace` in
   ACE's canopy-web workspace.
7. **Load it.** Run `/ace:setup --force-env`, then **restart Claude Code**: MCP
   servers read `.env` only at start. Then `/ace:doctor` must show
   `PASS test_worker_pool`.
8. **Verify it.** Run `mobile_checkout_test_workers({count: <pool size>})`, then
   `mobile_register_test_user({slot: "<new slot>"})`. Confirm it reaches the
   Connect home, then `mobile_release_test_workers({all: true})`.

**Initial bootstrap.** The manifest ships with `worker-1` only, the one worker that has
credentials, so it can be published straight away: that alone makes worker-1 an
exclusive checkout and ends the two-sessions-one-worker lockout (ace#2934). Grow the
pool with "Add a worker", once per new slot. Never declare a slot before its
credentials exist: a checkout handed such a slot fails `TEST_WORKER_NO_CREDENTIALS`.

### Retire a worker

1. Make sure nobody holds it. `list_capability_leases` (capability `test-worker`,
   status `live`) shows who does.
2. **Owner approval required.** Remove its entry from `pool-json`, or for worker-1,
   replace the `connect-test-user` fields. Record the retired number in the item's
   notes so `--avoid` can skip it from then on.
3. Fill the slot again with "Add a worker" (step 1 picks the slot that now has no
   credentials). To shrink the pool instead, remove the slot from `capability.yaml`
   and republish (owner approval required).
4. `/ace:setup --force-env`, restart, `/ace:doctor`.

## MCP Tools Used

- `ace-mobile`: `mobile_ensure_avd_running`, `mobile_register_test_user` (`slot`, or
  an explicit `phone`), `mobile_checkout_test_workers`,
  `mobile_release_test_workers`, `mobile_capture_ui_dump`, `mobile_diagnose`
  (`test_workers`), `mobile_stop_avd`.
- `canopy-web`: `list_capability_leases` / `get_agent_capabilities` (read-only)
  show who holds what.

## Mode Behavior

- **Auto:** checking workers out and releasing them is routine and needs no
  approval. Adding or retiring a worker stops before steps 4 and 6 (the 1Password
  write and the publish). Those steps change shared credentials and shared
  infrastructure, so the exact command goes to the operator.
- **Review:** the same, and the plan from step 1 is shown before any device walk.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-15 | Initial version: named pool + exclusive checkout via canopy-web `test-worker`, add/retire procedure (ace#2955) | ACE team |
