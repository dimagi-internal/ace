# Deliver App Summary — Turmeric Market Survey (SYNTHETIC)

**App ID:** DEL-TURMERIC-SYN-0001
**Archetype:** atomic-visit
**Source PDD:** `pdd.md`

## Purpose
Capture one geo-tagged, photo-documented observation per turmeric vendor
plus the outcome of a short educational conversation.

## Module: Vendor Intake
One form, ~14 fields, spanning:
- **Location & Identification** — market name, GPS auto, photo with MTN card
- **Vendor** — type (fixed/roaming/wholesale/other), gender
- **Product** — form (fresh/dried/ground/other), price, unit, stock level
- **Origin** — known-origin flag + optional free-text origin
- **Quality (FLW observation)** — color, shininess, free-text appearance notes

## Module: Vendor Education
Three fields — whether the education was delivered, how the vendor
responded, and optional free-text notes.

## Verification Rules (Layer A)
- `photo` required, not-empty
- `gps` required, within configured bounding box (set during
  `connect-opp-setup`)
- All `required: true` fields populated

## Daily Caps
- Max 20 vendor deliveries per FLW per day
- Max 5 vendor deliveries per market per day

## Out of Scope
- No case lifecycle (one-shot delivery)
- No follow-up visits
