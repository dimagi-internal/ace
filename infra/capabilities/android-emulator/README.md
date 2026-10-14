# `android-emulator`: ACE's leased Android emulator

One EC2 machine per lease, booted from ACE's image, driven through canopy-web,
terminated when the lease ends. Phase 6 device walks and `/ace:qa-deep` use it
from any runner, including the KVM-less cloud runner. It replaces ace-web's
`/api/mobile` (one shared, long-lived instance).

The contract this directory implements is canopy-web's
`docs/superpowers/specs/2026-10-14-cloud-capabilities-design.md` (§1 declaring,
§2 the `ec2-ephemeral` kind). canopy-web owns leasing, grants, caps and the
sweep. Everything specific to the emulator is here.

| Path | What it is |
|---|---|
| `capability.yaml` | The manifest canopy-web brokers: limits, the `state` param, the exec allowlist (`ace-mobile`). |
| `stack.params.json` | Parameters for canopy's shared template, pinned to a `dimagi-canopy` release tag. |
| `deploy.sh` | Fetch the pinned template, `aws cloudformation deploy`, `canopy-runtime publish-capabilities`. |
| `bake.sh` | Packer build, then write the AMI id to `/canopy/capabilities/ace/android-emulator/ami`. |
| `teardown.sh` | Terminate machines, delete the stack and bucket, optionally the images. |
| `image/` | The Packer template and bake scripts (moved from ace-web `infra/mobile-ami/`), the boot hook and runner units, and the `ace-mobile` CLI. |
| `_common.sh` | Config the three scripts share, read from `stack.params.json` and checked against `capability.yaml`. |

`test/infra/android-emulator-capability.test.ts` fails CI when the manifest, the
image, the stack params and `runtime.yaml` disagree. `test/infra/android-emulator-cli.test.ts`
runs the CLI's Python tests and shellchecks every script here.

---

## From an empty account to a live lease

Every step is a command in this list. Nothing is done by hand in the AWS console.
Run them from this directory.

### 0. Prerequisites

- **Tools:** `aws` (CLI v2), `jq`, `gh` (authenticated, with read access to
  `dimagi-internal/canopy-web`), `packer` >= 1.10, `git`, `python3`.
  `shellcheck` is only needed to run the tests.
- **AWS:** a profile with admin on the target account. Every script uses
  `AWS_PROFILE`, defaulting to `labs`.

  ```bash
  aws sso login --profile labs
  ```
- **A default VPC** in `us-east-1` with its default subnets. The bake host gets a
  public IP there and Packer reaches it over SSH, from your IP only. `deploy.sh`
  puts the lease machines in the first default subnet whose AZ offers
  `m8i.xlarge`, unless `VpcId`/`SubnetId` are set in `stack.params.json`. In an
  account without one: `aws ec2 create-default-vpc --region us-east-1`.
- **The broker role exists.** `BrokerRoleName` in `stack.params.json` is
  canopy-web's ECS task role (`labs-jj-ecs-task-role` in the labs account). The
  stack attaches its broker policy to that role and does not create it. In an
  account where canopy-web runs under another role, change the value.
- **canopy's template is released at the pinned tag.** `stack.params.json`
  `template.ref` (`dimagi-canopy-v0.8.0`) must be a published release of
  canopy-web that ships `Mode: ephemeral`:

  ```bash
  gh release view dimagi-canopy-v0.8.0 -R dimagi-internal/canopy-web
  ```
- **Publishing:** `canopy-runtime` from the same tag, and a canopy-web PAT of an
  admin of agent `ace` in `CANOPY_WEB_PAT` (or `CANOPY_TOKEN`):

  ```bash
  pip install "canopy-runtime @ git+https://github.com/dimagi-internal/canopy-web@dimagi-canopy-v0.8.0#subdirectory=packages/canopy_runtime"
  ```

### 1. Bake the image (~25-40 min)

