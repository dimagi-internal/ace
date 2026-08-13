---
name: selector-map-heal
description: >
  Repair the mobile selector map from a live failure dump when a Phase 6 walk
  hits a surface the map has never covered. Triggered by an atlas-report.yaml
  carrying `classification: unmapped-surface`. Proposes NEW selector rows from
  the dump, proves them by re-running the blocked leg on-device, and ships them
  only on green. Narrow sibling of selector-map-calibrate, which stays manual.
---

# Selector-Map Heal

## When to run — and when to stop

Read `atlas-report.yaml` from the run folder and branch on `classification`:

| classification | action |
|---|---|
| `unmapped-surface` | **Run this skill.** The map has no anchor on that screen. |
| `matcher-miss` | **STOP.** The element IS on screen; the recipe reached for it wrongly. Fix the recipe. Do NOT add a selector row. |
| `drift` | **STOP.** An anchor moved. Update the existing row via `selector-map-calibrate`. |
| `mapped` | **STOP.** Nothing to heal; the failure is elsewhere. |

Adding a row on a `matcher-miss` is the inversion that produced
jjackson/ace#811 and #893 — both shipped a new anchor for a screen whose
anchors were fine.

## Guard 1 — additive only

You may ADD rows. You may **never mutate a row carrying a `Live-verified`
note** — that row records a live-device observation, and overwriting evidence
with a fresh guess is the #893 failure class.

This is enforced mechanically, not on trust: `scripts/check-selector-map-diff.ts`
runs in the pre-commit hook and rejects the commit. Do not try to route around
it — if you believe a `Live-verified` row is genuinely wrong, re-verify on a
device and update its purpose note in the same commit.

## Guard 2 — green or nothing

Propose rows from the dump, apply them, then **re-run the blocked leg
on-device**.

- Green ⇒ open a PR and arm auto-merge (`gh pr merge <n> --auto --merge`).
- Red after 2 attempts ⇒ **stop and file** an issue with the dump attached.

Never ship an unproven row. Shipping a plausible guess is precisely the class
this skill exists to end, and a red re-run is the only thing that can tell you
your guess was one.

## Guard 3 — never cold-boot over a human's emulator

`mobile_ensure_avd_running` kills and wipes the running emulator. Confirm
before cold-booting over an AVD someone may be driving by hand.

## Provenance

Every new row's `purpose` string names the dump file and the run it came from,
so the next reader checks provenance instead of trusting the note. A row that
cannot say where it came from is a guess wearing a citation.

## Why auto-merge is legitimate here

ACE's standing rule is that selector and recipe changes are validated on a live
device before merge. Here the green re-run in Guard 2 **is** that validation,
performed immediately before the merge. This is the one path where self-heal
and the live-validation rule agree rather than conflict — which is exactly why
the loop closes here and nowhere else.
