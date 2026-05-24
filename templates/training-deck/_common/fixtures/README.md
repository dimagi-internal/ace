# Common-screenshot fixtures

Static PNGs used as fallback when an alias declared in
`platform-setup.yaml` is NOT reachable via live recipe capture. The
`common-screenshot-capture` skill reads these per-alias when the live
recipe path is unavailable, and uploads them to Drive alongside the
live captures.

## When to use a fixture

See `skills/common-screenshot-capture/SKILL.md § Coverage table` for
the canonical list of which aliases are live vs fixture. The breakdown
as of 2026-05-24:

| Flow | Live (8) | Fixture (8) |
|------|----------|-------------|
| Navigation+sync | commcare-welcome, connect-home, sync-button, claim-opp, learn-install | — |
| PersonalID | personal-id-start, personal-id-phone, personal-id-name | personal-id-verify, personal-id-photo, personal-id-id, personal-id-location, personal-id-done |
| Install | — | play-store-search, commcare-install, commcare-open |

## Fixture file naming

`<alias>.png` — exact match against the alias key in
`platform-setup.yaml`. Examples:

```
personal-id-verify.png
personal-id-photo.png
personal-id-id.png
personal-id-location.png
personal-id-done.png
play-store-search.png
commcare-install.png
commcare-open.png
```

## How to capture a fixture

Two paths, choose based on whether the surface is real or imagined:

### Surface exists on a real device but isn't reachable from our test setup

Examples: `personal-id-photo` (recovery returns server photo; need a
fresh-signup user), `personal-id-verify` (real OTP entry — needs a
non-+7426 phone with SMS reception), `play-store-search` (needs a
Google-signed-in AVD).

1. Use a real Android device (your phone, a fresh AVD with Google
   account, etc.) to drive the flow to the target surface.
2. Take a screenshot via the device's screenshot mechanism.
3. Crop / resize to ~1080x2400 (matches our recipe captures).
4. Commit as `<alias>.png` in this directory.

### Surface may not exist in the current APK (deck content was AI-imagined)

Example: `personal-id-id` ("Scan your ID") — appears in
`platform-setup.yaml` but no evidence it's a real screen in the
2.63.0 PersonalID flow.

1. Verify by manually walking through PersonalID signup on a real
   device.
2. If the surface doesn't exist, edit `platform-setup.yaml` to remove
   the alias (better than carrying a permanent placeholder).
3. If the surface DOES exist, capture per above.

## Placeholder PNGs (interim)

If you can't capture a real fixture immediately, commit a placeholder
PNG with a clear visual marker so the deck renders SOMETHING. The
orchestrator emits a `WARN` in `verdict.yaml` for any fixture marked
`placeholder: true`.

Minimal placeholder generation (any of these work):

- macOS Preview: New from Clipboard with a screenshot of a text-only
  page that says "PLACEHOLDER — <alias>".
- HTML rendering: open a simple HTML page in a browser, save the
  rendered area as PNG.
- Tools like Figma / Sketch: export a 1080x2400 frame.

## Lifecycle

Fixtures live in repo; they're committed once and reused across every
`common-screenshot-capture` invocation until the Connect APK
significantly changes the corresponding flow. Re-capture only when:

- The APK ships a new PersonalID UI variant
- The deck adds a new `platform-setup.yaml` alias not covered by a
  live recipe
- An operator manually re-captures a previously-placeholder fixture

The `common-screenshot-capture` skill never auto-generates or rotates
fixtures.
