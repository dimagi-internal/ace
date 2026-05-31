# Connect Opportunity — ACE-Test-001

> Synthetic Connect opportunity stub. Written by `connect-opp-setup` after the Opportunity is created in Connect. Used downstream by `llo-invite`, `llo-onboarding`, `llo-uat`, `llo-launch`, `ocs-agent-setup`, and `opp-closeout`. For the test fixture, all IDs and URLs are fake.

## Opportunity

- **Name:** Community Health Worker Training Pilot — TestLand
- **Opportunity ID:** `opp-fake-001`
- **Program ID:** `prog-fake-001`
- **Status:** draft
- **URL:** https://connect-staging.dimagi.org/opportunities/opp-fake-001
- **Archetype:** atomic-visit

## Delivery Units

- **Type:** per-beneficiary visit
- **Expected deliveries:** 500 beneficiaries x ~4 visits = ~2,000 total
- **Payment per verified delivery:** $10.00

## Verification Rules (from Evidence Model Layer A)

| Rule | Source | Condition |
|------|--------|-----------|
| GPS within target district | Visit form GPS field | GPS coordinates within Luvale, Mbunda, or Kaonde district boundaries |
| Required fields populated | All visit forms | Name, age, case ID, and all required clinical fields non-empty |
| Case lifecycle consistent | Case management | Registration creates case; follow-up updates existing case |
| Submission during working hours | Form metadata | Submission timestamp between 06:00–20:00 local time |

## Payment Units

- **Total budget:** $12,500
- **Payment unit:** verified home visit delivery
- **Estimated payment units:** 1,250 verified visits

## Notes

- Layer B/C evidence items are logged as soft flags (do not block payment)
- Test fixture only — do not use against production Connect