```bash
./bake.sh
```

Packer launches a `c5n.metal` bake host in the default VPC, installs KVM, the
Android SDK (API 34 `google_apis` x86_64), the `ACE_Pixel_API_34` AVD, Maestro
2.5.1, one CommCare APK per state (2.63.0, 2.62.0), the boot hook, the runner
unit and the `ace-mobile` CLI, then snapshots the AMI. `bake.sh` then writes
the AMI id to the SSM parameter `/canopy/capabilities/ace/android-emulator/ami`
(`--data-type aws:ec2:image`). It prints the previous value for rollback.

The image comes first because the stack's launch template resolves that
parameter, and `deploy.sh` refuses to deploy a stack that points at a missing
parameter.

Why a bare-metal bake host when the runtime is `m8i.xlarge`: Packer's
`amazon-ebs` builder (plugin v1.8.0, checked 2026-10-14) cannot request nested
virtualization. It has no `cpu_options` setting and cannot launch from a launch
template. Bare metal always exposes KVM, which `00-base.sh` checks with
`kvm-ok`. The bake never boots the emulator, so this is a package check. Runtime
KVM comes from the launch template (`NestedVirtualization=true`), and the boot
hook refuses to report ready without `/dev/kvm`.

### 2. Deploy the stack and publish the capability

```bash
./deploy.sh
```

Before it writes anything, it checks three things:
1. the template exists at the pinned tag;
2. every key in `stack.params.json` is a parameter that template declares, and
   every parameter it requires is set;
3. the AMI parameter exists.

Then it runs `aws cloudformation deploy` (stack `canopy-cap-ace-android-emulator`,
`CAPABILITY_NAMED_IAM`, a no-op when nothing changed) and checks the stack
exposes the contract's outputs: `LaunchTemplateId`, `ArtifactsBucketName`,
`InstanceRoleArn` and `Capability`. Last, it runs
`canopy-runtime publish-capabilities --spec runtime.yaml --agent ace`. If
`canopy-runtime` is missing, it exits 3 after the deploy and prints the install
command. Install it and re-run `./deploy.sh`; the deploy step is a no-op the
second time.

`./deploy.sh --skip-publish` deploys only. `./deploy.sh --template-file <path>`
deploys a local template instead of the pinned one, for testing an unreleased
canopy change.

### 3. Grant the capability

Until a workspace admin grants it, an acquire returns 403 and names the grant to
ask for. On canopy-web, in the workspace ACE runs in, a workspace admin grants
agent `ace` the capability `android-emulator`. They may lower
`max_concurrent` / `max_lease_s` below the manifest's ceilings, but cannot raise
them. Check the result:

```bash
curl -fsS -H "Authorization: Bearer $CANOPY_WEB_PAT" \
  https://canopy.dimagi.com/api/agents/ace/capabilities | jq
```

### 4. Acquire, diagnose, release

```bash
API=https://canopy.dimagi.com/api/capabilities/leases
AUTH="Authorization: Bearer $CANOPY_WEB_PAT"

LEASE=$(curl -fsS -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"agent":"ace","capability":"android-emulator","params":{"state":"cc-2.63.0"}}' \
  "$API" | jq -r .lease_id)

# Heartbeat until ready: ~4 min to EC2 status ok, plus ~2 min of emulator cold boot.
until curl -fsS -H "$AUTH" "$API/$LEASE" | jq -e '.ready == true' >/dev/null; do
  curl -fsS -H "$AUTH" "$API/$LEASE" | jq -c '{status, ready}'
  sleep 15
done

EXEC=$(curl -fsS -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"argv":["ace-mobile","diagnose"],"timeout_s":60}' "$API/$LEASE/exec" | jq -r .exec_id)
curl -fsS -H "$AUTH" "$API/$LEASE/exec/$EXEC" | jq '{status, exit_code, stdout_tail}'

curl -fsS -X DELETE -H "$AUTH" "$API/$LEASE"

# The machine is gone (or shutting down):
aws ec2 describe-instances --region us-east-1 --profile labs \
  --filters Name=tag:canopy:capability,Values=android-emulator Name=tag:canopy:owner,Values=ace \
  --query 'Reservations[].Instances[].[InstanceId,State.Name]' --output text
```

