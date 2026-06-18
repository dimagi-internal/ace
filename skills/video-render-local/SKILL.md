---
name: video-render-local
description: >
  Use when you need an ace-web connect-videos program rendered to MP4
  locally and fast (bare-metal Mac), instead of the slow server-side
  ace-web "Re-render" — including rendering a DDD connect-ddd-walkthrough
  from a local spec + master clip with no Drive and no Django container.
---

# Video Render — Local (Mac-metal)

Render an ace-web **connect-videos** program to `output.mp4` on the host's
Node / Chromium / esbuild (1–3 min) instead of the slower Docker/server
`/build` queue. Wraps ace-web's `scripts/render_locally.py`. ElevenLabs
voiceover + music bed are muxed in; the renderer **holds the last frame of
a clip range when its narration overruns**, so a too-long script shows up
as frozen footage (see the timing report below).

## When to use
- Iterating on a video locally and you want the fast render, not the server queue.
- Rendering a DDD narrative as a `connect-ddd-walkthrough` from a `spec.yaml` + master clip that exist only locally (e.g. canopy's emitter output) — **no Drive, no container**.
- NOT for publishing to Drive/labs — that's the server `/build`, or Mode B with `--publish`.

## Prerequisites
- An **ace-web checkout** (default `~/emdash-projects/ace-web`; override `$ACE_WEB_ROOT`). It vendors the renderer at `video-production/connect-videos` and `scripts/render_locally.py`.
- connect-videos deps installed once: `cd "$ACE_WEB/video-production/connect-videos" && npm ci` (~minutes). The script errors clearly if absent.
- `ELEVENLABS_API_KEY` in the environment or the ace `.env` (1Password: `ACE - ElevenLabs API Key`). The renderer refuses to silently drop voice.
- `ffmpeg` on PATH.

## Resolve the checkout
```bash
ACE_WEB="${ACE_WEB_ROOT:-$HOME/emdash-projects/ace-web}"
[ -f "$ACE_WEB/scripts/render_locally.py" ] || { echo "no ace-web checkout at $ACE_WEB — set ACE_WEB_ROOT"; exit 1; }
```

## Mode A — local spec + master clip (DDD / general, no Drive)
The caller already has a connect-videos `spec.yaml` (e.g. canopy's emitted
`explainer_spec.yaml`) and a master clip. Stage + render directly:
```bash
cd "$ACE_WEB"
python scripts/render_locally.py \
  --local-spec /path/to/spec.yaml \
  --master     /path/to/walkthrough.mp4 \
  --final            # omit for a faster --draft preview
```
Slug + run come from the spec (`slug:` / `--run`, default `run-001`); the
master is copied to the spec's `manifest.master: file:…` path. Output:
`video-production/connect-videos/programs/<slug>/runs/<run>/output.mp4`.

## Mode B — existing Drive program (Docker app container up)
```bash
cd "$ACE_WEB"
python scripts/render_locally.py <program-slug>            # or: <slug> <run-id>
python scripts/render_locally.py --publish <program-slug>  # also push artifacts to Drive
```

## Read the output — the timing report
After rendering the script prints:
```
clip footage (spec beats):   64.0s
rendered duration:           77.5s
held-frame overrun:         +13.5s  ⚠ VO overruns clips — trim narration
```
A large overrun means the narration is longer than the footage and the
renderer froze the last frame waiting for the VO. Trim the narration to
play continuously — budget **≈2.2 words/sec** for the ElevenLabs
`eleven_turbo_v2` voice (not 2.5; that overshoots).

## Pointing at a specific renderer
`$CONNECT_VIDEOS_ROOT` (or `--connect-videos-root`) overrides just the
connect-videos project — render against a canonical install regardless of
which checkout the script lives in. Honored by both `render_locally.py`
and its QA probe.

## Common mistakes
- **Stale checkout** — default is `~/emdash-projects/ace-web`; set `$ACE_WEB_ROOT` (or `$CONNECT_VIDEOS_ROOT`) to target another. Don't render from a feature worktree by accident.
- **Missing `node_modules`** — `npm ci` in connect-videos once; the host arch must match (run on the Mac, not in the Linux container — that's the whole point).
- **`--publish` in local-spec mode** — rejected; there's no Drive program. Use Mode B to publish.
- **`manifest.master` not a `file:` ref** — local mode copies `--master` to the `file:` path the spec names; emit the spec with a `file:` master (canopy's DDD emitter does).

## Intended caller
canopy's on-demand `ddd-ace-render` emits the `connect-ddd-walkthrough`
spec + records the master clip, then invokes this skill (Mode A) to produce
the narrated MP4.
