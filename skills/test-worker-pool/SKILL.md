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
| Every slot's credentials | canopy-web, per-slot data on ACE's `test-worker` capability: public `phone`, `phoneLocal`, `countryCode`, `name`; secret `pin`, `backupCode` |
| Writing / listing / deleting slot data | `scripts/test-worker-set.ts` (as ACE, with ACE's own canopy-web PAT) |
| Validation + masking | `lib/test-worker-pool.ts`; slot list + classification `lib/test-worker-slots.ts` |
| Exclusive checkout (the lock) | canopy-web `test-worker` pool capability, via `lib/test-worker-lease.ts` |
| Doctor signal | `/ace:doctor` → `test_worker_pool`; `mobile_diagnose` → `test_worker_slots` |

**Every slot carries all six keys, its own PIN and backup code included**, even
where the values match another slot's (owner directive, 2026-10-15: "fully proper
security", "per login even if the same"). A ready lease hands its holder that
slot's data. A slot with no data, or missing any key, fails
`TEST_WORKER_NO_CREDENTIALS`. The error names the slot, the missing keys, and the
`test-worker-set.ts` command that stores them, and the lease is released. No pool
slot falls back to the shared `ACE_E2E_PIN` / `ACE_E2E_BACKUP_CODE`.

**Secrets never leave canopy-web unmasked except to the lease holder.** The slot
list (`--list`, `/ace:doctor`, `mobile_diagnose`) shows public values and secret
KEY names only. Never put a PIN or backup code on a command line, in a log, an
issue, a run artifact or a tool result. `test-worker-set.ts` refuses them on argv
and takes them only from environment variables it is told to read, or from stdin.

- `mobile_ensure_avd_running` checks out **one** worker before it registers, signs
  the device in as that worker, heartbeats the lease while the session lives, and
  reports the worker as `test_worker` in its result (phone and name, never a
  secret). `mobile_stop_avd` and process exit release it.
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
  **unlocked as the legacy `ACE_E2E_*` worker** (worker-1's identity), which is
  the behaviour before ace#2955. It prints a loud warning that names ace#2955 and
  the publish step. `mobile_diagnose` (`test_workers`) and `/ace:doctor`
  (`test_worker_pool` WARN) keep showing the fallback until it is fixed. A
  multi-worker checkout never falls back: it fails with
  `TEST_WORKER_POOL_UNAVAILABLE`.

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

- The pool as canopy-web holds it: `$TSX "$ACE_ROOT/scripts/test-worker-set.ts" --list`
  (masked: phones, names, which secret keys each slot has, who holds it).
- The manifest slots in `infra/capabilities/test-worker/capability.yaml`.
- A device (`mobile_ensure_avd_running`) for the one-time registration walk.

## Products

- A new worker, registered once on Connect, with all six keys stored as its slot's
  data on canopy-web.
- Its slot listed in the manifest and published to canopy-web.

## Process

Run the scripts from the installed plugin:

```bash
ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
TSX="node $ACE_ROOT/node_modules/tsx/dist/cli.mjs"
```

### Add a worker

1. **Plan it.** `$TSX "$ACE_ROOT/scripts/test-worker-add.ts" [--avoid +7426…,+7426…]`.
   It prints the next slot and the next unused `+7426` number, from canopy-web's
   masked slot list, the manifest, and this machine's legacy `ACE_E2E_PHONE`. The
   slot is the first manifest slot with no data behind it, or else one past the
   highest slot. The number is one past the highest pool number. Pass
   `--avoid <phone,…>` to skip numbers you know are taken, such as retired
   workers, whose Connect accounts still exist and must never be reissued. If
   canopy-web's slot list cannot be read it refuses, because the next number would
   be a guess; `--offline` plans without it. The script is read-only.
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
   `countryCode: "+7"`, and `name`. Leave `pin` and `backupCode` unset: the MCP
   uses this machine's legacy `ACE_E2E_*` values, so no secret enters the
   transcript, and step 4 stores those same values as this slot's own. An
   explicit phone takes no lock, which is correct here because the number is not
   in the pool yet.
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
4. **Store it on canopy-web.** No owner approval needed; nothing is written to
   1Password. As ACE:

   ```bash
   $TSX "$ACE_ROOT/scripts/test-worker-set.ts" --slot <slot> --phone <phone> \
     --phone-local <phoneLocal> --country-code +7 --name "<name>" --secrets-from-legacy-env
   ```

   `--secrets-from-legacy-env` reads the PIN and backup code from ACE's `.env`
   (the values step 3 registered with) and stores them as this slot's own. If the
   worker was registered with different secrets, pass them via environment
   variables instead: `PIN=… BACKUP_CODE=… $TSX … --pin-env PIN --backup-code-env
   BACKUP_CODE`, or as JSON on stdin with `--secrets-stdin`. Never on argv.
   `--dry-run` prints the masked request without sending it. The script prints
   canopy-web's masked answer.
5. **Declare the slot.** If the planner said the slot is new, add it to `slots:` in
   `infra/capabilities/test-worker/capability.yaml`, ship the PR with
   `skills/shipping`, then publish:
   `canopy-runtime publish-capabilities --spec runtime.yaml --agent ace` (ACE's own
   PAT can publish). The first publish also needs a workspace admin to grant
   `test-worker` to agent `ace` in ACE's canopy-web workspace.
6. **Verify it.** `$TSX "$ACE_ROOT/scripts/test-worker-set.ts" --list` shows the slot
   with no `!!` gaps, and `/ace:doctor` shows `PASS test_worker_pool`. Then run
   `mobile_checkout_test_workers({count: <pool size>})`, then
   `mobile_register_test_user({slot: "<new slot>"})`. Confirm it reaches the
   Connect home, then `mobile_release_test_workers({all: true})`. No restart is
   needed: the data arrives with each lease.

**Seeding worker-1..4.** The manifest declares `worker-1`..`worker-4`
(`+74260000101`..`104`, all signed up in PersonalID on 2026-10-15 with the legacy
PIN and backup code). worker-1 is the legacy worker itself:
`$TSX "$ACE_ROOT/scripts/test-worker-set.ts" --from-legacy-env`. worker-2..4: step 4
with `--secrets-from-legacy-env`. Until a slot has data, a checkout handed it fails
`TEST_WORKER_NO_CREDENTIALS`, so seed every declared slot before the capability is
granted.

### Retire a worker

1. Make sure nobody holds it. `list_capability_leases` (capability `test-worker`,
   status `live`) shows who does, and `--list` shows a `held` column.
2. To shrink the pool, remove the slot from `capability.yaml`, ship it, and
   republish. Then delete its data:
   `$TSX "$ACE_ROOT/scripts/test-worker-set.ts" --delete --slot <slot>`.
   Record the retired number in the PR so `--avoid` can skip it from then on.
3. To replace the worker instead, keep the slot and run "Add a worker" with
   `--avoid <retired number>`. Step 4 overwrites the slot's data with the new
   worker's.
4. `/ace:doctor` confirms.

## MCP Tools Used

- `ace-mobile`: `mobile_ensure_avd_running`, `mobile_register_test_user` (`slot`, or
  an explicit `phone`), `mobile_checkout_test_workers`,
  `mobile_release_test_workers`, `mobile_capture_ui_dump`, `mobile_diagnose`
  (`test_workers`, `test_worker_slots`), `mobile_stop_avd`.
- `canopy-web`: `list_capability_leases` / `get_agent_capabilities` (read-only)
  show who holds what.

## Mode Behavior

- **Auto:** checking workers out and releasing them is routine and needs no
  approval. Adding a worker, storing its slot data and publishing the manifest
  run without stopping (no 1Password write is involved). Retiring a worker that
  someone holds is never done: wait for the holder.
- **Review:** the same, and the plan from step 1 is shown before any device walk.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-15 | Initial version: named pool + exclusive checkout via canopy-web `test-worker`, add/retire procedure (ace#2955) | ACE team |
| 2026-10-15 | Credentials move to canopy-web per-slot data delivered with the lease; `test-worker-set.ts`; the env/1Password pool path is dropped; manifest declares worker-1..4 (ace#2955) | ACE team |