A healthy `diagnose` has `"healthy": true`, `"adb_visible_count": 1` and
`"accel": "kvm"`.

### 5. A Phase 6 smoke on the lease backend

Once `mcp/mobile/backends/lease.ts` has shipped, set `ACE_MOBILE_BACKEND=lease`
and run one smoke recipe through `mobile_run_recipe`. Then run two leases at once
to confirm they get separate machines.

---

## Rebake, roll back, tear down

- **Rebake** (new CommCare version, Maestro bump, any change under `image/`):
  `./bake.sh`. New leases boot the new image, running leases keep theirs, and
  nothing is re-pinned. A new state also needs `capability.yaml`'s `enum` updated
  (CI enforces it) and `./deploy.sh` to republish.
- **Roll back:** `./bake.sh --skip-build <previous-ami-id>`. `bake.sh` prints
  that id on every run.
- **Prune old images:** `./teardown.sh --yes --images-only`. This keeps the AMI
  the parameter points at.
- **Tear down:** retire the capability on canopy-web first (remove it from
  `runtime.yaml` `capabilities:`, then run
  `canopy-runtime publish-capabilities --spec runtime.yaml --agent ace`), then
  `./teardown.sh --yes`. Add `--images` to also delete every baked AMI, its
  snapshots and the SSM parameter. Every step skips what is already gone, so the
  script can be re-run after a partial failure.

---

## What happens on the machine

`ace-capability-boot.service` (oneshot, enabled) runs once per boot:

1. It reads the instance id, region and user-data through IMDSv2. canopy-web
   launches with user-data `{"lease_id", "params", "max_lifetime_s", "bucket"}`.
2. **It arms the halt before anything that can fail:**
   `systemd-run --on-active=<max_lifetime_s - uptime>s systemctl poweroff`.
   Shutdown behaviour is terminate, so the machine ends on its own even when
   canopy-web is down.
3. It writes `/run/ace-mobile/lease.json`. It checks `params.state` against
   `/opt/ace/states.yaml` (the default state if omitted) and checks that
   `/dev/kvm` exists.
4. It writes the state to `/run/ace-mobile/requested-state` and starts
   `ace-mobile-runner.service`. That runs `ace-emulator-launch`: a cold boot with
   `-wipe-data`, install of the state's CommCare APK, a CAMERA grant, a wait for
   `pm`, then `/run/ace-mobile/ready`.
5. It writes `s3://<bucket>/vm/<aws:userid>/ready.json`. `aws:userid` is
   `<instance-role-id>:<instance-id>`, the only `vm/` prefix the stack's
   instance role may write. canopy-web finds the file through the stack's
   `InstanceRoleId` output.

   ```json
   {"ok": true, "timings": {"uptime_at_hook_s": 38.1, "runner_to_ready_s": 96.0, "hook_s": 97.2,
     "boot_to_ready_s": 135.3, "launch_boot_completed_s": 71, "launch_commcare_installed_s": 92,
     "launch_ready_s": 92}, "cli_version": "1.0.0", "instance_id": "i-…", "state": "cc-2.63.0"}
   ```

   On failure, `ok` is false and `reason` is one of:

   | `reason` | Cause |
   |---|---|
   | `bad-user-data` | No or non-JSON user-data, or no `bucket`. |
   | `unknown-state` | `params.state` is not baked into this image. |
   | `no-states` | `states.yaml` is empty (a broken bake). |
   | `no-kvm` | `/dev/kvm` is absent: nested virtualization is off. |
   | `halt-not-armed` | `systemd-run` failed. |
   | `runner-start-failed` | `systemctl start` failed. |
   | `emulator-boot-failed` | The runner unit hit its restart limit. |
   | `emulator-ready-timeout` | No ready marker within `ready_timeout_s` of boot. |

   A failed lease is released, not repaired.

