---
description: Render an ace-web connect-videos program to MP4 locally (bare-metal Mac, fast) — from a local spec + master clip, or an existing Drive program
argument-hint: (--local-spec <spec.yaml> --master <clip.mp4> [--final]) | <program-slug> [<run-id>] [--publish]
allowed-tools: [Read, Bash]
---

# /ace:video-render-local

Render a connect-videos video program to `output.mp4` on the local host's
Node/Chromium (1–3 min), instead of the slow server-side ace-web render.
Two modes: a **local spec + master clip** (DDD `connect-ddd-walkthrough`,
no Drive) or an **existing Drive program** by slug.

**Read the skill and follow it** — it is the source of truth for checkout
resolution, prerequisites, both modes, and how to read the timing report:

```bash
python3 -c "import json; d=json.load(open('$HOME/.claude/plugins/installed_plugins.json')); print(d['plugins']['ace@ace'][0]['installPath'] + '/skills/video-render-local/SKILL.md')"
```

Read that file with the Read tool and follow it. Map the invocation's
arguments onto the skill's Mode A (`--local-spec` + `--master`) or Mode B
(`<program-slug>`). Report the output mp4 path and the timing report to the
user; flag any `held-frame overrun` so they can decide whether to trim the
narration before shipping.
