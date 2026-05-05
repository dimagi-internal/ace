# Program Design Document (PDD)

## Opportunity: KMC Multimedia Smoke
**Date:** 2026-05-05
**Author:** ACE Test Fixture
**Archetype:** atomic-visit

---

## Problem Statement
Small or vulnerable newborns (SVN — under 2.5 kg or born preterm) are
the leading cause of neonatal mortality in low-resource settings.
Mothers and caregivers often do not know how to position a small baby
for skin-to-skin care, recognise early danger signs, or sustain
exclusive breastfeeding. Frontline health workers visiting at home
need a structured way to teach the practice and screen each baby for
warning signs.

## Intervention Design
Frontline workers (FLWs) visit mothers of small or vulnerable newborns
and teach Kangaroo Mother Care (KMC): continuous skin-to-skin contact,
exclusive breastfeeding, and early recognition of danger signs. Each
visit is a single in-person encounter with one structured assessment
and several teaching points. The Learn app trains the FLW first; the
Deliver app structures the visit itself.

## Learn App Specification

### Training Modules
1. **What is KMC?** — instructional. Explains benefits, positioning,
   recommended duration of skin-to-skin per day, and indications for
   small / vulnerable newborns.
2. **How to position the baby** — instructional. Step-by-step visual
   demonstration: head and neck support, skin contact between baby's
   chest and caregiver's chest, wrapping the baby securely, safe
   sleeping position.
3. **Recognising danger signs** — instructional with embedded quiz.
   Visual cues for jaundice, apnea, poor feeding, and hypothermia,
   each paired with a "what to do" referral instruction.
4. **Knowledge check** — quiz. Single-select questions covering
   positioning, danger signs, and feeding guidance.

### Assessment
- The final knowledge check is graded. Passing score: 80%.
- FLW must pass before fielding KMC visits.

## Deliver App Specification

### Services Delivered
- One home visit per mother of a small / vulnerable newborn. The visit
  combines direct observation of KMC practice, danger-sign triage, and
  short structured counselling on whichever teaching points the
  caregiver still needs.

### Forms
| Form Name | Purpose | Key Fields |
|-----------|---------|------------|
| KMC Home Visit | Single registration form per visit | mother_name, mother_age, mother_phone, baby_birth_weight, baby_gestational_age, baby_current_weight, positioning_correct, danger_signs_present, counselling_topics_delivered, follow_up_date |

### Workflow
1. FLW opens app → registers mother + baby (or selects an existing
   case).
2. Records baby weight + gestational age + current weight.
3. Direct observation: is the baby positioned correctly? (yes/no with
   optional photo capture).
4. Triage: any danger signs present? (multi-select with visual
   choices: jaundice, apnea, poor feeding, hypothermia, none).
5. Records which counselling topics were delivered (multi-select).
6. Sets a follow-up date.
7. Closes the visit form; CommCare auto-syncs the data.

### Case Management
- Case types: `mother_baby` (one case per mother + small newborn pair).
- Case lifecycle: opened on first visit → updated each subsequent visit
  → closed once baby reaches 2.5 kg sustained or at 6 weeks
  postpartum, whichever comes first.

## Target Population
- Beneficiary criteria: mothers whose newborn is small (<2.5 kg) or
  preterm (<37 weeks gestational age).
- Geographic scope: peri-urban catchments with community-health-worker
  coverage.
- Expected reach: ~600 mother–baby pairs across the opportunity.

## FLW Requirements
- Number of FLWs: 25
- Skills/qualifications: existing community health workers, basic
  literacy in the local language, comfortable with smartphone-based
  data entry.
- Geographic distribution: spread across the catchment so each FLW
  carries roughly 25 mother–baby pairs.

## LLO Preference
- Preferred LLOs: (none — smoke fixture, runs without solicitation)

## Success Metrics
| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| ≥80% of registered SVN babies receive at least 1 KMC visit | 80% | Visit form submission count vs registered cases |
| ≥70% of visits record correct positioning on direct observation | 70% | `positioning_correct=yes` rate |
| Danger-sign-positive babies referred to facility | 100% | Cross-check `danger_signs_present` ≠ none against referral log |

## Timeline
- Start date: 2026-06-01
- End date: 2026-09-30
- Key milestones:
  - LLO onboarded and FLWs trained: 2026-06-01
  - First field visits: 2026-06-15
  - Mid-cycle review: 2026-08-01

## Budget
- Estimated cost: 18000
- Payment structure: per visit
