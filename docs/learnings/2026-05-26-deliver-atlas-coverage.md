# Deliver-side atlas coverage — IDs replace text + coordinate anchors

**Date:** 2026-05-26
**Status:** Resolved. `deliver-launch.yaml` now ID-anchors every Deliver-side step.

## Background

`docs/learnings/2026-05-14-atlas-side-channel-capture.md` and the prior `deliver-launch.yaml` comment block both flagged that the Deliver-side selectors (atlas § 8 certificate, § 9 Download Delivery gate) were captured via coordinate-tap during a single 2026-05-14 turmeric session and text-anchored otherwise. The structural cure was always: capture proper UI dumps during a real Deliver-side Phase 6 dispatch and back-fill the resource-IDs.

## What landed

Harvested from `bednet-spot-check / 20260526-1556` J2 dumps (`/tmp/ace-bednet-recipes/screenshots/J2/*.xml`) via `scripts/probe-atlas-drift.ts` (59 new resource-IDs total). The Deliver-flow-relevant ones added to `mcp/mobile/selectors/connect-2.63.0.yaml`:

| Logical name | Resource-id | Visible text | Surface |
|---|---|---|---|
| `deliver-opp-detail-view-button` | `connect_learning_button` | "VIEW OPPORTUNITY DETAILS" | atlas § 8 opp-detail |
| `deliver-certificate-container` | `connect_learning_certificate_container` | (container) | atlas § 8 (section *within* opp-detail, not separate screen) |
| `deliver-download-button` | `connect_delivery_button` | "DOWNLOAD" | atlas § 9 Download gate |
| `deliver-details-title` | `connect_delivery_title` | "Delivery Details" | atlas § 9 |
| `deliver-action-title` | `connect_delivery_action_title` | "Start Visit" | atlas § 9 |
| `deliver-action-details` | `connect_delivery_action_details` | "Download Delivery" | atlas § 9 |
| `deliver-home-job-card` | `viewJobCard` | (project card) | atlas § 10 Deliver home |
| `deliver-home-job-title` | `tv_job_title` | opp display name | atlas § 10 |
| `deliver-home-job-description` | `tv_job_description` | opp description | atlas § 10 |

## Surprising findings

- **The certificate is a section, not a screen.** Prior assumption (from the 2026-05-14 turmeric walk) was that "Congratulations, you completed the Learn modules" was a separate transient screen. The bednet J2-opp-detail.xml dump shows it's actually a `connect_learning_certificate_container` inside the opp-detail screen itself. The recipe's old "auto-dismissed certificate" branch was actually "we're on opp-detail with the certificate section rendered."
- **`connect_delivery_button` is the DOWNLOAD action.** Was previously text-anchored on `"DOWNLOAD"` with a coordinate fallback at (741, 1248) on 1080×2400. Now ID-anchored; both the fallback and the resolution-pinning go away.

## Recipe simplifications

`deliver-launch.yaml` now uses `${SELECTOR:...}` placeholders end-to-end. Two side-effect cleanups landed alongside:

1. **`retryTapIfNoChange: true` dropped from ID-anchored taps.** The retry was a text-anchor flakiness workaround; ID-anchored taps don't need it.
2. **The comment block describing "resource-IDs NOT yet captured live"** is gone — replaced with a concrete reference back to this learning.

## How to repeat the harvest for new APK versions

```bash
# 1. Find a recent Phase 6 run that captured Deliver-side ui-dumps.
ls /tmp/ace-bednet-recipes/screenshots/J2/  # or your opp's J<n> dir

# 2. Run the harvester against it.
npx tsx scripts/probe-atlas-drift.ts /tmp/<your-dump-dir> --apk 2.63.0 \
  --out /tmp/atlas-drift-report.md

# 3. Review the "Resource-ids in dumps but NOT in selector map" section.
# 4. Add the ones worth keeping to `mcp/mobile/selectors/connect-<apk>.yaml`
#    with `text=`-verified labels (grep the XMLs for `text="X" resource-id="ID"`).
# 5. Update any static recipes that should now use the new logical selectors.
# 6. Run `npx vitest run test/mcp/mobile/static-palette-health.test.ts` to verify
#    every selector reference resolves post-substitution.
```
