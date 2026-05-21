# Connect Interviews — ACE support

The Connect Interviews program is a Dimagi initiative separate from CRISPR-Connect. FLWs conduct structured interviews with participants by chatting with an OCS LLM bot embedded in CommCare Connect Messaging. Successful interview completion drives Connect payment via the standard Deliver Unit flow.

This directory holds the ACE-side design artifacts for automating the team's launch workflow.

## Source docs

Read-only references on Google Drive:

- **Technical Design** — gdocs `1jPMP0IUJO6T4Mmfjw9icsTjlOCUa9Z6JhZpNOK3-IF0`. Architecture, system flow, domain/app structure, cohort-ID scheme, and the backlog of future tech work (Dynamic Microservice, Dynamic Collections).
- **Domain Config Checklist** — gsheets `15yjXEMATSIoTLMZLu7-AMK1E4dptdngQxuZdX7rcxgI`. One-time per-project-space integration plumbing.
- **Opportunity Creation Checklist** — gdocs `1H7q27gW1qNa05-GUUUiA_v_YZOazGfLtjk_KxTBg1HM`. Per-cohort launch steps.

The team (Ali Flaming / Andrea King / Mansi Narang / Kriti Mittal / Zohaib Khan) is the source of truth for any discrepancy between this directory and the live program.

## Files

- **`checklist-schema.yaml`** — structured form of both prose checklists. The ACE skills below read this file; edit here, not in the skills.
- **`probe-report.md`** — *(planned, not yet written)* per-endpoint probe results: which HQ endpoints have JSON APIs vs. need Playwright drivers. Populated by step 2 of the V1 plan.

## Planned ACE skills (V1)

All three are slash commands under the `ace:` namespace, scoped narrowly to Connect Interviews (not part of the CRISPR-Connect phase pipeline):

| Command | Reads | Writes |
|---|---|---|
| `/ace:interview-domain-bootstrap <domain.yaml>` | — | All per-domain plumbing (Connections, Data Forwarding, UCRs, Repeaters, Inbound APIs, lookup tables, custom user data) |
| `/ace:interview-cohort-create <cohort.yaml>` | Domain state (sanity) | Per-cohort artifacts: linked-app copies, lookup-table rows, cohort_id user-field choice, conditional alert, Connect opportunity, payment unit |
| `/ace:interview-opp-verify <connect-opp-url>` | Everything | — |

V1 acceptance: bootstrap a fresh ACE-owned domain, run cohort-create on it, run opp-verify on the resulting opportunity, get all-green.

## Atom gap

`checklist-schema.yaml § atom_gaps` enumerates which `commcare_*` atoms need to be added. As of initial draft: ~15 new read atoms and ~15 new write atoms in `mcp/connect/backends/commcare.ts`. Connect-side atoms are already in place.

Each new HQ atom needs a probe first (`scripts/probe-*.ts` pattern) to decide REST vs. Playwright backend — see step 2 of the build plan.

## What's explicitly out of scope for V1

- Feature-flag toggling (HQ-admin operation, no API).
- Subscription activation (out-of-band, `accounts@dimagi.com`).
- Per-FLW cohort_id assignment after Learn completion — the schema documents the check, but no skill drives it in V1.
- The Dynamic Microservice / Dynamic Collections future work in the tech doc.
- Verifying against the team's real domains (`connect-interviews*`) — V1 round-trips against ACE-owned `ace-interviews-master` / `ace-interviews-test`. Team-domain verification requires access grants from the program owners.
