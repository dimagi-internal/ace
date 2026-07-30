# AVD session recording — design

**Date:** 2026-07-30
**Status:** approved design, not yet implemented
**Scope:** record video of every mobile recipe run alongside the existing
per-step screenshots, and publish the videos as run artifacts.

## Problem

ACE captures PNGs at every Maestro `takeScreenshot:` step. Those PNGs are
step *boundaries* — they say nothing about what happened between them. Two
costs follow:

1. **Forensics.** When a Phase 6 recipe dies, the artifacts are a final
   screenshot plus a UI dump. Whether the tap landed on the wrong cell, the
   keyboard covered the target, or an animation was still in flight is not
   recoverable from a still. The 2.63.0 selector-drift and dual-field-PIN
   arcs both burned multiple device round-trips on questions a video answers
   in one viewing.
2. **No watchable artifact.** A run produces a deck of stills. There is
   nothing a stakeholder or LLO can watch to see the built app work.

One capture serves both.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Purpose | Both forensics and a published artifact | One capture path, two consumers |
| Capture mechanism | On-device `adb shell screenrecord` | See § Mechanism |
| Capture scope | Every `mobile_run_recipe` call | Recording is a property of the run loop, not of Phase 6. Registration and heal recipes break as often as journeys |
| Publication | Everything uploads to Drive | Operator decision, 2026-07-30 |
| Backend staging | Phase 1 local, Phase 2 cloud | The cloud half needs an ace-web PR + deploy and cannot be validated from the plugin repo |

## Mechanism

Probed live against a running AVD (API 34, `screenrecord v1.3`) on
2026-07-30:

| Candidate | Result |
|---|---|
| `adb emu screenrecord` (emulator console) | **Rejected.** `KO: authentication token does not match ~/.emulator_console_auth_token`. The console authenticates per-macOS-user, and ACE workstations demonstrably run emulators under more than one account (`jjackson` + `acedimagi` observed concurrently). It would work for emulators we spawned and fail on any we attach to. Also emits webm and defaults to a 180 s cap |
| `adb shell screenrecord` (on-device) | **Chosen.** h264 mp4, `--time-limit 0` removes the 180 s cap, `pkill -INT` stops it. Independent of console auth and of which user owns the emulator process |
| ffmpeg capture of the emulator window | **Rejected.** The AVD launches `-no-window` (`backends/avd.ts`); there is no window to capture |
| Stitch existing PNGs into a timelapse | **Rejected as the capture path.** Only shows step boundaries — the exact information a video is wanted for is what it omits. ffmpeg is retained for container normalization only |

Recording must wrap the **whole** recipe run from outside Maestro:
`runRecipeWithDumps` splits a recipe into N separate `maestro test`
invocations at screenshot boundaries, so anything Maestro-driven would
fragment into N clips.

### Unproven property (merge gate)

The probe recorded 6 s of an **idle** screen and decoded to 1 frame with
`duration=N/A`. That is plausible for a static display — SurfaceFlinger
produces almost no frames — but it does **not** prove the SIGINT
stop-and-finalize path yields a well-formed mp4 for a screen that is
moving. Per `CLAUDE.md § close the loop to the source of truth`, this must
be validated live before merge: run one real journey recipe on a live AVD
and confirm the mp4 has >1 frame and a real duration. Do not merge on the
idle-screen probe.

## Phase 1 — local backend

### `mcp/mobile/screen-recorder.ts` (new)

Follows the injectable-shell pattern used by `maestro.ts` / `avd.ts` so it
is unit-testable without a device.

```
startRecording({ serial, dispatchId, spawn? }) -> RecordingHandle
stopRecording(handle) -> VideoArtifact | undefined
```

`startRecording` spawns, detached:

```
adb -s <serial> shell screenrecord --time-limit 0 \
    --bit-rate <ACE_MOBILE_RECORD_BITRATE|1M> \
    --size <ACE_MOBILE_RECORD_SIZE|540x1140> \
    /sdcard/ace-rec-<dispatchId>.mp4
```

A real `spawn` is required — the existing `ShellFn` awaits completion. Mirror
`avd.ts`'s emulator spawn, with an injectable spawn fn for tests.

`stopRecording`:

1. `adb shell pkill -INT screenrecord` — **SIGINT, not SIGKILL.** SIGKILL
   leaves the mp4 without a moov atom.
2. Poll the on-device file size until stable, bounded (~5 s).
3. `adb pull` into `screenshotDir`.
4. `adb shell rm` the device copy.
5. `ffmpeg -c copy -movflags +faststart` to normalize the container. If
   ffmpeg is absent, keep the raw pull.

**Every step is best-effort.** A recording failure must never change a
recipe's verdict — the same contract `captureFailureForensics` already
holds.

### Wiring in `MobileClient.runRecipe`

- Local backend only in this phase. Cloud logs a one-line declared gap and
  returns no video.
- Start after `resetScreenshotDir` (so the file lands in a freshly wiped
  dir), stop in a `finally` covering **both** the normal return and the
  throw path. The driver-death throw is the case the video is worth most.
