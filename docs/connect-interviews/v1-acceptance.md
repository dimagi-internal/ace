# Connect Interviews — V1 Acceptance Procedure

V1's acceptance test is a single round-trip on ACE-owned infrastructure: bootstrap → cohort-create → opp-verify on `ace-interviews-master` / `ace-interviews-test` / `ai-demo-space`. This doc captures what's runnable today vs. what's blocked, and the exact steps for the final acceptance once accounts@ provisions Pro Edition.

## What's runnable today (Free tier)

- ✅ `commcare_create_domain` — verified end-to-end (both domains live)
- ✅ `connect_create_program` — verified (program `ace-interviews-test` live in `ai-demo-space`)
- ✅ All 5 OCS authoring atoms — verified (stub template at experiment 12213)
- ✅ Lookup table get/create/append-rows + user list/get/update_field + get_case — verified against `connect-ace-prod`

## What's blocked on accounts@ Pro Edition provisioning

These atoms work code-wise but 401/404 on the new ACE-owned domains until Pro lands:

- `commcare_link_domains` — needs LITE_RELEASE_MANAGEMENT
- `commcare_lookup_table_*` against ace-interviews-master/test — needs LOOKUP_TABLES (Standard+) and access from API key on those domains
- `commcare_create_connection`, `commcare_create_repeater`, `commcare_create_inbound_api` — all need DATA_FORWARDING (Pro)

**Manual unblock:** wait on accounts@dimagi.com reply to the request mailed 2026-05-21 (message id `19e4c968a52bde49`).

## V1 acceptance — Step-by-step (run once Pro is provisioned)

### Pre-flight (5 min)

```
# Confirm Pro is active on both domains
npx tsx scripts/probe-commcare-link-domains.ts        # dry-run; expect 200 not 401
```

### Step 1 — Domain bootstrap (15 min)

```yaml
# domain.yaml
master_domain: ace-interviews-master
downstream_domain: ace-interviews-test
hq_owner: ace@dimagi-ai.com
ocs_team_slug: connect-ace
connect_pm_org: ai-demo-space
connect_program_name: "ACE Interviews Test"   # already exists
connect_program_delivery_type: interview
country: Nigeria
currency: NGN
ucr_expressions: []     # V1: skip the UCR push — manual setup
```

```
/ace:interview-domain-bootstrap domain.yaml
```

Expected output:
- ✅ link_domains: master → downstream link created
- ✅ create_lookup_table: `interview_schedule` schema on master
- ✅ create_connection × 2: Connect Interviews + OCS Interviews Bot on downstream
- ⚠ manual: UCR expressions (push from master via HQ admin UI)
- ⚠ manual: custom user data field (cohort_id slug)
- ✅ create_repeater × 3: Connect Interviews forwarder + 2 Configurable Form Repeaters (once UCRs are pushed)
- ✅ create_inbound_api × 2: Session Completion + 24hr Expiry
- ✅ clone_chatbot: per-domain Dynamic Router Bot in OCS

### Step 2 — Cohort create (10 min)

```yaml
# cohort-08TRS.yaml
cohort_id: "08TRS"
llo_org_slug: "ai-demo-space"
hq_downstream_domain: "ace-interviews-test"
hq_master_domain: "ace-interviews-master"
master_learn_app_id: "<from bootstrap output>"
master_deliver_app_id: "<from bootstrap output>"
connect_program_id: "f65e0633-cdb2-4d93-875a-b237ed241b18"
connect_pm_org: "ai-demo-space"
opp_short_description: "ACE Interviews V1 — cohort 08TRS"
opp_long_description: "End-to-end acceptance test."
schedule:
  - { previous: "",      next: "te001", frequency_days: 2 }
  - { previous: "te001", next: "te002", frequency_days: 2 }
  - { previous: "te002", next: "te003", frequency_days: 9999 }
payment_amount_ngn: 2.0
max_users: 5
start_date: "2026-05-22"
end_date: "2026-06-30"
ocs_bot_id: <from bootstrap output>
```

```
/ace:interview-cohort-create cohort-08TRS.yaml
```

Expected output:
- ⚠ manual: linked-app copy (Learn + Deliver) for cohort_id
- ✅ append_lookup_table_rows: 3 rows
- ⚠ manual: cohort_id user-field choice
- ✅ create_opportunity + create_payment_unit + set_verification_flags + update_opportunity + activate_opportunity
- ⚠ manual: conditional alert "08TRS Payment Conditional Alert"
- ⚠ manual: OCS router-keywords update (add te001/te002/te003)

### Step 3 — Verify (5 min)

```
/ace:interview-opp-verify https://connect.dimagi.com/a/ai-demo-space/opportunity/<new_opp_id>/
```

Expected verdict:
- 38+ rules pass (the automated portions)
- 5-7 rules ⚠ unverifiable (gap-tagged atoms — list_form_repeaters, list_user_fields, etc.)
- 4-5 rules ⊘ out_of_band (subscription, OCS team identity, etc.)
- 0 rules fail

### Step 4 — Team spot-check (async)

Email Ali / Andrea / Mansi the verdict report + the opp URL. Ask:
1. Does the cohort structure match what they'd build manually?
2. Are the manual-step gaps in the right places, or are we missing automation for something they consider essential?
3. Any gotchas the schema doesn't capture?

## Definition of done (V1)

- [ ] Domain bootstrap runs clean (no surprises beyond documented manual steps)
- [ ] Cohort create runs clean
- [ ] Verifier reports 0 fails + reasonable unverifiable count
- [ ] Team spot-check returns ≥ 80% "looks right" with concrete feedback on any deltas

## Known V1 gaps (deferred to V1.5)

Per `checklist-schema.yaml § atom_gaps`:

- HQ atoms: bulk_user_update, bulk_case_update, get_domain_features, get_feature_flags, list_app_releases, invite_web_user
- List-side motech atoms: list_form_repeaters, list_form_forwarders
- Hidden-JSON form atoms: list_user_fields, create_user_field, user_field_add_choice
- CSV/XLS upload atoms: list_conditional_alerts, create_conditional_alert (download is XLS, not CSV — probe report was wrong)
- UCR atoms: list_ucr_expressions
- Linked-app atoms: linked_app_copy, linked_app_push (the latter has an RMI atom path; just unwired)
- OCS pipeline-edit atom: update_pipeline_node (for cohort router keywords)

Each gap is documented in `checklist-schema.yaml` and surfaces as a manual prompt in the skills.

## Manual workarounds for V1

While the gaps exist, the V1 skills surface explicit prompts for the operator:
1. accounts@ subscription provisioning (one-time per domain pair)
2. Push UCR expressions from master to downstream (one-time per domain pair, via HQ admin UI Linked Domain page)
3. Create custom user data field `cohort_id` on downstream (one-time per domain)
4. Linked-app copy + rename per cohort (per cohort, via HQ admin UI)
5. Add cohort_id user-field choice per cohort (per cohort)
6. Create per-cohort conditional alert (per cohort, via HQ Messaging UI)
7. Update OCS router-node keywords per cohort (per cohort, via OCS pipeline editor)

Steps 4-7 are per-cohort — that's the workflow friction V1.5's atom additions will eliminate.

## What V1 ships

A complete framework that:
- Defines (in YAML) what a properly-configured Connect Interviews cohort looks like
- Automates ~70-80% of the bootstrap + cohort-create per the team's prose checklists
- Verifies any opp against that definition
- Documents the remaining 20-30% as explicit manual prompts (no silent gaps)

The team can use V1 today as soon as Pro provisions. The atom-gap items can land as small follow-up PRs once V1 is exercised in anger.
