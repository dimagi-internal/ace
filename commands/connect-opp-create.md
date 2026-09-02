---
description: Create or clone a Connect opportunity from a spec YAML — standalone, no ACE run
argument-hint: <spec.yaml> | --clone <opp-url-or-uuid> [--out <spec.yaml>] [--dry-run]
allowed-tools: [Read, Write, Edit, Bash, AskUserQuestion]
---

# /ace:connect-opp-create

Stand up one fully-configured Connect opportunity from a single spec file:
create → payment units → activate → invite, plus the read-backs that catch a
silently-wrong config. No PDD, no `run_state.yaml`, no Drive, no dependency on
any other ACE phase.

This is Phase 4's (`connect-opp-setup`) Connect-side atom sequence with the
run scaffolding removed. Use Phase 4 when you want a PDD-driven opportunity
inside a full `/ace:run` with evals and Drive artifacts; use this when you
already have the HQ app ids and the payment plan, or when you want another
opportunity shaped like an existing one.

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
(ace#573) and reusing its Learn app silently discards the posting `passing_score`
(ace#1350), so the clone path always mints fresh app copies via
`commcare_linked_app_copy`. Creating is a second, explicit invocation.

Start from `templates/connect-opp-spec.yaml`. The spec is validated by
`lib/connect-opp-spec.ts` before any network call.

See `skills/connect-opp-create/SKILL.md` for the full input format and
per-step process.
