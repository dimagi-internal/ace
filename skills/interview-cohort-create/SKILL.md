---
name: interview-cohort-create
description: >
  Per-cohort launch automation for Connect Interviews. Takes a cohort
  YAML spec; produces linked-app copies, lookup-table rows, the Connect
  opportunity + payment unit, and per-cohort OCS bot routing. Implements
  the per_cohort section of docs/connect-interviews/checklist-schema.yaml.
disable-model-invocation: true
---

# Interview Cohort Create

Launch a single cohort for the Connect Interviews program. Idempotent where possible. Designed to run after `/ace:interview-domain-bootstrap` has plumbed the domain.

## Slash command

```
/ace:interview-cohort-create <cohort.yaml>
```

## Input

Single YAML spec mirroring the Cohort tracker columns (per opp-checklist steps 2.3 + 4.3):

```yaml
# Identity
cohort_id: "08TRS"                   # e.g. "08TRS", "09TRE", "07T1B"
llo_org_slug: "ai-demo-space"        # PM org (V1 is ACE-owned)
hq_downstream_domain: "ace-interviews-test"
hq_master_domain: "ace-interviews-master"

# App references (master-side; cohort gets linked copies)
master_learn_app_id: "<couch id>"
master_deliver_app_id: "<couch id>"

# Connect opp
connect_program_id: "<uuid from interview-domain-bootstrap>"
connect_pm_org: "ai-demo-space"
opp_short_description: "Connect Interviews : 08TRS"
opp_long_description: "..."          # Free text; checklist step 3.6

# Schedule
schedule:
  - { previous: "",       next: "te001", frequency_days: 2 }
  - { previous: "te001",  next: "te002", frequency_days: 2 }
  - { previous: "te002",  next: "te003", frequency_days: 9999 }   # last entry's frequency_days=9999

# Payment + budget
payment_amount_ngn: 2.0              # per cohort tracker
max_users: 40                        # rounded up per checklist note
start_date: "2026-05-21"             # opp.start_date — NOT updatable later
end_date: "2026-06-30"

# OCS-side
ocs_bot_id: 12213                    # The per-domain Dynamic Router Bot from bootstrap
```

## Products

- `ACE/<opp-name>/cohort-create.yaml` — what got created (opp_id, payment_unit_id, app ids, etc.)
- `ACE/<opp-name>/manual-steps.md` — list of manual steps (per-cohort conditional alert)

## Process

Walks per_cohort section of `checklist-schema.yaml`.

### Step 1: Linked-app copies

For each of Learn + Deliver, pull a fresh linked copy on the downstream domain.

**Atom gap**: a commcare-linked-app-copy atom (*not yet built*) is documented in checklist-schema.yaml's atom_gaps. The DomainLinkRMIView supports this (via the `create_app_copy` method on apps) but the wire shape needs probing.

**V1 manual fallback**: prompt operator to do the linked-app pull via HQ UI at /a/<downstream>/apps/, then enter the new app ids back into the cohort.yaml.

Once the atom ships, the call shape will be:
```
commcare-linked-app-copy({         # placeholder name — not yet built
  upstream_domain: hq_master_domain,
  downstream_domain: hq_downstream_domain,
  master_learn_app_id: <id>,
})
# returns new app_id
```

Rename copies to include cohort_id (e.g. "Connect Interviews (Learn) 08TRS"). Atom gap.

Release a build for each:
```
commcare_make_build({domain: hq_downstream_domain, app_id: <new id>})
commcare_release_build({domain: hq_downstream_domain, app_id: <new id>, build_id: <build_id>})
```

### Step 2: Lookup table rows

Append the cohort's schedule:

```
commcare_lookup_table_append_rows({
  domain: hq_downstream_domain,
  table_id_or_tag: "interview_schedule",
  rows: schedule.map(s => ({
    cohort_id: cohort_id,
    previous_interview: s.previous,
    next_interview: s.next,
    frequency_days: String(s.frequency_days),
  })),
})
```

