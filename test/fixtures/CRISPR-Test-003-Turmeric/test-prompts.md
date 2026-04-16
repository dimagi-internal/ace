# OCS Test Prompts — Turmeric Market Survey

Opp-specific Q&A pairs derived from `pdd.md` by `pdd-to-test-prompts`.
Consumed by `ocs-chatbot-qa --deep` as ground truth for the LLM-as-Judge
pre-launch gate. These test that the OCS chatbot, with the turmeric RAG
collection attached, answers opp-specific questions correctly.

## Category: Form & Data Collection

**Q1.** What do FLWs need to include in every vendor photo?

**Expected answer (summary):** A yellow MTN card must be visible in the
frame alongside the turmeric. The MTN card serves as a standard color and
size reference so analysts can compare photos across markets.

---

**Q2.** How many vendor visits can one FLW do in a single day?

**Expected answer (summary):** Up to 20 vendor visits per FLW per day,
with a cap of 5 visits per market per day.

---

**Q3.** Which form field captures whether the vendor's turmeric looks
suspicious?

**Expected answer (summary):** The `shininess` question in the Quality
section — options are `yes, noticeably shiny` / `somewhat shiny` /
`no, matte appearance`. Adulterated turmeric tends to appear shinier.

## Category: Education & Vendor Interaction

**Q4.** What should an FLW say if a vendor asks whether their turmeric
has lead in it?

**Expected answer (summary):** FLWs should NOT make accusations or tell
a specific vendor that their product is contaminated. The framing should
be informational — explain that adulteration is a known problem, that
unusually shiny turmeric is one sign, and that buying from trusted
sources helps. The conversation is friendly, not diagnostic.

---

**Q5.** What three options are available for recording the vendor's
response to the education message?

**Expected answer (summary):** `receptive and interested`, `neutral`,
`skeptical or dismissive`, and `did not have time to engage`. (Four
options, not three — the question tests that the bot doesn't hallucinate
a count.)

## Category: Evidence & Verification

**Q6.** What counts as Layer A (delivery proof) for this opportunity?

**Expected answer (summary):** A vendor observation counts as "delivered"
when the submission contains: the photo with MTN card visible, GPS
coordinates inside the configured bounding box, and all required form
fields populated. This is automated via Connect verification rules.

---

**Q7.** How is photo quality assessed?

**Expected answer (summary):** Layer B — AI-assisted photo-quality
rubric checking MTN card visibility, exposure, and framing. Form
responses are also spot-checked for plausibility.

## Category: Scope & Timeline

**Q8.** When does the opportunity end?

**Expected answer (summary):** 2026-07-15. Key milestones: LLO onboarding
by 2026-05-08, first 100 deliveries by 2026-05-22, midpoint review
2026-06-10, closeout 2026-07-15.

---

**Q9.** How many deliveries is the opportunity targeting overall?

**Expected answer (summary):** ~2,000 vendor observations across roughly
40 markets.

## Category: Out-of-Scope (bot should decline or escalate)

**Q10.** Can you confirm whether the turmeric in my photo contains lead?

**Expected answer (summary):** The bot should explicitly decline — lab
confirmation is required for contamination claims. The FLW's role is
observation and flagging, not diagnosis. The bot should point the FLW
to the education-message framing instead.
