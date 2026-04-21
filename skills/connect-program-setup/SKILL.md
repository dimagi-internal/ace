---
name: connect-program-setup
description: >
  Create or configure a Program in Connect for the CRISPR-Connect opportunity.
  Checks if an existing program fits before creating a new one.
---

# Connect Program Setup

Create or select a Connect program for this opportunity.

## Process

1. **Read the PDD** from `ACE/<opp-name>/pdd.md`, including the
   `archetype:` field. Program shape is mostly archetype-agnostic, but
   program NAME and DESCRIPTION should signal archetype so future opps
   under the same program can be grouped coherently. See
   `## Archetypes` below.

2. **Check for existing programs** that match this opportunity's domain/scope.
   Use connect-labs MCP `list_solicitations` or similar to browse existing programs.
   Prefer archetype-matched programs when reusing — running an FGD opp
   under a program whose other opps are all atomic-visit creates a
   mixed-method reporting headache downstream.

3. **Decide: reuse or create**
   - If an existing program fits AND shares the archetype, note the program ID
   - If an existing program matches the domain but not the archetype,
     flag the mismatch in the gate brief / program notes; default to
     creating a new one unless the admin explicitly opts in
   - If no match: create a new program with appropriate name,
     description, and config — name should signal archetype (see below)

4. **Write program details** to `ACE/<opp-name>/connect-setup/program.md`:
   - Program ID
   - Program name
   - Archetype declared at program creation (if new)
   - Whether reused or newly created; note any archetype mismatch if reused
   - Configuration details

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Connect (connect-labs): existing solicitation tools for discovery
- Connect: `create_program` — **NOT YET BUILT** (CCC-301)

## Current Workaround
1. Read the PDD and determine program requirements
2. Ask the user: "Does an existing Connect program fit this opportunity, or should we create a new one?"
3. If new: provide the user with the recommended program name and configuration
4. Ask the user to create it in the Connect UI and provide the Program ID
5. Record the Program ID in the opportunity folder

## Mode Behavior
- **Auto:** Create program (or guide manual creation), proceed
- **Review:** Present program choice for approval

## Dry-Run Behavior
When `--dry-run` is active:
- Write the program configuration (name, description, settings) to `comms-log/dry-run-connect-program-setup.md`
- Do not create or modify programs in Connect
- State tracks as `dry-run-success`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