- `runRecipeWithDriverHeal` can cold-boot the AVD mid-run, killing the
  recorder and rotating the serial. Handling: start and stop the recorder
  **inside the `runOnce` callback**, so each attempt produces its own
  segment and the `finally` covers the throw path for free. Naming:
  attempt 1 → `<recipeId>.mp4`, attempt N>1 → `<recipeId>-attempt<N>.mp4`.
  A healed run therefore yields `<recipeId>.mp4` (pre-crash — the
  interesting one) plus `<recipeId>-attempt2.mp4`. Both are retained.
- Result shape gains `RecipeRunResult.videos?: VideoArtifact[]` — an array,
  because of the heal-retry case. Each entry:
  `{ path, bytes, recipeId, dispatchId, attempt }`.
- Each video gets a provenance sidecar via the existing
  `lib/screenshot-provenance.ts`, same as PNGs.

### Publication — spool + sweep

The mobile MCP has no Drive credentials and no run context; skills do the
uploading. But heal, registration, and baseline recipes run from atoms
whose callers are not uploading skills — so "everything uploads" needs a
handoff:

- The recorder drops each video into a session-scoped spool at
  `~/.ace/mobile-videos/<ppid>/<timestamp>-<recipeId>[-attemptN].mp4`.
  `<ppid>` is the same per-session key `backend-toggle.ts` already uses.
- `app-screenshot-capture` Step 5 uploads its journey videos to
  `6-qa-and-training/videos/<recipe-base>.mp4` (`shareAnyoneWithLink: true`,
  `mimeType: video/mp4`) with manifest entries, **then sweeps the spool**:
  anything remaining (heal, registration, baseline) uploads to
  `6-qa-and-training/videos/_device/` and the spool is cleared.
- `qa-deep` and `connect-baseline-screenshots` run the same sweep so their
  runs are not orphaned.

### Configuration

| Env var | Default | Purpose |
|---|---|---|
| `ACE_MOBILE_RECORD` | `on` | `off` disables recording entirely |
| `ACE_MOBILE_RECORD_BITRATE` | `1M` | Encoder target |
| `ACE_MOBILE_RECORD_SIZE` | `540x1140` | Half of 1080x2280 |

The off switch is non-negotiable: this code sits in the run loop, and an
operator needs a one-line kill if recording ever destabilizes Phase 6.

At these settings expect roughly 5–8 MB per journey-minute. Since every
video uploads, revisit the numbers after the first real runs — they are a
starting point, not a validated budget.

### Failure handling

| Condition | Behavior |
|---|---|
| Any recorder error | Swallowed and logged; recipe status untouched |
| `pkill -INT screenrecord` is device-wide | Acceptable — one recorder per device is our own invariant, and `session-lock.ts` already prevents concurrent runs against a single AVD. Two sessions on *different* emulators are unaffected (pkill is scoped per `-s <serial>`) |
| Display size change | `screenrecord` stops early → short video, not a crash |
| Emulator dies mid-run | Pull fails → no video, logged |

## Phase 2 — cloud backend

Same mechanism; the emulator in the ace-web VM is an Android emulator too.
Verified against `ace-web` `origin/main` (af2fc53):

- `controller.run_recipe` builds a shell script, runs it via SSM, syncs an
  artifact dir to S3, and `_presign_prefix` presigns **everything** in that
  prefix — so an `.mp4` written into the artifact dir rides along with no
  new plumbing.
- The plugin's cloud `runRecipe` **already downloads every artifact** into
  `screenshotDir`; it only gates *classification* on `image/*`.

Work required:

1. **ace-web PR:** wrap the SSM script with `screenrecord` start →
   `pkill -INT` → pull into the artifact dir (~20 lines of bash). Confirm
   the presigned artifact's `content_type` resolves to `video/mp4`.
2. **Plugin:** classify `video/*` artifacts from `result.artifacts` into
   `videos[]` (~5 lines). The download already happens.
3. **Validation:** requires a deploy. Same merge gate as Phase 1 — a real
   recipe run producing an mp4 with >1 frame and a real duration.

Staged separately because it is a second repo and a second deploy, and
because the cloud half cannot be validated from the plugin repo.

## Testing

**Unit** (`test/mcp/mobile/screen-recorder.test.ts`, injected spawn/shell):

- argv shape, including `--time-limit 0`
- stop ordering: SIGINT → size-stable poll → pull → rm → ffmpeg normalize
- best-effort swallow at each failure point; a stop failure never throws

**Unit** (client wiring, fake recorder):

- recorder starts after `resetScreenshotDir` and before dispatch
- stop fires in `finally` on **both** the return path and the throw path
- `videos[]` populated; heal-retry produces two entries
- cloud path never records (Phase 1)

**Live gate (mandatory, both phases):** one real journey recipe on a live
device, `ffprobe` confirming >1 frame and a real duration. See § Unproven
property.

## Rollout notes

- This is MCP code: a **full Claude restart** is required for it to take
  effect, not `/reload-plugins` (`CLAUDE.md § MCP changes need a full
  Claude restart`).
- `playbook/integrations/mobile-integration.md` gains a Recording section
  covering the mechanism, the console-auth rejection, and the off switch.
- `docs/atom-schemas.md` catalogs atom *parameter* schemas, and
  `mobile_run_recipe`'s parameters do not change — so no regeneration is
  expected. Run `npx tsx scripts/dump-atom-schemas.ts` anyway and commit
  only if it produces a diff (the staleness gate is
  `test/scripts/dump-atom-schemas.test.ts`).
