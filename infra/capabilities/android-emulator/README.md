# `android-emulator`: ACE's leased Android emulator

One EC2 machine per lease, booted from ACE's image, driven through canopy-web,
terminated when the lease ends. Phase 6 device walks and `/ace:qa-deep` use it
from any runner, including the KVM-less cloud runner. It replaced ace-web's
`/api/mobile` (one shared, long-lived instance), retired 2026-10-14 together
with ACE's `cloud` mobile backend (`ACE_MOBILE_BACKEND=cloud` is now an alias
for `lease`).

The contract this directory implements is canopy-web's
`docs/superpowers/specs/2026-10-14-cloud-capabilities-design.md` (§1 declaring,
§2 the `ec2-ephemeral` kind). canopy-web owns leasing, grants, caps and the
sweep. Everything specific to the emulator is here. The lease client is
`mcp/mobile/backends/lease.ts` + `lease-contract.ts`.

| Path | What it is |
|---|---|
| `capability.yaml` | The manifest canopy-web brokers: limits, the `state` param, the exec allowlist (`ace-mobile`). |
| `stack.params.json` | Parameters for canopy's shared template, pinned to a `dimagi-canopy` release tag. |
| `deploy.sh` | Fetch the pinned template, check the AMI's states, `aws cloudformation deploy`, `canopy-runtime publish-capabilities`. |
| `bake.sh` | Packer build, check the AMI's states, write the AMI id to `/canopy/capabilities/ace/android-emulator/ami`, prune old images. |
| `teardown.sh` | Terminate machines, delete the stack and bucket, optionally the images. |
| `image/` | The Packer template and bake scripts, the pinned AWS CLI signing key (`keys/`), the boot hook, runner and idle-watchdog units, and the `ace-mobile` CLI. |
| `_common.sh` | Config and helpers the three scripts share (stack identity, state-tag check, image pruning). |

`test/infra/android-emulator-capability.test.ts` fails CI when the manifest, the
image, the stack params, `runtime.yaml`, the CLI's constants and the local
backend disagree. `test/infra/android-emulator-cli.test.ts` runs the CLI's
Python tests and shellchecks every script here.

---

## From an empty account to a live lease

Every step is a command below. Nothing is done by hand in the AWS console.
Run them from this directory.

### 0. Prerequisites

- **Tools:** `aws` (CLI v2), `jq`, `gh` (authenticated, with read access to
  `dimagi-internal/canopy-web`), `packer` >= 1.10, `git`, `python3`.
  `shellcheck` and bash >= 5 are only needed to run the tests.
- **AWS:** a profile with admin on the target account. Every script uses
  `AWS_PROFILE`, defaulting to `labs` (log in with `canopy aws login --profile
  labs --reason "…"`, or the AWS CLI's own SSO login).
- **A default VPC** in `us-east-1` with its default subnets. The bake host gets a
  public IP there and Packer reaches it over SSH, from your IP only. `deploy.sh`
  puts the lease machines in the first default subnet whose AZ offers
  `m8i.xlarge`, unless `VpcId`/`SubnetId` are set in `stack.params.json`. In an
  account without one: `aws ec2 create-default-vpc --region us-east-1`.
- **The broker role exists.** `BrokerRoleName` in `stack.params.json` is
  canopy-web's own ECS task role (`canopy-web-task-role` in the labs account, since 2026-10-15). The
  stack attaches its broker policy to that role and does not create it.
- **canopy's template is released at the pinned tag** (`stack.params.json`
  `template.ref`):

  ```bash
  gh release view dimagi-canopy-v0.9.0 -R dimagi-internal/canopy-web
  ```
- **Publishing:** `canopy-runtime` from the same tag:

  ```bash
  pip install "canopy-runtime @ git+https://github.com/dimagi-internal/canopy-web@dimagi-canopy-v0.9.0#subdirectory=packages/canopy_runtime"
  ```
- **ACE's canopy-web PAT** for the lease calls in step 4: `CANOPY_WEB_PAT` in
  ACE's `.env` (`~/.claude/plugins/data/ace-ace/.env`, written by `/ace:setup`
  from ACE's 1Password vault). `lib/ace-canopy-pat.ts` and `bin/ace-canopy-web`
  read it from there and nowhere else. Never lease with a human's personal
  canopy token: the lease would be theirs. Publishing (step 2) and the grant
  (step 3) are admin acts, done with the admin's own login.

  ```bash
  export CANOPY_WEB_PAT="$(sed -n 's/^CANOPY_WEB_PAT=//p' ~/.claude/plugins/data/ace-ace/.env)"
  ```

