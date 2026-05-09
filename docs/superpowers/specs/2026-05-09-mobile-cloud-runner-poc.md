## Mobile Cloud Runner — POC Spec

**Date:** 2026-05-09
**Status:** Draft for review
**Owner:** Jon

## Context

`ace-mobile` (Phase 5 emulation layer, shipped 0.9.0) is local-only by design — it drives a single AVD on the operator's Mac, and the 2026-04-28 design spec explicitly defers cloud device farms. That deferral is now blocking three concrete things:

1. Multi-operator collisions (two people running ACE on the same Mac fight over adb ports / AVD state).
2. Linux/Windows ACE users have untested host paths.
3. `ace-web` background jobs (e.g., scheduled deep QA, scheduled training-prep refresh) have no way to drive mobile flows because nothing in the cloud runs an emulator.

The cheapest, lowest-friction fix is a **spin-up/spin-down cloud emulator** wrapped behind the same MCP capability map that `ace-mobile` already exposes. The POC validates three things: that an EC2-hosted Android emulator can run our existing Maestro recipes unchanged; that the start/stop economics actually land near $0 at our usage; that an HTTP API surface in `ace-web` is enough to swap behind `mcp/mobile/capability-map.ts` without touching skills.

## Goals

1. A new `CLOUD` backend in `mcp/mobile/capability-map.ts` that routes `ensure_avd_running`, `install_apk`, `run_recipe`, `save_snapshot`, `load_snapshot`, `capture_ui_dump` to an HTTP API in `ace-web`. Skills don't change.
2. An ace-web HTTP service that owns one EC2 instance: `start → run → stop`, with three independent auto-stop layers so leaks are structurally hard.
3. A pre-baked AMI that boots straight into a working Android emulator state — KVM enabled, SDK + system image cached on disk, CommCare APK pre-staged, AVD pre-warmed to a "logged-in test user" snapshot.
4. End-to-end smoke run: `mobile_run_recipe(recipePath="connect-login.yaml", ...)` invoked from a skill, dispatched to the `CLOUD` backend, executed against the EC2 emulator, screenshots streamed back to Drive at `ACE/<opp>/screenshots/`. One green test, end-to-end, is the success bar.
5. Cost target: under $5/mo at 50 runs × 5min/run; under $20/mo at 10× that volume.

## Non-goals

