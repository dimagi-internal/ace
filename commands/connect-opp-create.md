---
description: Create or clone a Connect opportunity from a spec YAML — standalone, no ACE run
argument-hint: <spec.yaml> | --clone <opp-url-or-uuid> [--out <spec.yaml>] [--dry-run]
allowed-tools: [Read, Write, Edit, Bash, AskUserQuestion, mcp__plugin_ace_ace-connect__connect_list_programs, mcp__plugin_ace_ace-connect__connect_get_program, mcp__plugin_ace_ace-connect__connect_update_program, mcp__plugin_ace_ace-connect__connect_list_opportunities, mcp__plugin_ace_ace-connect__connect_get_opportunity, mcp__plugin_ace_ace-connect__connect_create_opportunity, mcp__plugin_ace_ace-connect__connect_activate_opportunity, mcp__plugin_ace_ace-connect__connect_send_llo_invite, mcp__plugin_ace_ace-connect__connect_accept_program_application, mcp__plugin_ace_ace-connect__connect_create_payment_units, mcp__plugin_ace_ace-connect__connect_list_payment_units, mcp__plugin_ace_ace-connect__connect_set_verification_flags, mcp__plugin_ace_ace-connect__connect_get_learn_passing_score, mcp__plugin_ace_ace-connect__connect_set_learn_passing_score, mcp__plugin_ace_ace-connect__connect_send_flw_invite, mcp__plugin_ace_ace-connect__connect_list_flw_invites, mcp__plugin_ace_ace-connect__commcare_linked_app_copy, mcp__plugin_ace_ace-connect__commcare_link_domains, mcp__plugin_ace_ace-connect__commcare_make_build, mcp__plugin_ace_ace-connect__commcare_release_build, mcp__plugin_ace_ace-connect__commcare_list_apps, mcp__plugin_ace_ace-connect__commcare_download_ccz]
---

# /ace:connect-opp-create

Stand up one fully-configured Connect opportunity from a single spec file:
create → payment units → activate → invite, plus the read-backs that catch a
silently-wrong config. No PDD, no `run_state.yaml`, no Drive, no dependency on
any other ACE phase.

This is Phase 4's (`connect-setup`) Connect-side sequence with the run
scaffolding removed. Use Phase 4 when you want a PDD-driven opportunity inside
a full `/ace:run` with evals and Drive artifacts; use this when you already
have the HQ app ids and the payment plan, or when you want another opportunity
shaped like an existing one.

Usage:

```
/ace:connect-opp-create <spec.yaml>                       # create
/ace:connect-opp-create <spec.yaml> --dry-run             # print the payloads, call nothing
/ace:connect-opp-create --clone <opp-url-or-uuid>         # hydrate a spec from a live opp, then STOP
/ace:connect-opp-create --clone <uuid> --out my-spec.yaml
```

`--clone` never creates anything. It reads the source opportunity and writes a
spec with the mutable fields filled in and the app ids deliberately blank —
reusing a source opportunity's Deliver app makes payment units impossible
(ace#573) and reusing its Learn app silently discards the posted
`passing_score` (ace#1350), so the clone path always mints fresh app copies via
`commcare_linked_app_copy`. Creating is a second, explicit invocation.

Start from `templates/connect-opp-spec.yaml`. **Nothing is created until the
gate exits 0** — exit 1 (blocking issues) and exit 2 (unreadable/unparseable
spec) both mean halt, not proceed:

```
npx tsx "${CLAUDE_PLUGIN_ROOT:-.}/scripts/validate-connect-opp-spec.ts" "<spec.yaml>"
```

Run it again with `--phase pre-payment-units` once the create response is in
hand: `required_deliver_units` can only be a warning before Connect mints the
deliver-unit ids, and must be blocking after.

See `skills/connect-opp-create/SKILL.md` for the full per-step process.
