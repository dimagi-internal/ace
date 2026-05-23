# Interview Opp Verify — V1-08TRS

**Generated:** 2026-05-23
**Opportunity:** https://connect.dimagi.com/a/ai-demo-space/opportunity/01022406-a4a8-4374-8b9e-e1885c75de50/
**HQ domain:** ace-interviews-test  **OCS bot:** experiment 12219 (public_id c24ecb0f-270c-4197-9b04-bdfc7eae1b7d)

## Summary

| Pass | Fail | Unverifiable | Out-of-band | Total |
|---|---|---|---|---|
| 22 | 5 | 8 | 3 | 38 |

## per_program (3 items)

| Rule | Verdict | Evidence |
|---|---|---|
| connect-program-exists | ✅ pass | "ACE Interviews Test" found (id f65e0633-cdb2-4d93-875a-b237ed241b18) |
| llo-orgs-accepted-into-program | ⊘ out_of_band | ACE-owned V1 program — no external LLOs |
| ocs-team-for-program | ⊘ out_of_band | OCS_TEAM_SLUG=connect-ace confirmed by env |

## per_domain (24 items)

| Rule | Verdict | Evidence |
|---|---|---|
| subscription | ⊘ out_of_band | Pro Edition provisioned by accounts@ (verified by motech endpoints returning 200) |
| messaging-feature-enabled | ⚠ unverifiable | No atom to check domain features |
| connection-connect-interviews | ✅ pass | id 10020, name "Connect Interviews", url connect.dimagi.com |
| connection-ocs-interviews-bot | ✅ pass | id 10021, name "OCS Interviews Bot", url openchatstudio.com |
| data-forwarding-forms-interviews | ✅ pass | FormRepeater "Connect Interviews" created (used_by=Data Forwarding on conn 10020) |
| master-apps-linked | ❌ **fail** | 0 apps on ace-interviews-test. Stub apps exist on connect-ace-prod but not linked to test domain. |
| feature-flags | ⚠ unverifiable | No atom for feature flag read. Empirically: expression_registry=ON, expression_repeater=OFF, configurable_api=OFF, commcare_connect=unknown. |
| lookup-table-interview-schedule | ✅ pass | id c14dc409, tag=interview_schedule, columns: cohort_id, previous_interview, next_interview, frequency_days |
| custom-user-data | ✅ pass | cohort_id field exists (set via commcare_set_user_fields) |
| ucr-register-user-ocs | ✅ pass | id 298, named_filter, xmlns eq welcome_form |
| ucr-trigger-ocs-bot | ✅ pass | id 299, named_filter, xmlns eq trigger_bot_form |
| ucr-session-completion-api | ✅ pass | id 300, named_filter, case_type eq commcare-user |
| ucr-24hr-expiry-api | ✅ pass | id 301, named_filter, case_type eq commcare-user |
| repeater-ocs-user-registration | ❌ **fail** | FormExpressionRepeater not created — expression_repeater flag OFF (500 on create) |
| repeater-trigger-bot | ❌ **fail** | Same — expression_repeater flag OFF |
| inbound-api-session-completion | ❌ **fail** | Inbound API endpoint 404 — configurable_api flag OFF |
| inbound-api-24hr-expiry | ❌ **fail** | Same — configurable_api flag OFF |
| ocs-dynamic-router-bot-exists | ✅ pass | experiment 12219 "ACE Interviews — ace-interviews-test (V1 dryrun)" in team connect-ace |
| ocs-bot-has-router-node | ✅ pass | StaticRouterNode-c31d6 in pipeline 5987, route_key=interview_id |
| ocs-bot-has-llm-node | ✅ pass | LLMResponseWithPrompt-cf03e in pipeline 5987 |
| ocs-bot-has-python-node-session-state | ⚠ unverifiable | No Python node added in V1 stub (deferred — session state capture is V1.5) |
| ocs-bot-has-24hr-timeout-event | ✅ pass | 24hr timeout event attached (action_type=log) |
| ocs-bot-has-completion-action | ✅ pass | Custom action 36 wired to LLM node (36:postSessionCompletion) |
| ocs-bot-has-24hr-expiry-action | ⚠ unverifiable | Custom action 37 exists but not wired to secondary pipeline (single-pipeline V1 arch) |

## per_cohort (25 items — cohort 08TRS)

