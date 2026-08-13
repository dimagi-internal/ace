# Deck-template assets

Committed artwork that is **part of the deck template**, not something ACE
captures per run (dimagi-internal/ace#873).

`assets.yaml` is the manifest — read it first; it carries the per-asset
contract and, for each one, the verified reason it cannot be captured.

## The distinction that matters

| | Where it comes from | Counted in visual coverage? |
|---|---|---|
| `manifest.opp` | this run's device captures | **yes** — the only bucket that is |
| `manifest.common` | shared Connect pool, per APK version | no |
| `manifest.template` | **here** — committed artwork | no |

A missing template asset is a **template-bundle defect**. A missing per-opp
capture is a **run defect**. Conflating the two is what let a deck with 9%
image coverage score 9.5 and ship to an operator (ace#856), so the code keeps
them in separate buckets and the gate only ever measures the run's own work.

## Relationship to `../fixtures/`

`fixtures/` was the earlier answer to the same problem: static PNGs used as a
*fallback* when a live capture failed. It was scaffolded but never filled —
zero PNGs were ever committed — and it kept the aliases on the capture roster,
so every run still tried and still recorded a miss.

The template-asset model retires that framing for these four. They are not
fallbacks awaiting a capture that will never come; they are the intended
content. `fixtures/` remains for the install-flow aliases
(`play-store-search`, `commcare-install`, `commcare-open`), which are
genuinely capturable by anyone with a Google-signed-in device and are simply
not captured by our AVD.

## Authoring one

1. Read the asset's `shows:` and `why:` in `assets.yaml`.
2. Produce a ~1080x2400 PNG. A real screenshot from a real first-time
   sign-up on a real phone is best; a clean designed panel is acceptable and
   is what the operator asked for. What is **not** acceptable is a screenshot
   of the *recovery* flow captioned as first-time sign-up — that is the
   specific misrepresentation this whole mechanism exists to avoid.
3. Commit it here as `<alias>.png`.
4. Flip `status: needed` → `status: authored` in `assets.yaml`.

Nothing auto-generates or rotates these.
