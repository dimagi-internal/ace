---
name: connect-opp-setup
description: >
  Create and configure an Opportunity in Connect — including verification rules,
  delivery units, payment units, and all other configuration needed for the opp.
---

# Connect Opportunity Setup

Create and fully configure a Connect opportunity.

## Process

1. **Read inputs from GDrive:**
   - IDD: `ACE/<opp-name>/idd.md`
   - Program details: `ACE/<opp-name>/connect-setup/program.md`
   - App deployment details: `ACE/<opp-name>/deployment-summary.md`

2. **Create the Opportunity** in Connect:
   - Name from IDD
   - Link to Program from previous step
   - Delivery type: "Experiment" (generic type) or appropriate type
   - Start/end dates from IDD timeline
   - Link to CCHQ apps

3. **Configure verification rules:**
   - Based on IDD success metrics and Deliver app structure
   - Map verification criteria to form submissions / case properties

4. **Configure delivery units:**
   - Based on IDD intervention design (visits, services, etc.)
   - Set expected quantities and timelines

5. **Configure payment units:**
   - Based on delivery units and budget from IDD
   - Set payment rates and schedules

6. **Write config summary** to `ACE/<opp-name>/connect-setup/opportunity.md`:
   - Opportunity ID and URL
   - All configuration details
   - Verification rules
   - Delivery and payment unit setup

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Connect: `create_opportunity`, `set_verification_rules`, `set_delivery_units`, `set_payment_units` — **NOT YET BUILT** (CCC-301)

## Current Workaround
1. Read IDD and determine all configuration requirements
2. Generate a complete configuration spec document
3. Write it to `ACE/<opp-name>/connect-setup/opp-config-spec.md`
4. Ask the user to create the opportunity in Connect UI following the spec
5. Ask for the Opportunity ID and URL
6. Record in the opportunity folder

## Mode Behavior
- **Auto:** Configure (or guide manual config), proceed
- **Review:** Present configuration spec for approval before creating