### Step 3: User-field choice (cohort_id)

**Manual step (prompt operator):**
> "Visit /a/<downstream>/users/commcare/user_data/ and add '<cohort_id>' as a choice for the cohort_id user field. (Atom not yet built.)"

### Step 4: Connect opportunity

```
connect_create_opportunity({
  organization_slug: connect_pm_org,
  program_id: connect_program_id,
  name: cohort_id,                          # checklist step 3.2: just the cohort_id
  short_description: opp_short_description,
  long_description: opp_long_description,
  country: "Nigeria",
  currency: "NGN",
  learn_app: { domain: hq_downstream_domain, cc_app_id: <learn-new-id>, passing_score: 4 },
  deliver_app: { domain: hq_downstream_domain, cc_app_id: <deliver-new-id> },
  hq_server: "https://www.commcarehq.org/",
  api_key: <ACE_HQ_API_KEY>,
  start_date: start_date,                   # cannot be updated later
  end_date: end_date,
  max_users: max_users,
})
```

Capture the new opp_id.

### Step 5: Payment unit

```
connect_create_payment_unit({
  organization_slug: connect_pm_org,
  opportunity_id: <opp_id>,
  name: `${cohort_id} interview completed successfully`,
  amount: payment_amount_ngn,
  max_total: schedule.length,    # one payment per interview in the schedule
  max_daily: 1,                  # checklist step 4.3
})
```

### Step 6: Opp verification flags

```
connect_set_verification_flags({
  organization_slug: connect_pm_org,
  opportunity_id: <opp_id>,
  flags: { gps: false },         # checklist step 6: GPS off
})
```

### Step 7: Delivery type + active

```
connect_update_opportunity({
  organization_slug: connect_pm_org,
  opportunity_id: <opp_id>,
  delivery_type: "interview",
  is_test: false,
})

connect_activate_opportunity({
  organization_slug: connect_pm_org,
  opportunity_id: <opp_id>,
})
```

### Step 8: Conditional alert

**Manual step (prompt operator):**
> "Visit /a/<downstream>/messaging/conditional/add/ and create a Conditional Alert:
>   - Name: '<cohort_id> Payment Conditional Alert'
>   - Case type: commcare-user
>   - Filter: cohort_id = '<cohort_id>' AND session_completion = 'session completed'
>   - Action: submit Connect Survey form with delivery unit configured for payment trigger
> (Atom not yet built — 3-form combined POST.)"

### Step 9: OCS interview-node routing

Per cohort, the Dynamic Router Bot's StaticRouterNode `keywords` need to include this cohort's interview_ids. Modify the existing node's params:

```
# Get current pipeline
pipeline = ocs_get_chatbot_pipeline_id({experiment_id: ocs_bot_id})
# (read the router node's current keywords, add this cohort's interview_ids, save)
```

**Atom gap for V1**: an ocs-update-pipeline-node atom (*not yet built*) — only `ocs_add_pipeline_node` exists. For V1, the StaticRouterNode template already has `keywords: ["default"]`; cohort-specific routing is documented as manual until the update atom ships.

## Idempotency

Steps that detect existing state (opp by name, payment unit by name, lookup row by exact match) skip re-create. Operator can re-run the skill if a single step failed.

## MCP Tools Used

- `commcare_lookup_table_append_rows`, `commcare_release_build`
- `connect_create_opportunity`, `connect_create_payment_unit`, `connect_set_verification_flags`,
  `connect_update_opportunity`, `connect_activate_opportunity`, `connect_list_delivery_types`
- `ocs_get_chatbot_pipeline_id`

## Manual fallbacks

V1 manual steps surface in `manual-steps.md`:
- Linked-app copy + rename (atom gap)
- cohort_id user-field choice add (atom gap — hidden-JSON form)
- Conditional alert create (atom gap — 3-form combined POST)
- OCS router-node keywords update (atom gap)

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-21 | Initial V1 — atom matrix complete except 4 deferred items | ACE team |