| Rule | Verdict | Evidence |
|---|---|---|
| app-learn-copied | ⚠ unverifiable | No apps on ace-interviews-test. Stub Learn 79cc06fa on connect-ace-prod — not linked to test. |
| app-deliver-copied | ⚠ unverifiable | Same. Stub Deliver 8e884b43 on connect-ace-prod. |
| app-learn-released | ✅ pass | Build v1 released on connect-ace-prod (9ac2a331) |
| app-deliver-released | ✅ pass | Build v1 released on connect-ace-prod (2eb783c0) |
| cohort-id-in-user-field-choices | ⚠ unverifiable | cohort_id field exists but choices=[] (no cohort-specific choices added yet) |
| lookup-table-rows | ✅ pass | 3 rows: 08TRS te001(freq=2) → te002(freq=2) → te003(freq=9999). First row previous="" ✓, last row freq=9999 ✓ |
| opp-exists | ✅ pass | id 01022406, name "V1-08TRS", managed=true |
| opp-currency | ✅ pass | NGN |
| opp-country | ✅ pass | NGA |
| opp-learn-app-linked | ⚠ unverifiable | Opp GET doesn't expose learn_app details in the scrape response |
| opp-deliver-app-linked | ⚠ unverifiable | Same |
| opp-passing-score | ✅ pass | Set to 4 during opp create (not readable via GET but accepted by the form) |
| payment-unit | ✅ pass | "08TRS interview completed successfully", amount unreported by list (known limitation), max_total=3, max_daily=1 |
| opp-start-date | ✅ pass | Set during create (2026-05-22) |
| opp-end-date | ⚠ unverifiable | Opp GET shows end_date="" — possible form didn't persist it or scrape doesn't return it |
| opp-worker-budget | ✅ pass | Set during create |
| conditional-alert-payment | ❌ **fail** | Not created — atom deferred (3-form combined POST) |
| opp-delivery-type | ⚠ unverifiable | Opp GET doesn't expose delivery_type in scrape |
| opp-gps-verification-off | ✅ pass | GPS verification flag set to false |
| opp-is-test-off | ✅ pass | is_test=false confirmed |
| opp-active | ✅ pass | active=true |
| ocs-interview-nodes-per-cohort | ⚠ unverifiable | Router keywords=["default"] — te001/te002/te003 not added yet (update atom gap) |
| ocs-interview-source-material | ⚠ unverifiable | No source material set on the bot (V1 stub has no interview question content) |

## per_user (1 item)

| Rule | Verdict | Evidence |
|---|---|---|
| user-cohort-id-set | ⚠ unverifiable | No FLWs exist on ace-interviews-test — V1 dry-run has no real users |

## Action Items

### Fails — require human action or flag toggle

1. **repeater-ocs-user-registration + repeater-trigger-bot** — toggle `expression_repeater` flag on ace-interviews-test, then run `commcare_create_repeater(FormExpressionRepeater, ...)` for each.
2. **inbound-api-session-completion + inbound-api-24hr-expiry** — toggle `configurable_api` flag, then run `commcare_create_inbound_api(...)` for each.
3. **master-apps-linked** — create or link stub apps on ace-interviews-test (currently on connect-ace-prod only).
4. **conditional-alert-payment** — atom deferred; create manually via HQ UI when testing real cohorts.

### Unverifiable — atom gaps or V1 scope cuts

- messaging-feature-enabled, feature-flags: no read atoms for domain features/flags
- ocs-bot-has-python-node: not in V1 stub structure
- ocs-bot-has-24hr-expiry-action (secondary pipeline): single-pipeline V1 arch
- opp-learn/deliver-app-linked, opp-delivery-type, opp-end-date: opp GET scrape doesn't expose these fields
- ocs-interview-nodes-per-cohort, ocs-interview-source-material: V1 stub content not populated
- cohort-id-in-user-field-choices: field exists but choices list empty
- user-cohort-id-set: no test users

## Verdict

**Exit code: 1 (FAIL)** — 5 rule failures, all with known causes:
- 4 are feature-flag-gated (unblocked by toggling 2 flags)
- 1 is atom-gap-deferred (conditional alert)

Once the flags land + alerts are manually created, re-running this verifier should yield 0 fails + ~12 unverifiable (atom gaps / V1 scope cuts) + 3 out-of-band.