Logs: `/var/log/ace-mobile/{boot,runner,emulator}.log`. `ace-mobile diagnose`
returns their tails.

Machine-side cost guards: the max-lifetime halt, terminate-on-shutdown, and the
stack's idle alarm. canopy-web adds release, turn binding, heartbeat expiry and
the sweep.

---

## The `ace-mobile` CLI

The CLI is at `/usr/local/bin/ace-mobile`, the only name on the exec allowlist.
The source is `image/cli/ace_mobile.py` (Python 3 stdlib, plus `aws` for S3),
ported from ace-web `apps/mobile/controller.py`. It runs as root under SSM.
adb, Maestro and the emulator console run as `ubuntu`, which owns the emulator,
its adb server and `~/.maestro`.

**Every subcommand prints exactly one JSON object, on one line, on stdout.** It
exits 0 when `ok` is true, 1 when the operation failed and 2 on a usage error.
A failure carries `error` (a stable kebab-case code) and `message`. Inputs are
`s3://` URIs under the lease's `leases/<id>/in/`, from canopy-web's `/uploads`.
`--out` is an `s3://` prefix under `leases/<id>/out/`, read back through
`/artifacts?prefix=`. SSM shows only the first 24,000 characters of stdout
inline, so a long result (run-recipe steps, a big UI dump) may be cut in
`stdout_tail`. Read the full stdout from the exec's `stdout_url`. run-recipe
also writes its result to `<out>/result.json`.

Common failure codes: `no-device` (no adb device in `device` state; the payload
includes `adb_devices`), `s3-download-failed`, `s3-upload-failed`, `usage`, and
`internal` (a bug; the JSON contract still holds).

