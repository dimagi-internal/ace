# Invite-verification atom — deferred

**Status:** Designed, not shipped. The deterministic-bootstrap heal layer (PR #282) covers the main failure class this atom was meant to catch; shipping the atom became defense-in-depth rather than load-bearing.

## What the atom was meant to do

Verify that a Phase 4 `connect_send_flw_invite` call actually landed before Phase 6 boots the AVD. Pre-this-design, Phase 4 marked invites as `queued` and Phase 6 hit the device assuming the invite had propagated; if the SMS hadn't dispatched (or the user record didn't exist on Connect), Phase 6 would surface an empty jobs list with no diagnostic.

Shape: `connect_verify_flw_invite_delivered(opportunity_id, phone_number) → {status: 'delivered'|'queued'|'not_found', accepted: bool}`.

## Why we deferred

The 2026-05-14 deterministic-bootstrap refactor (PR #282) wipes Connect's app data and re-registers the test user on every Phase 6 dispatch. After register, Connect issues a fresh session and the device pulls its invite list anew. Net effect:

1. **Stale-cache failures are structurally impossible.** The device never trusts a cached invite list from a prior session.
2. **Invite propagation timing is no longer fragile.** Phase 4 → Phase 6 has the device re-syncing inside Phase 6, not relying on whatever the snapshot captured.

So the remaining failure modes the verification atom would catch:

- **`add_connect_users.delay()` failed to enqueue** (Connect-side Celery outage). Rare.
- **Phone number doesn't match a ConnectID** (`UserInviteStatus.not_found`). Surfaces on the device as an empty invite list — same symptom, but the cause is "phone unknown to Connect" not "phone known but invite cached stale."
- **SMS delivery failed** for non-demo users (`UserInviteStatus.sms_not_delivered`). N/A for ACE — all test users use `+7426` demo bypass.

The remaining cases are low-frequency and surface clearly enough at the heal layer that the atom isn't load-bearing.

## What we'd build if we ship

### Upstream gap

commcare-connect has no GET REST endpoint for per-opportunity FLW invite status. The data is in the `UserInvite` model (`commcare_connect/opportunity/models.py:990`) with values from `UserInviteStatus`:

- `invited` — created locally, SMS not yet dispatched
- `sms_delivered` — Twilio confirmed delivery
- `sms_not_delivered` — Twilio delivery failure
- `accepted` — FLW tapped the SMS link / opened Connect / saw the invite
- `not_found` — phone number doesn't match any ConnectID record

Reachable only via HTML dashboards today (`/a/<org>/opportunity/<uuid>/`).

### Two implementation paths

**Path A (ship today):** Playwright HTML scrape of the opportunity dashboard.
- Add `connect_verify_flw_invite_delivered` to `mcp/connect/backends/playwright.ts`.
- Hit `/a/<org>/opportunity/<uuid>/` with the existing authenticated session.
- Parse the user-invites table; find the row matching `phone_number`; extract status text.
- Cost: ~200ms per call; brittle to UI rerenders.

**Path B (preferred):** File an issue + PR upstream for a REST endpoint:
```
GET /api/opportunities/<opportunity_id>/invites/
  → [{phone_number, status, notification_date, accepted}, ...]
GET /api/opportunities/<opportunity_id>/invites/<phone>/
  → {phone_number, status, notification_date, accepted}
```
Both auth via existing PAT; both return the `UserInvite` row(s) shaped by a DRF serializer. ~1 hour upstream PR.

When the REST endpoint lands, our atom becomes a 30-line wrapper; until then, Path A is the bridge if we need it.

## Recommendation

Don't build until either (a) we observe a Phase 6 failure that this would catch but the heal layer doesn't, or (b) we want server-side validation in Phase 4 before incurring the Phase 6 AVD cost. Otherwise the heal layer carries the contract.

If/when we do build: file Path B first; only fall back to Path A if the upstream PR stalls.

## Related work

- `mcp/connect/backends/rest.ts:376` — `sendFlwInvite` (POST counterpart that creates invites).
- `commcare-connect/commcare_connect/opportunity/api/views/automation.py:78` — `InviteUsersView` (POST-only).
- `commcare-connect/commcare_connect/opportunity/models.py:982-997` — `UserInviteStatus` choices + `UserInvite` model shape.
