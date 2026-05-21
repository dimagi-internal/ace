---
name: clp-stage-work-order
description: >
  Draft a Connect Learning Partner (CLP) stage work order for partner
  LLOs. Use when starting a new CLP stage and preparing the SOW for a
  cohort.
---

# CLP Stage Work Order

Draft the contract / SOW that goes to partner LLOs at the start of each new CLP (Connect Learning Partner) stage.

## When to use

At the start of each new CLP stage, when preparing the contract/SOW for a cohort of partner LLOs.

## Related skills

- `dimagi-external-document` — handles the *visual styling* and `.docx` generation. This skill defines *what content* goes in the work order; that skill renders it. Always finish a CLP work order by running it through `dimagi-external-document` Step 2.

## Core principles

**1. Follow the fixed skeleton, not a prior stage's output.**
Every work order shares a fixed set of sections (listed below). Do not replicate the previous stage's structure section-for-section — earlier stages were simpler and did not need all the sections a more complex stage requires.

**2. New requirements from the PM become standalone named sections.**
When the PM provides new rules or expectations for a stage (e.g., photo audit process, GPS rules, translation responsibility, third-party tooling), each distinct requirement gets its own clearly named section heading — not a sub-bullet or numbered sub-item buried inside Scope of Work. This makes the document scannable and legally clear. What counts as a standalone section will change from stage to stage; the PM will define this at the start of each stage.

**3. Use named sections, not numbered sub-items.**
Sections like "FLW Photo Requirements" or "NM Photo Audit" should appear as their own titled sections in the document, not as "Section 2a" or "2b." Use bold inline labels (e.g., **Bulk Image Review:**) within bullet lists to create sub-structure without adding unnecessary heading levels.

**4. Leave budget amounts as TBD unless explicitly confirmed.**
Do not carry forward rates or bonus structures from a prior stage. Ask the PM for the confirmed payment structure before populating the budget table.

**5. Scale milestone rows to the visit target.**
For higher visit targets (e.g., 500 visits), use incremental milestones (e.g., at 125, 250, 375, 500) rather than a single end-date payment row. For smaller targets, fewer rows are appropriate.

## Steps before drafting

Ask the PM for:
- Stage number and campaign intervention type
- Period of performance (start and end dates)
- Confirmed budget/payment structure (or confirm it is TBD)
- Any new stage-specific requirements that need standalone sections
- Any sections from the previous stage that no longer apply
- Any sections from the previous stage that continue to apply

Reference the most recent prior-stage work order (if available) for legal boilerplate (Special Conditions, Data Handling table, Witness clause, signature block) and overall layout. Do not copy it for content or section structure.

## Fixed document skeleton

These sections appear in every work order, in this order:

### 1. Header Block
- Work Order Number
- Work Order Date
- Work Order Title: `Connect Learning Partner (CLP) Program – Stage N: [Campaign Name]`
- Period of Performance

### 2. Scope of Work

**Overview of the project and desired outcomes**
Bullet list covering: what platform capability is being tested, the verified visit target and verification criteria, key processes being evaluated, and what feedback will inform product improvements.

**Activities required to complete the project**
Organise into named phases with indicative week ranges. Phases are always:
- Setup Phase
- Delivery Phase
- [Any stage-specific named phases the PM introduces, e.g., "NM Photo Audit (Weekly, every Monday)"]
- Closure Phase

Within the Delivery Phase, always include:
- Per-FLW visit breakdown (e.g., 5 FLWs × 100 visits = 500 total)
- Itemised list of what each visit includes
- Commodity management if applicable
- FLW payments and invoicing

**[Stage-specific standalone sections]**
For each new requirement the PM specifies, insert a clearly named section here (e.g., "FLW Photo Requirements," "NM Photo Audit," "PM Verification of NM Photo Audit," "Translation Responsibility," "Third-Party Analytics Tool"). These sections are defined per stage — do not carry them forward from a previous stage unless the PM confirms they still apply.

### 3. Support
- No direct 1:1 Dimagi support
- Digital resources (wiki, help site, documentation)
- Connect Support Bot (note any improvements from prior stage)
- Government approval templates
- Individual support requests will not receive responses

### 4. Budget
- Total potential payment: $[TBD unless confirmed]
- Breakdown: service delivery payments + any reimbursements + completion bonus
- Note if budget structure is not yet finalised

### 5. Payment Schedule (Milestones Table)
Four columns: Invoice # | Milestone | Deliverable | Payment
Scale the rows to the visit target. Always include Setup Complete and Stage Completion Bonus rows. Add incremental visit milestones for large targets.
Include note: Partners can combine invoices and be paid at end of period.

### 6. Point of Contact
- CLP support email/portal
- Documentation wiki
- Connect Support Bot
- Note: individual support requests will not receive responses

### 7. Items out of Scope
Tailor to the stage. Always include: direct Dimagi support, services beyond the verified visit target. Add any commodity, clinical, or other exclusions relevant to the intervention.

### 8. Reporting Requirements
Standalone section (not merged with Scope). Cover:
- Weekly visit and verification updates
- Invoicing cadence
- FLW payment confirmations
- Government approval docs
- Consent rates
- Any stage-specific reporting (e.g., photo audit written report, commodity records, GPS failure logs)
- Exit interview scope

### 9. Special Stage Requirements
Standalone section listing the hard contractual requirements specific to this stage (e.g., GPS proximity rules, photo pass rates, audit schedules, translation obligations, monitoring consent). Define at start of each stage with the PM.

### 10. Special Conditions
Standard CLP boilerplate (challenges are expected, success measured by feedback quality, verification rules enforced, PM retains final authority where applicable, platform may be incomplete, partner participates at own risk, payment contingent on criteria).

Customise only the bullets that reference stage-specific mechanisms (e.g., if there is no photo audit, remove that bullet).

### 11. Data Handling Table
Standard 9-row table: Project overview, Data Subjects, Type of personal information, Purpose, Technical/org security, Partner measures, Retention period, Data storage, Data protection. Update "Type of personal information" row to reflect what data is collected in this stage.

### 12. Witness Clause + Signature Block
Standard "IN WITNESS WHEREOF" clause with blank MSA date.
Two-column signature table: Subcontractor (blank fields) | Dimagi, Inc. (Name: Lucina Tse, Title: COO Dimagi, Inc., date blank).

### 13. Annexure 1: Support Resources
Standard list of digital resources. Update to add any stage-specific resources (e.g., commodity procurement guide, image capture training module). Note: shared after contract signing.

## Formatting and output

Hand the finished markdown draft to the `dimagi-external-document` skill for `.docx` rendering — do not re-derive Dimagi styling here. That skill handles fonts (Work Sans), brand colors (Deep Purple `#16006D`, Connect Indigo `#3843D0`), table patterns, spacing, and bullet hierarchy.

Output:
- Save final as: `outputs/YYYY-MM-DD-stage-N-work-order.docx`
- Final deliverable — use `.docx`, not `.md`
