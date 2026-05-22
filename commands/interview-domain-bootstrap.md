---
description: One-time bootstrap of a Connect Interviews HQ project-space pair (master + downstream)
argument-hint: <domain.yaml>
allowed-tools: [Read, Write, Edit, Bash, AskUserQuestion]
---

# /ace:interview-domain-bootstrap

Stand up the per-project-space plumbing for the Connect Interviews program: HQ domains, linked-project-spaces relationship, Connections, Data Forwarding, Configurable Form Repeaters, Inbound APIs, lookup tables, plus the OCS Dynamic Router Bot.

Reads a single YAML spec and walks the per_domain section of `docs/connect-interviews/checklist-schema.yaml`. Surfaces atom-gap manual steps for the 4 deferred items (subscription provisioning, UCR expression creation, custom user data field, conditional alerts).

Usage:

```
/ace:interview-domain-bootstrap <path-to-domain.yaml>
```

See `skills/interview-domain-bootstrap/SKILL.md` for the input format, atoms used, and per-step process.
