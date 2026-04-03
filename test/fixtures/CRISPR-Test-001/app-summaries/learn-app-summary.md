# Learn App Summary — CRISPR-Test-001

**App Name:** TestLand MCH Training
**Connect Type:** learn
**Generated:** 2026-04-03 (synthetic fixture)

## Modules

### 1. Prenatal Assessment Basics
- **Description:** Identifying risk factors, measuring blood pressure, recording symptoms during prenatal home visits
- **Assessment:** 5-question quiz, passing score 80%
- **Score question:** `prenatal_score` (hidden, calculated)

### 2. Immunization Schedule
- **Description:** Age-appropriate vaccinations, cold chain awareness, and contraindication identification
- **Assessment:** 5-question quiz, passing score 80%
- **Score question:** `immunization_score` (hidden, calculated)

### 3. Danger Signs Recognition
- **Description:** Recognizing maternal and child danger signs, emergency referral protocols
- **Assessment:** 5-question quiz, passing score 80%
- **Score question:** `danger_signs_score` (hidden, calculated)

## Connect Configuration
- `connect_type: learn`
- Each form has `learn_module` with description and `assessment` with `score_question` and `passing_score: 80`
