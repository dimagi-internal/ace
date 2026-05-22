---
name: interview-domain-bootstrap
description: >
  One-time-per-project-space plumbing for Connect Interviews launches.
  Stands up the master + downstream HQ domains, the per-domain
  Connections / Data Forwarding / UCRs / Repeaters / Inbound APIs /
  Lookup tables, plus the OCS Dynamic Router Bot. Driven by a small
  domain.yaml spec. Manual fallback for the two not-yet-automated
  steps (conditional alert + custom user data field). Implements the
  per-domain section of docs/connect-interviews/checklist-schema.yaml.
disable-model-invocation: true
---

# Interview Domain Bootstrap

Spin up a fresh CommCare HQ project space pair (master + downstream) wired for the Connect Interviews program. One-shot, idempotent where possible, prints manual prompts where the atom matrix is incomplete.

## Slash command

```
/ace:interview-domain-bootstrap <domain.yaml>
```

## Input

Single YAML spec. Example:

```yaml
master_domain: ace-interviews-master       # HQ slug for the upstream
downstream_domain: ace-interviews-test     # HQ slug for the downstream
hq_owner: ace@dimagi-ai.com                # Web user for both domains

# OCS team that will host the Dynamic Router Bot. Defaults to env OCS_TEAM_SLUG.
ocs_team_slug: connect-ace

# Connect side
connect_pm_org: ai-demo-space              # PM-side Connect org slug
connect_program_name: "ACE Interviews Test"
connect_program_delivery_type: interview   # Slug from connect_list_delivery_types
country: Nigeria
currency: NGN

# UCR expressions to push from master to downstream (one of these is
# required for each Inbound API and Configurable Form Repeater)
ucr_expressions:
  - { name: "Register User OCS",         id: <int> }   # see notes
  - { name: "Trigger OCS Bot",           id: <int> }
  - { name: "Session Completion API",    id: <int> }
  - { name: "24 hr Expiry API",          id: <int> }
```

Most ids are resolved at runtime — operator only needs the names.

## Products

- `ACE/<domain>/bootstrap/state.yaml` — what got created (ids, urls)
- `ACE/<domain>/bootstrap/manual-steps.md` — list of manual steps remaining (conditional alerts + cohort_id user field)

## Process

The skill walks the per_domain section of `checklist-schema.yaml` top to bottom.

### 1. HQ domain creation

For each of `master_domain` and `downstream_domain`:

1. Check if it exists by attempting `commcare_list_apps({domain})`. If 401 with "Authorization Required" → domain doesn't exist or no access; create it.
2. `commcare_create_domain({hr_name: <slug>})`. Slug must be ≤25 chars.
3. **Manual step (prompt operator):** wait for accounts@ to provision Pro Edition tier on both domains. Skill blocks here until operator confirms `commcare_list_connections({domain})` returns 200 (not 404 — the DATA_FORWARDING privilege gate).

### 2. Linked-domain relationship

`commcare_link_domains({upstream_domain: master, downstream_domain: <ds>})`. Pro-gated.

### 3. Master-side content (one-time)

The team's tech-design says master holds:
- Master Learn + Deliver apps
- 4 UCR expressions (Register User OCS, Trigger OCS Bot, Session Completion API, 24 hr Expiry API)
- Lookup table `interview_schedule` (schema only — no cohort rows)
- Custom user data field definition (cohort_id)

**Manual step (prompt operator):**
> "Confirm the master domain has the 4 UCR expressions configured. UCR expression creation requires the HQ admin UI (no automation atom yet — see docs/connect-interviews/probe-report.md atom_gaps)."

If the master is already fully configured (e.g. it's a clone of the team's `connect-interviews` master), skip; otherwise the operator does this by hand.

For the lookup table — automated:

```
commcare_create_lookup_table({
  domain: master_domain,
  tag: "interview_schedule",
  fields: [
    { field_name: "cohort_id" },
    { field_name: "previous_interview" },
    { field_name: "next_interview" },
    { field_name: "frequency_days" },
  ],
})
```

(Cohort rows are added per-cohort via /ace:interview-cohort-create.)

### 4. Downstream-side per-domain plumbing

#### 4a. Subscription

Confirmed in step 1 (operator-attested).

#### 4b. Connections

Two Connections per downstream domain:

