---
name: idea-to-idd
description: >
  Iterate on an idea to produce a well-specified Intervention Design Doc (IDD)
  for a Connect application. Defines the intervention, target FLWs, visit
  structure, and preferred LLOs.
---

# Idea to IDD

Take an initial idea and iterate on it to produce a complete Intervention Design
Doc (IDD) that specifies a Connect application.

## Process

1. **Read the initial idea** from the opportunity folder in GDrive
   (`ACE/<opp-name>/idea.md` or provided as input).

2. **Research and expand** the idea:
   - What health/development problem does this address?
   - What is the intervention mechanism?
   - Who are the target beneficiaries?
   - What data needs to be collected (Learn app)?
   - What services need to be delivered (Deliver app)?

3. **Draft the IDD** with these sections:
   - **Problem Statement** — what problem this solves
   - **Intervention Design** — how the intervention works
   - **Learn App Specification** — what data FLWs collect, visit structure, form design
   - **Deliver App Specification** — what services FLWs deliver, workflow, case management
   - **Target Population** — beneficiary criteria, expected reach
   - **FLW Requirements** — number of FLWs, skills needed, geographic distribution
   - **LLO Preference** — preferred or known LLOs to execute, from LLO Directory
   - **Success Metrics** — how to measure if the intervention worked
   - **Timeline** — expected duration of the opportunity

4. **Self-evaluate (LLM-as-Judge):**
   - Is the IDD complete enough for Nova to generate apps?
   - Are the Learn and Deliver app specs specific enough?
   - Are success metrics measurable?
   - Is the FLW/visit structure realistic?
   If quality is insufficient, iterate on weak sections before outputting.

5. **Write the IDD** to `ACE/<opp-name>/idd.md` via Google Drive MCP.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`, `drive_update_file`

## Mode Behavior
- **Auto:** Write IDD, email summary to admin group, proceed
- **Review:** Write IDD, present for human review, wait for approval

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
