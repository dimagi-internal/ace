# Deployment Summary — CRISPR-Test-002

> Synthetic deployment-summary stub. Written by `app-deploy` after the Learn + Deliver apps are uploaded to CommCare HQ. Used downstream by `app-test` and `connect-opp-setup`. For the test fixture, all IDs and URLs are fake.

## Deployed apps

| App | Type | App ID | Build | Status | URL |
|---|---|---|---|---|---|
| Focus Group Facilitation Training (Learn) | Learn | `app-fake-fg-learn-002` | 5 | published | https://www.commcarehq.org/a/crispr-test/apps/view/app-fake-fg-learn-002/ |
| Focus Group Session Documentation (Deliver) | Deliver | `app-fake-fg-deliver-002` | 4 | published | https://www.commcarehq.org/a/crispr-test/apps/view/app-fake-fg-deliver-002/ |

## Domain

- **Domain:** `crispr-test`
- **Project space:** TestLand pilot
- **Build environment:** sandbox (do not use against production CCHQ)

## Archetype-specific notes

- **Learn app** is the 8-module facilitation training (not a form walkthrough). Facilitators must complete all 8 modules and pass each knowledge check before being marked session-ready.
- **Deliver app** is a session documentation form (not per-beneficiary). The case structure is per-segment, not per-participant.
- File upload endpoints are configured for both audio (`.m4a` / `.mp4`) and attendance photos.
- Test fixture only — do not use these app IDs against real CCHQ.