```
commcare_create_connection({
  domain: downstream_domain,
  name: "Connect Interviews",
  url: "https://connect.dimagi.com/api/receiver/",
  auth_type: "basic",
  username: <connect-credential>,
  plaintext_password: <connect-credential>,
})

commcare_create_connection({
  domain: downstream_domain,
  name: "OCS Interviews Bot",
  url: "<OCS instance URL>",
  auth_type: "api_key",
  plaintext_custom_headers: '{"Authorization": "Token <ocs-api-token>"}',
})
```

Credentials come from `domain.yaml` (encrypted with op:// references — never inline).

#### 4c. Data forwarding (form forwarder)

```
commcare_create_repeater({
  domain: downstream_domain,
  repeater_type: "FormRepeater",
  connection_settings_id: <connect-conn-id>,
  name: "Connect Interviews",
  request_method: "POST",
  format: "form_json",
})
```

#### 4d. Configurable Form Repeaters

These reference the UCR expressions (pushed via linked_domain before this step):

```
commcare_create_repeater({
  domain: downstream_domain,
  repeater_type: "FormExpressionRepeater",
  connection_settings_id: <ocs-conn-id>,
  name: "OCS User Registration",
  configured_filter: { type: "named", name: "Register User OCS" },
  configured_expression: { ... },   # named UCR ref
})

commcare_create_repeater({
  domain: downstream_domain,
  repeater_type: "FormExpressionRepeater",
  connection_settings_id: <ocs-conn-id>,
  name: "Trigger Bot",
  configured_filter: { type: "named", name: "Trigger OCS Bot" },
  configured_expression: { ... },
})
```

#### 4e. Inbound APIs

Two:

```
commcare_create_inbound_api({
  domain: downstream_domain,
  name: "Session Completion API",
  filter_expression_id: <session-completion-ucr-id>,
  backend: "json",
})

commcare_create_inbound_api({
  domain: downstream_domain,
  name: "24 hr Expiry API",
  filter_expression_id: <24hr-expiry-ucr-id>,
  backend: "json",
})
```

#### 4f. Lookup table push

If the downstream's `interview_schedule` table doesn't exist (per `commcare_get_lookup_table`), create it. Cohort rows are added per-cohort.

#### 4g. Custom user data field

**Manual step (prompt operator):**
> "Visit /a/<downstream_domain>/users/commcare/user_data/ and add a custom field 'cohort_id' with empty choices. (User Fields create atom not yet built — hidden-JSON form pattern; see verification doc.)"

### 5. OCS-side Dynamic Router Bot

Clone or create a per-domain bot from the ACE Interviews Stub Template:

```
ocs_clone_chatbot({
  template_id: <OCS_INTERVIEWS_TEMPLATE_ID env, default 12213>,
  new_name: "Connect Interviews — <downstream_domain>",
})
```

This carries forward the StaticRouterNode + LLM + custom action wiring from the V1 stub template.

### 6. Conditional alert (per-domain initial)

**Manual step (prompt operator):**
> "Conditional alerts are created per-cohort. For V1, the per-cohort skill prompts you to create each one in the HQ UI at /a/<downstream_domain>/messaging/conditional/add/. (Conditional alert create atom not yet built — the create flow is a 3-form combined POST with dynamic fields; deferred to V1.5.)"

## Idempotency

Steps 1, 2, 3, 4b-f, 5 are idempotent: skill checks existence before creating, skips on conflict.

## Errors and recovery

- 401 on a Pro-gated endpoint → "subscription not yet provisioned; ask accounts@".
- 404 on a domain → "domain doesn't exist; check the slug or run step 1".
- UCR expression FK not found → "push UCRs from master first; see manual step in §3".

## MCP Tools Used

- `commcare_create_domain`, `commcare_link_domains`, `commcare_create_lookup_table`,
  `commcare_create_connection`, `commcare_create_repeater`,
  `commcare_create_inbound_api`, `commcare_list_apps`
- `ocs_clone_chatbot` (or `ocs_create_chatbot` + structural atoms for from-scratch)
- `connect_create_program` (if Connect program doesn't yet exist for this domain pair)

## Manual fallbacks

These are atom gaps deferred to V1.5:
- Subscription provisioning (out-of-band — accounts@)
- UCR expression creation (manual via HQ admin UI)
- Custom user data field creation (manual — hidden-JSON form)
- Conditional alert creation (manual — 3-form combined POST)

The skill produces `manual-steps.md` listing exactly what the operator still needs to do.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-21 | Initial V1 — atom matrix complete except 4 deferred items | ACE team |