### 1. Bake the image

Confirm the pinned source AMI resolves (Canonical keeps old serials, but check):

```bash
aws ec2 describe-images --region us-east-1 --owners 099720109477 \
  --filters "Name=name,Values=$(sed -n 's/.*default *= *"\(ubuntu[^"]*\)".*/\1/p' image/variables.pkr.hcl)" \
  --query 'Images[].[ImageId,Name]' --output text
# 2026-10-14: ami-0fa5967347d08d2df  ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20261004
```

```bash
./bake.sh
```

Packer launches an `m8i.xlarge` bake host **with nested virtualization**
(`enable_nested_virtualization`; packer-plugin-amazon pinned to `= 1.8.3`, the
first release that has it, hashicorp/packer-plugin-amazon#679) from the pinned
Ubuntu 24.04 AMI (`variables.pkr.hcl` `source_ami_name`, an exact name, never a
wildcard). Everything it downloads is pinned and verified:

| What | Pin | Verified by |
|---|---|---|
| AWS CLI v2 | 2.37.11 | sha256 **and** the AWS CLI Team GPG signature, checked against the embedded `image/keys/aws-cli-team.asc` (fingerprint `FB5D B77F D5C1 18B8 0511 ADA8 A631 0ACC 4672 475C`, valid to 2027-07-01; the keyserver copy is expired) |
| Android cmdline-tools | 11076708 | sha256 |
| platform-tools, emulator, build-tools 34.0.0, API 34 `google_apis` x86_64 | sdkmanager's current revision | sdkmanager's own checksums; the installed revisions are recorded in `/opt/ace/MANIFEST.txt` |
| Maestro | 2.5.1 | sha256 (= Maestro's `checksums_sha256.txt`) |
| CommCare | 2.64.0 (default state), 2.62.0 | sha256 per version **and** `apksigner verify --print-certs` = Dimagi's certificate `8955dfd8…37b03` |

2.63.0 is not baked: it is the crash-loop build (ace#938). There is no `apt-get
upgrade`; security currency comes from bumping `source_ami_name`. apt-daily,
apt-daily-upgrade and unattended-upgrades are masked and snap refreshes are held
(snapd itself stays: the SSM agent is a snap). qemu-kvm and libvirt are not
installed (the emulator ships its own qemu). `/dev/kvm` at bake time is only
reported (`/var/log/kvm-ok.log`); the bake never boots the emulator.

The AMI is tagged `ace:states=cc-2.64.0,cc-2.62.0` (plus `source-ami`,
`source-ami-name`, `ace-sha`). `bake.sh` refuses to write the SSM parameter
unless that tag equals `capability.yaml`'s `params.state.enum`, then prunes old
images: it keeps the newest 3 (`--keep N`), the new one and the previous one
(the rollback target, which it prints). `--no-prune` keeps everything.

### 2. Deploy the stack and publish the capability

```bash
./deploy.sh
```

Before it writes anything, it checks:
1. the template exists at the pinned tag;
2. every key in `stack.params.json` is a parameter that template declares, and
   every parameter it requires is set;
3. the AMI parameter exists, and that AMI's `ace:states` tag equals the
   manifest's state enum.

Then it runs `aws cloudformation deploy` (stack `canopy-cap-ace-android-emulator`,
`CAPABILITY_NAMED_IAM`, a no-op when nothing changed), checks the stack exposes
`LaunchTemplateId`, `ArtifactsBucketName`, `InstanceRoleArn` and `Capability`,
and runs `canopy-runtime publish-capabilities --spec runtime.yaml --agent ace`.
Without `canopy-runtime` it exits 3 after the deploy and prints the install
command; re-run after installing it. `--skip-publish` deploys only;
`--template-file <path>` deploys a local template instead of the pinned one.

### 3. Grant the capability

Until a workspace admin grants it, an acquire returns 403. The grant is
`PUT /api/capabilities/grants` on canopy-web (MCP tool `set_capability_grant`),
made by an admin of ACE's workspace with their own login. It may lower
`max_concurrent` / `max_lease_s`, never raise them:

```bash
curl -fsS -X PUT -H "Authorization: Bearer $ADMIN_CANOPY_TOKEN" -H 'content-type: application/json' \
  -d '{"agent":"ace","capability":"android-emulator","workspace":"connect"}' \
  https://canopy.dimagi.com/api/capabilities/grants

# As ACE, check it took:
curl -fsS -H "Authorization: Bearer $CANOPY_WEB_PAT" \
  https://canopy.dimagi.com/api/agents/ace/capabilities | jq
```

`/ace:doctor`'s `capability_lease` probe reports the grant state too.

### 4. Acquire, diagnose, release

```bash
API=https://canopy.dimagi.com/api/capabilities/leases
AUTH="Authorization: Bearer $CANOPY_WEB_PAT"

LEASE=$(curl -fsS -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"agent":"ace","capability":"android-emulator","params":{"state":"cc-2.64.0"}}' \
  "$API" | jq -r .lease_id)

# wait_s long-polls (<= 20 s per call).
until curl -fsS -H "$AUTH" "$API/$LEASE?wait_s=20" | jq -e '.status == "ready" or .status == "failed"' >/dev/null; do :; done
curl -fsS -H "$AUTH" "$API/$LEASE" | jq '{status, reason, ready_info}'

EXEC=$(curl -fsS -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"argv":["ace-mobile","diagnose"],"timeout_s":60}' "$API/$LEASE/exec" | jq -r .exec_id)
curl -fsS -H "$AUTH" "$API/$LEASE/exec/$EXEC?wait_s=20" | jq '{status, exit_code, stdout_tail}'

curl -fsS -X DELETE -H "$AUTH" "$API/$LEASE"
aws ec2 describe-instances --region us-east-1 --profile labs \
  --filters Name=tag:canopy:capability,Values=android-emulator Name=tag:canopy:owner,Values=ace \
  --query 'Reservations[].Instances[].[InstanceId,State.Name]' --output text
```

Healthy: `ready_info.ok` true with the requested `state`, `accel: "kvm"` and a
`baseline_fingerprint` equal to the local backend's; `diagnose` has
`"healthy": true` and `"adb_visible_count": 1`.

**Measured** 2026-10-14 on the image *before* this audit (5 leases, m8i.xlarge;
cold boot, 1 grant, fixed sleeps, apt-daily running): ready 213-224 s from
acquire; `boot_completed` ~150 s and CommCare installed ~170 s after the runner
started. Not re-measured since (4 emulator cores, 1 s polling, no fixed sleeps,
updaters off, plus the 9 grants and the baseline). Every lease now reports its
own breakdown in `ready_info.timings` (below).

### 5. A Phase 6 smoke on the lease backend

In a fresh Claude Code session with `ACE_MOBILE_BACKEND=lease` (or
`/ace:mobile-backend lease`), `mobile_ensure_avd_running` acquires a lease and
waits for `ready`; run one smoke recipe through `mobile_run_recipe` and check its
screenshots come back. Then run two sessions at once and confirm they get
separate machines (`mobile_diagnose` shows each lease's instance).

---

## Rebake, roll back, tear down

- **Rebake** (new CommCare version, Maestro bump, any change under `image/`):
  `./bake.sh`. A new CommCare version needs its URL + sha256 in
  `image/scripts/40-commcare-apk.sh`, the version in `commcare_versions`, and
  `capability.yaml`'s `enum` updated (CI enforces all three), then `./deploy.sh`
  to republish.
- **Roll back:** `./bake.sh --skip-build <previous-ami-id>` (refused if that
  AMI's `ace:states` no longer matches the manifest).
- **Prune old images:** `./teardown.sh --yes --images-only [--keep N]`. Keeps the
  newest N (default 3) and the AMI the parameter points at; refuses to run when
  the parameter cannot be read, and only ever deletes `ami-`/`snap-` shaped ids.
- **Tear down:** retire the capability on canopy-web first (remove it from
  `runtime.yaml` `capabilities:`, then
  `canopy-runtime publish-capabilities --spec runtime.yaml --agent ace`), then
  `./teardown.sh --yes` (`--images` also deletes every baked AMI, its snapshots
  and the SSM parameter). Re-runnable after a partial failure.

---

## What happens on the machine

`ace-capability-boot.service` (oneshot, enabled) runs once per boot:

1. **It arms a halt before anything that can fail or wait** (IMDS included):
   `systemd-run --on-active=<14400 - uptime>s systemctl poweroff`. If that
   fails it publishes `halt-not-armed` and powers off.
2. It reads instance id, region and user-data through IMDSv2. canopy-web
   launches with user-data `{"lease_id", "params", "max_lifetime_s", "bucket"}`.
   It re-arms the halt with the lease's own lifetime and drops the default.
3. It writes `/run/ace-mobile/{lease.json,idle.json}` and checks `params.state`
   against `/opt/ace/states.yaml` (the default if omitted) and that `/dev/kvm`
   exists.
4. It writes the state to `/run/ace-mobile/requested-state` and starts
   `ace-mobile-runner.service` (`Restart=no`) → `ace-emulator-launch`:
   `ace-launch-plan` picks the boot path (cold today: no snapshot is baked; a
   baked snapshot that fails to boot falls back to cold), the emulator
   cold-boots with `-wipe-data`, CommCare is installed, the local backend's 9
   runtime permissions are granted, `pm` must answer twice in a row, and
   `ace-mobile apply-baseline` applies the local backend's environment baseline
   and syncs the device clock. Then `/run/ace-mobile/ready`. Every wait polls at
   1 s; there are no fixed sleeps.
5. It writes `s3://<bucket>/vm/<aws:userid>/ready.json` (`aws:userid` =
   `<instance-role-id>:<instance-id>`, the only `vm/` prefix the instance role
   may write; canopy-web finds it through the stack's `InstanceRoleId` output).
   An exception anywhere becomes `{ok:false, reason:"hook-crashed"}`.

If the emulator dies **after** ready, the launcher writes
`/run/ace-mobile/crashed` and exits 0. Nothing reboots it: every subcommand but
`diagnose` then refuses with `emulator-crashed`, and the lease is released.

Cost guards on the machine: the max-lifetime halt, terminate-on-shutdown, and
`ace-idle-watchdog.timer` (every minute), which powers off after
`idle_release_s + 600 s` (1800 s when user-data carries none) without an
`ace-mobile` exec — never before ready.json is published, never while an exec
runs. canopy-web adds release, turn binding, heartbeat expiry and the sweep.

Logs: `/var/log/ace-mobile/{boot,runner,emulator,idle}.log`; `diagnose` returns
the runner and emulator tails.

### ready.json

```json
{"ok": true, "state": "cc-2.64.0", "instance_id": "i-…", "cli_version": "1.1.0", "accel": "kvm",
 "baseline_fingerprint": "…",
 "baseline": {"fingerprint": "…", "keys": ["…"], "complete": true, "failed": [], "clock_synced": true, "applied_at": "…"},
 "boot_path": {"path": "cold", "detail": "image boot mode is 'cold'", "state": "cc-2.64.0"},
 "timings": {"uptime_at_hook_s": 38.1, "imds_s": 0.4, "runner_to_ready_s": 96.0, "hook_s": 97.2,
   "boot_to_ready_s": 135.3, "launch_emulator_started_s": 0.3, "launch_adb_visible_s": 20.1,
   "launch_boot_completed_s": 71.0, "launch_commcare_installed_s": 85.2, "launch_baseline_s": 90.4,
   "launch_ready_s": 90.5}}
```

(Numbers illustrative.) `boot_path.path` is `snapshot`, `cold` or
`cold-fallback`. On failure `ok` is false and `reason` is one of:

| `reason` | Cause |
|---|---|
| `bad-user-data` | No or non-JSON user-data, or no `bucket` (without a bucket nothing can be published; the machine powers off). |
| `unknown-state` | `params.state` is not baked into this image. |
| `no-states` | `states.yaml` is empty (a broken bake). |
| `no-kvm` | `/dev/kvm` is absent: nested virtualization is off. |
| `halt-not-armed` | `systemd-run` failed; the machine also powers off. |
| `runner-start-failed` | `systemctl start` failed. |
| `emulator-boot-failed` | The launcher failed before ready (the runner unit `failed` or exited); `detail` has the runner log tail. |
| `emulator-ready-timeout` | No ready marker within `ready_timeout_s` of boot. |
| `hook-crashed` | The boot hook raised; `detail` has the traceback. |

A failed lease is released, not repaired.

---

## CLI contract

`/usr/local/bin/ace-mobile` (source `image/cli/ace_mobile.py`, Python 3 stdlib +
`aws` for S3; `cli_version` **1.1.0**) is the only name on the exec allowlist.
It runs as root under SSM; adb, Maestro and the emulator console run as
`ubuntu`, which owns the emulator, its adb server and `~/.maestro`.

**Every subcommand prints exactly one JSON object, on one line, on stdout**, and
exits 0 when `ok` is true, 1 when the operation failed, 2 on a usage error
(`error: "usage"`, also for an unknown subcommand). A failure carries `error`
(stable kebab-case) and `message`. Inputs are `s3://` URIs (canopy-web
`/uploads`); `--out` is an `s3://` prefix (read back via `/artifacts?prefix=`).

**Inline size.** The broker keeps a tail of stdout inline and the full stream at
`stdout_url`. A result is shrunk to 20,000 characters before printing:
`artifacts` capped at 25 (`artifacts_total` always has the real count), then
`stdout`/`stderr` cut to 2,000, then `steps` cut to the failing ones + the last
20 (`steps_total`), then `artifacts`/`steps` emptied. Every shortened field is
named in `inline_truncated`. `run-recipe` always writes the full result to
`<out>/result.json`.

**Secrets.** Every `--env` value whose key matches
`PIN|CODE|PASS|SECRET|TOKEN|OTP|PHONE|KEY|CRED`, and every register credential
but `name`, is replaced with `<redacted>` in printed output and in every
uploaded text file; every `defineVariablesCommand.env` value in Maestro's
reports is redacted whatever its key. `register-test-user` reports
`backup_code_set`, never the code.

**Uploads.** Under `--out`: screenshots, videos and UI dumps (`.png .jpg .jpeg
.mp4 .xml`) at the path the recipe wrote them, `maestro-stdout.log`,
`maestro-stderr.log`, `result.json`, `register-parts.json`, and `debug/`:
Maestro's debug output **flattened** (`commands-*.json`, `maestro.log`, its own
`screenshot-❌-…` shots; a name two debug dirs share gets a `<ts>-` prefix).
Recipes and the palette are never uploaded. A failed upload never discards the
run: the payload keeps `exit_code` and `steps`, adds `upload_error`, and sets
`ok:false` (`error: "s3-upload-failed"` unless the recipe also failed).

**Common errors:** `usage`, `internal` (a bug; the JSON contract still holds),
`no-device` (+`adb_devices`), `emulator-crashed` (+`crash{emulator_exit, at,
state, boot_path}`), `s3-download-failed`, `s3-upload-failed`.

| Subcommand | Flags | Success JSON (beyond `"ok": true`) · errors |
|---|---|---|
| `ace-mobile diagnose` | — | `healthy` (adb device + ready marker + no crash), `adb_devices[{serial,state}]`, `adb_visible_count`, `emulator_pid`, `emulator_cmdline`, `runner_service_state`, `marker_present`, `marker_age_seconds`, `runner_log_tail`, `emulator_log_tail`, `kvm_dev_present`, `kvm_nested`, `accel`, `active_state`, `states{default,states[…]}`, `lease{lease_id,state}`, `crashed`, `crash`, `baseline`, `boot_path`, `recording`, `cli_version`, `ssm_ok`/`ssm_error` (retired ace-web shape). Always exit 0, even after a crash (`crashed: true, error: "emulator-crashed"`). |
| `ace-mobile run-recipe` | `--recipe s3://…` · `--palette s3://….tar.gz` · `--env K=V`… · `--out s3://…` · `--timeout-s N` (1800) | `exit_code`, `stdout`, `stderr` (redacted tails), `steps[{index,name,status,screenshot,error,duration_ms}]`, `artifacts[{name,key,uri,content_type,bytes}]`, `artifacts_total`, `out`, `result_uri`, `duration_s`, `upload_error?`, `inline_truncated?`. Errors (with the full payload): `recipe-failed`, `recipe-timeout`, `bad-palette`. |
| `ace-mobile register-test-user` | `--palette s3://….tar.gz` · `--to-otp-recipe` · `--from-otp-recipe` · `--creds s3://….json` (or `--phone --phone-local --country-code --pin --backup-code --name`) · `--out` · `--timeout-s` | `already_registered`, `phone`, `backup_code_set`, `parts[{part,recipe,exit_code,stdout,stderr}]`, `out?`, `upload_error?`. Errors `register-part-a-failed`, `register-part-b-failed`, `recipe-missing`, `bad-palette`. |
| `ace-mobile ui-dump` | `--out` · `--name` (ui-dump.xml) | `xml`, `elements[{id?,text?,class?,bounds?}]`, `failed: false`, `uri?`. Error `ui-dump-failed` (`failed: true`, `xml: ""`). |
| `ace-mobile screenshot` | `--out` (required) · `--name FILE.png` | `name`, `uri`, `content_type`, `bytes`. Error `screenshot-failed`. |
| `ace-mobile install-apk` | `--apk s3://…` or `https://…` | `package_name`, `version`, `version_code`. Errors `install-failed`, `download-failed`. |
| `ace-mobile clear-app-data` | `--package` (org.commcare.dalvik) | `package`, `cleared`. |
| `ace-mobile repair-driver` | — | `uninstalled_packages`. |
| `ace-mobile install-driver` | — | `actions` (`already-installed`, or `pm-ready, extracted, installed:app, installed:test, verified`). Errors `maestro-jar-missing`, `maestro-driver-extract-failed`, `maestro-driver-install-failed`, `maestro-driver-verify-failed`. |
| `ace-mobile snapshot` | `save` or `load` · `--name` | `name`, `action`, `output`, `saved_at`/`loaded_at`. Errors `snapshot-save-failed`, `snapshot-load-failed` (a console `KO:`). |
| `ace-mobile set-location` | `--lon` · `--lat` · `--alt` (480) · `--sats` (12) | `longitude`, `latitude`, `altitude`, `satellites`, `applied`, `output`. Longitude first. Error `geo-fix-failed`. |
| `ace-mobile apply-baseline` | — | `fingerprint` (sha1-12 of the sorted keys, = the local backend's), `keys`, `complete`, `failed[]`, `clock_synced`, `applied_at`, `steps[{key,ok,output?}]`. Every step runs even when one fails; error `baseline-failed`. Writes `/run/ace-mobile/baseline.json`. The image runs it before ready; idempotent. |
| `ace-mobile record start` | `--name N` (default `rec-<utc>.mp4`) · `--bit-rate` (1M) · `--size` (540x1140) | `name`, `device_path`, `started_at`, `bit_rate`, `size`. On-device `screenrecord --time-limit 0`, held by the transient unit `ace-record` so it outlives the exec; reported only once the device process is seen. One recording at a time. Errors `record-busy` (+`recording`), `record-start-failed`. |
| `ace-mobile record stop` | `--out s3://…` (required) · `--name N` (optional check) | `name`, `key` (`N.mp4`; `.mp4` is never doubled), `uri`, `content_type: "video/mp4"`, `bytes`, `duration_s`, `upload_error?`. SIGINT (never SIGKILL), waits for a stable size, `adb pull`, uploads to `<out>/N.mp4`, removes the device file on every path. Errors `no-recording`, `record-pull-failed`, `s3-upload-failed`. The image has no ffmpeg: the client remuxes (`-c copy +faststart`) as the local backend does. |
| `ace-mobile --version` | — | `cli_version`. |

### Tests

`test/infra/android-emulator-cli.test.ts` runs the Python suite
(`python3 -m unittest discover -s image/cli/tests -t image/cli/tests`) and
shellchecks every script; `test/infra/android-emulator-capability.test.ts` holds
the manifest, image, stack, CLI constants (limits, mock location) and the local
backend (the `avd.ts` baseline adb calls and permission list) equal, and checks
the supply-chain pins. The Python suite runs `ace-emulator-launch`,
`40-commcare-apk.sh` and `_common.sh`'s pruning against fakes (bash >= 5, jq).

---

## What moved from ace-web, and what did not

Moved from `ace-web/infra/mobile-ami/`:
- `ace-mobile.pkr.hcl`, `variables.pkr.hcl`;
- `scripts/00`–`40`;
- `scripts/50-bake-snapshot.sh`, renamed `50-states.sh` (it stopped baking a
  snapshot in May 2026);
- `files/ace-emulator-launch` and `files/ace-mobile-runner.service`.

Every SSM shell builder in ace-web's `apps/mobile/controller.py` became a CLI
subcommand.

Changes on the way:
- **New:** the boot hook, the CLI, `set-location`, `apply-baseline`, `record`,
  the Python idle watchdog, and `build-tools` for `aapt`/`apksigner`.
- **Dropped:**
  - ace-web's idle-shutdown shell script and sudoers entry (replaced by the
    watchdog above);
  - qemu-kvm, libvirt, bridge-utils, `apt-get upgrade`, CommCare 2.63.0;
  - `rebake.sh`'s instance roll and task-definition PR;
  - the Secrets Manager read;
  - `select-state` / `restart-runner` / `patch-launch-script` (a lease boots one
    state and is released when sick).
- **Changed:**
  - the runner unit is no longer enabled at boot, and never restarts;
  - the bake host is an m8i.xlarge with nested virtualization, not c5n.metal;
  - the bake host's SSH security group is scoped to the baker's IP;
  - bake resources carry `agent`/`capability` tags, never `canopy:*`. canopy's
    sweep terminates untracked `canopy:capability` instances, and that must not
    include a bake host.