- Multiple device targets / device variety. One AMI, one AVD shape (Pixel 7, API 34, x86_64), matching the local stack.
- Concurrency. One run at a time per instance. (Forking to N parallel instances is a Phase 2 question once the singleton path is solid.)
- iOS. Android only.
- Migration path off Mac AVD. Local AVD remains the default for operator-driven runs; cloud is opt-in via env var or skill arg.
- ARM64 emulator path on Graviton. x86_64 with nested virt only.
- Real-device cloud (BrowserStack, Sauce, Firebase). Spin-up/down emulator only.
- Multi-user auth state. The pre-baked snapshot embeds *one* registered ConnectID test user; rotating that is a manual rebuild.
- Anything that touches `ace-web`'s production deployment topology beyond adding one Express route group + one IAM role + one EC2 instance.

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ ACE plugin (this repo)                                          │
│                                                                 │
│ skill (e.g. app-screenshot-capture)                             │
│   └─ MCP atom: mobile_run_recipe(...)                           │
│       └─ capability-map.ts: route → CLOUD backend (when env set)│
│           └─ mcp/mobile/backends/cloud.ts                       │
│               POST https://ace-web/api/mobile/run-recipe        │
└────────────────────────────────────────────────────────────────┘
                              │ HTTPS, ACE_WEB_PAT_TOKEN
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ ace-web                                                         │
│                                                                 │
│ Express routes: /api/mobile/{ensure-running, install-apk,       │
│   run-recipe, save-snapshot, load-snapshot, capture-ui-dump,    │
│   stop, status}                                                 │
│   └─ EmulatorController                                         │
│       ├─ AWS SDK: ec2.startInstances / stopInstances            │
│       ├─ SSH (ssh2): adb / maestro / shell over SSH             │
│       └─ S3 download: artifacts (screenshots/PNGs) → presigned  │
│           URLs returned to caller, who fetches + uploads to     │
│           Drive (Drive auth stays in the plugin, not ace-web).  │
│                                                                 │
│ Auto-stop layers:                                               │
│   1. finally{} block in EmulatorController                      │
│   2. In-VM `shutdown -h +10` after each run + EC2's             │
│      InstanceInitiatedShutdownBehavior=stop                     │
│   3. CloudWatch alarm: CPU<5% for 30min → stop instance         │
└────────────────────────────────────────────────────────────────┘
                              │ EC2 API + SSH
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ AWS                                                             │
│                                                                 │
│ EC2 m8i.xlarge (4 vCPU / 16 GiB), nested virt enabled           │
│   AMI: ace-mobile-emulator-vN (pre-baked)                       │
│     - Ubuntu 24.04 + KVM (kvm-ok passes)                        │
│     - Android SDK + system-images;android-34;google_apis;x86_64 │
│     - AVD `ACE_Pixel_API_34` pre-created                        │
│     - CommCare 2.62.0 APK at /opt/ace/apks/commcare.apk         │
│     - Maestro CLI at /opt/maestro                               │
│     - Snapshot `registered-test-user` pre-saved                 │
│   30 GB gp3 root volume                                         │
│   Tags: auto-stop=true, owner=ace-web-mobile-poc                │
│   Security group: SSH from ace-web's egress IP only             │
│                                                                 │
│ S3 bucket: ace-mobile-artifacts-<env>                           │
│   PUT from EC2 instance role; GET via presigned URL             │
│                                                                 │
│ CloudWatch alarm: CPU < 5% / 30min → ec2:StopInstances          │
└────────────────────────────────────────────────────────────────┘
```

## HTTP API contract (ace-web ↔ MCP)

All endpoints are POST, JSON, auth via `Authorization: Bearer <ACE_WEB_PAT_TOKEN>`. Idempotent where noted. Errors return `{error: {code, message}}` with HTTP 4xx/5xx.

| Path | Body | Returns | Idempotent |
|---|---|---|---|
| `/api/mobile/ensure-running` | `{}` | `{instance_id, state, public_dns, started_at}` | yes — no-op if already running |
| `/api/mobile/install-apk` | `{apk_url}` (presigned URL or `built-in:commcare-2.62.0`) | `{package_name, version}` | no — `adb install -r` |
| `/api/mobile/run-recipe` | `{recipe_yaml: string, env: {[k]: string}, screenshot_prefix?: string}` | `{exit_code, stdout, stderr, artifacts: [{name, presigned_url, content_type}]}` | no |
| `/api/mobile/save-snapshot` | `{name}` | `{name, saved_at}` | no |
| `/api/mobile/load-snapshot` | `{name}` | `{name, loaded_at}` | no |
| `/api/mobile/capture-ui-dump` | `{}` | `{xml: string}` | no |
| `/api/mobile/stop` | `{}` | `{instance_id, state, stopped_at}` | yes |
| `/api/mobile/status` | — (GET) | `{instance_id, state, last_run_at, idle_for_seconds}` | yes |

**Recipe transport:** `recipe_yaml` is the literal YAML string, not a path — the cloud runner has no shared filesystem with the caller. The MCP backend reads the local file and POSTs the content. Same for `apk_url`: caller pre-uploads APK to S3 (or refers to the built-in pre-staged one) and passes a URL.

**Artifacts:** `run-recipe` returns presigned URLs that expire in 1 hour. The MCP backend downloads each artifact and writes it to its expected local destination (typically `ACE/<opp>/screenshots/<step>.png` via Drive). ace-web does not know about Drive.

## AMI contents (pre-baked, versioned)

Pinned versions live in `ace-web`'s `infra/mobile-ami/Packerfile` (or equivalent). v1 ships:

- Ubuntu 24.04 LTS (x86_64)
- `qemu-kvm`, `libvirt-daemon-system`, kernel modules loaded; `kvm-ok` passes
- OpenJDK 17
- Android command-line tools, `platform-tools` (adb), `emulator`, `system-images;android-34;google_apis;x86_64`
- AVD: `ACE_Pixel_API_34`, Pixel 7 hardware profile, `hw.camera.front=emulated`, 4 GB RAM, 6 GB internal storage
- Maestro CLI 2.5.x at `/opt/maestro/bin/maestro`
- CommCare APK 2.62.0 at `/opt/ace/apks/commcare.apk` (md5 in AMI metadata)
- Pre-saved AVD snapshot `registered-test-user`: emulator booted, CommCare installed, ACE test user registered + logged in, Connect mobile-app handoff completed
- systemd unit `ace-mobile-runner.service`: starts emulator with `-no-window -gpu swiftshader_indirect -no-snapshot-save -snapshot registered-test-user` on boot
- SSH: ed25519 host keys; instance role allows S3 PutObject scoped to `ace-mobile-artifacts-*`

**Refresh cadence:** rebuild AMI when CommCare APK rev'd or test-user identity rotated. Manual `npm run build:ami` from `ace-web`. AMI version recorded in `ace-web` config + surfaced in `/status` response.

## Auto-stop layers (independent, all three required)

1. **Application-level `finally`.** Every Express handler that calls `ec2.startInstances` registers an `afterRun` callback that calls `/api/mobile/stop`. Wrapped in `try/finally` so exceptions in the run path still trigger stop.

2. **In-VM shutdown.** `ace-mobile-runner.service` watches for an idle marker file (`/var/run/ace-mobile/last-activity`); if no activity for 10 minutes, runs `sudo shutdown -h now`. EC2 launch template sets `InstanceInitiatedShutdownBehavior=stop` so this stops the instance, doesn't terminate it. Independent of any ace-web call — survives ace-web crash.

3. **CloudWatch alarm.** `CPUUtilization < 5% for 30 consecutive minutes` → `arn:aws:automate:<region>:ec2:stop`. Catches the case where (1) and (2) both failed (e.g., a runaway emulator pegging CPU low but not actually doing work). ~$0.10/mo.

POC success bar: kill the ace-web process mid-run; verify the instance still stops within 40 minutes.

## MCP `CLOUD` backend (this repo, ~80 lines)

`mcp/mobile/capability-map.ts`:

```ts
export type Backend = 'MAESTRO' | 'AVD' | 'COMPOSITE' | 'CLOUD';
```

`mcp/mobile/backends/cloud.ts` (new): typed HTTP client. Reads `ACE_WEB_BASE_URL` + `ACE_WEB_PAT_TOKEN` from env. Exposes the same shape as `avd.ts` so the dispatcher swap is mechanical.

Routing rule: the dispatcher picks `CLOUD` when env var `ACE_MOBILE_BACKEND=cloud` is set, otherwise falls back to current AVD/Maestro behavior. POC default stays `AVD`. No skill changes.

Atoms NOT routed to cloud in v1 (deliberately):
- `register_test_user` — the registered state is *baked into the AMI snapshot*, so this becomes a no-op on cloud. The MCP atom returns success immediately when backend=cloud and the AMI advertises a pre-baked test user.
- `list_avds`, `stop_avd` (the AVD-CLI ones) — local-only.
- `generate_recipes_from_app_summary` — runs in-MCP, not on the device; backend-independent.

## Success criteria

A POC is "done" when **all five** of these pass in one session:

1. `aws ec2 describe-instances --filters Name=tag:owner,Values=ace-web-mobile-poc` shows `state=stopped` from a cold start. Run a smoke recipe; instance starts, recipe runs, instance returns to `stopped` within 2 min of recipe finish.
2. `mobile_run_recipe` invoked from this plugin (env: `ACE_MOBILE_BACKEND=cloud`) returns the same shape as the AVD backend; one PNG lands in Drive `ACE/_poc/screenshots/`.
3. Recipe execution wall-clock under 90s for a known-fast recipe (e.g., `connect-login` against the pre-baked snapshot).
4. Kill ace-web mid-run (`SIGKILL`); instance stops within 40min via layer 2 or 3.
5. Cost telemetry: a 10-run smoke loop costs <$0.50 of EC2 + S3 (verify via Cost Explorer or instance hours × rate).

## Open questions

- **APK source of truth.** AMI bakes 2.62.0; Connect mobile is on a faster release cadence. Do we accept a stale APK between rebuilds, or do we add an `install-apk` "fetch latest from Connect releases" path? POC: stale-is-fine; rebuild on demand.
- **Snapshot rot.** The pre-baked `registered-test-user` snapshot embeds a registered ConnectID session for a `+7426`-prefixed demo phone (Connect-id skips OTP entirely for that range — no human-in-the-loop OTP entry needed at bake time). Sessions can still expire server-side. POC: ignore until it bites; v2 might include a `refresh-snapshot` admin endpoint that re-runs the demo registration in-place.
- **Drive vs S3 for artifacts.** Current local backend writes PNGs straight to a local screenshotDir; the plugin orchestrates Drive upload. Cloud needs S3 as transit. Worth keeping S3 as the *only* sink and having ace-web push to Drive directly? POC: no — keep Drive auth in the plugin, pass through S3.
- **Concurrency.** Singleton EC2 means two simultaneous `mobile_run_recipe` calls serialize. POC: 503 the second caller. Real fix is a small instance pool with a queue; out of scope.
- **AMI build pipeline.** Manual `packer build` for v1, GitHub Actions later. POC: manual.

## Out-of-scope follow-ups (filed, not done)

- Concurrent runs (queue + N-instance pool).
- ARM64 / Graviton emulator path.
- iOS Simulator on `mac1.metal`.
- GCP variant (kept warm as a comparison; revisit if AWS C8i nested virt has surprises in production).
- Multi-tenant: one cloud emulator service serving multiple ACE installs.