| Subcommand | Flags | Success JSON (beyond `"ok": true`) |
|---|---|---|
| `ace-mobile diagnose` | — | The ace-web `Diagnostics` fields: `ssm_ok` (always true), `ssm_error` (null), `adb_devices[{serial,state}]`, `adb_visible_count`, `emulator_pid`, `emulator_cmdline`, `runner_service_state`, `marker_present`, `marker_age_seconds`, `runner_log_tail`, `emulator_log_tail`, `kvm_dev_present`, `kvm_nested`, `accel` (`kvm`/`tcg`). New: `healthy` (adb device present and ready marker set), `active_state`, `states{default, states[{name,snapshot,commcare_version,apk_path,description}]}`, `lease{lease_id,state}`, `cli_version`. Always exits 0: an unhealthy machine is reported, not failed. |
| `ace-mobile run-recipe` | `--recipe s3://…` (required) · `--palette s3://….tar.gz` · `--env K=V` (repeatable) · `--out s3://…` (required) · `--timeout-s N` (default 1800) | `exit_code`, `stdout` and `stderr` (Maestro's, last 8000 chars each; full logs are artifacts), `steps[{index,name,status,screenshot,error,duration_ms}]` (`status` ∈ pass/fail/skipped/unknown), `artifacts[{name,key,uri,content_type,bytes}]` (every file under the run dir: screenshots, `commands-*.json`, `maestro.log`, `maestro-stdout.log`, `maestro-stderr.log`, the recipe and palette; `name` is the basename, `key` the path under `--out`), `out`, `result_uri`, `duration_s`. A non-zero Maestro exit gives `ok:false`, `error:"recipe-failed"` (or `"recipe-timeout"`), exit 1, and the same full payload, with artifacts uploaded. |
| `ace-mobile register-test-user` | `--palette s3://….tar.gz` (required) · `--to-otp-recipe NAME.yaml` · `--from-otp-recipe NAME.yaml` (required basenames inside the palette) · `--phone +…` · `--phone-local DIGITS` · `--country-code +N` · `--pin DIGITS` · `--backup-code DIGITS` · `--name TEXT` · `--creds s3://….json` (any of those six as JSON keys `phone, phone_local, country_code, pin, backup_code, name`; flags win) · `--out s3://…` (optional debug output) · `--timeout-s N` | `already_registered`, `phone`, `backup_code` (null when already registered), `parts[{part,recipe,exit_code,stdout,stderr}]`, `out` (with `--out`). GMS is enabled for part A and disabled for part B. `PHONE_ALREADY_REGISTERED` in either part short-circuits. Failure codes: `register-part-a-failed`, `register-part-b-failed`, `recipe-missing`, `bad-palette`. |
| `ace-mobile ui-dump` | `--out s3://…` (optional) · `--name FILE` (default `ui-dump.xml`) | `xml`, `elements[{id?,text?,class?,bounds?}]`, `failed` (false), `uri` (with `--out`). On failure: `ok:false`, `failed:true`, `xml:""`, `error:"ui-dump-failed"`, exit 1. The dump path is `/data/local/tmp/window_dump.xml`, as on the local backend. |
| `ace-mobile screenshot` | `--out s3://…` (required) · `--name FILE.png` (default `<UTC ts>-<id>.png`) | `name`, `uri`, `content_type` (`image/png`), `bytes`. Failure: `screenshot-failed`. |
| `ace-mobile install-apk` | `--apk s3://…` or `https://…` (required) | `package_name`, `version` (versionName), `version_code`. Failure: `install-failed`, `download-failed`. |
| `ace-mobile clear-app-data` | `--package PKG` (default `org.commcare.dalvik`) | `package`, `cleared` (true iff `pm clear` said Success; a missing package is `cleared:false`, still `ok:true`). |
| `ace-mobile repair-driver` | — | `uninstalled_packages` (the subset of `dev.mobile.maestro`, `dev.mobile.maestro.test` actually removed). |
| `ace-mobile install-driver` | — | `actions`: `["already-installed"]` on the warm path, else `pm-ready, extracted, installed:app, installed:test, verified`. Failure codes: `maestro-jar-missing`, `maestro-driver-extract-failed`, `maestro-driver-install-failed`, `maestro-driver-verify-failed` (`actions` so far included). |
| `ace-mobile snapshot` | `save` or `load` (positional) · `--name NAME` (required, `[A-Za-z0-9._-]`) | `name`, `action`, `output`, `saved_at` or `loaded_at` (ISO-8601). A console `KO:` reply is a failure: `snapshot-save-failed` / `snapshot-load-failed`. |
| `ace-mobile set-location` | `--lon DEG` · `--lat DEG` (required) · `--alt M` (default 480) · `--sats N` (default 12) | `longitude`, `latitude`, `altitude`, `satellites`, `applied`, `output`. Sends `adb emu geo fix <lon> <lat> <alt> <sats>`, longitude first. Failure: `geo-fix-failed`. |
| `ace-mobile --version` | — | `cli_version`. |

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
- **New:** the boot hook, the CLI, `set-location`, and `build-tools` for the
  `aapt` that `install-apk` needs (ace-web's image never installed it).
- **Dropped:**
  - the idle-shutdown timer, script and sudoers entry;
  - the idle marker every operation touched;
  - `rebake.sh`'s instance roll and task-definition PR;
  - the Secrets Manager read;
  - `select-state` / `restart-runner` / `patch-launch-script` (a lease boots one
    state and is released when sick).
- **Changed:**
  - the runner unit is no longer enabled at boot;
  - the bake host's SSH security group is scoped to the baker's IP;
  - bake resources carry `agent`/`capability` tags, never `canopy:*`. canopy's
    sweep terminates untracked `canopy:capability` instances, and that must not
    include a bake host.
