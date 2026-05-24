# Training Deck Generation Prompt — Focus Group Discussion

You are generating a training deck spec for a focus-group Connect opportunity. The output is a fully populated `spec.yaml` file that the rendering pipeline will convert into a Google Slides presentation.

**Key difference from atomic-visit:** In FGD opportunities, CommCare interaction is minimal (a sentinel readiness form and a 5-field attestation form). The core work is facilitating a 75-90 minute group discussion. The OCS chatbot is the primary guidance surface for preparation and post-session documentation. The deck emphasizes facilitation skills, consent, neutrality, and documentation — not app workflows.

## Input Sources

Read these artifacts from the opportunity's Drive folder (`ACE/<opp>/`):

1. **PDD** (`inputs/pdd.md` or the Google Doc at `source.pdd_doc_id`) — the authoritative design document. Extract: opportunity name, program name, target population, FGD topic/research questions, question guide structure, consent requirements, output spec (Google Doc format), payment structure, geographic scope, session logistics (duration, venue, participant count).
2. **App summary** (`<run>/3-commcare-setup/app-summary.md`) — the CommCare app structure. For FGD opps, this is minimal: a sentinel readiness form and a 5-field attestation form (consent, date, venue, GPS, photo). Extract: form names, exact field labels.
3. **Screenshot manifest** (`<run>/3-commcare-setup/screenshot-manifest.yaml` or `<run>/6-qa-and-training/screenshot-manifest.yaml`) — available `@alias` references for app screenshots. Only 2-3 screenshots are needed for FGD (sentinel form + attestation form). Every `@alias` you use in the spec MUST exist in this manifest.
4. **run_state.yaml** (`<run>/run_state.yaml`) — run metadata. Extract: `run_id`, `generated_at` timestamp, OCS chatbot name, Connect opportunity details.
5. **Question guide** (from PDD or inputs) — the structured discussion guide with question categories, probing questions, and time allocations.

## Module-by-Module Content Instructions

### welcome (generate fresh)

- **cover**: Use opportunity name as title. Subtitle format: "FLW Training — {date}".
- **agenda**: List the module names as agenda items with approximate durations. Total should match `expected_duration_minutes` from the template (180-300 min). FGD training sessions run longer because of practice facilitation exercises.
- **icebreaker**: Select ONE icebreaker from `_common/facilitation.yaml`. Pick `two-truths` for groups of 10+, `one-word` for groups of 20+, `common-ground` for groups under 10. Fill the template tokens.

### platform-setup (include by reference)

Include the `_common/platform-setup.yaml` module verbatim. Do NOT regenerate these slides. In the spec, reference it as:

```yaml
- id: platform-setup
  ref: _common/platform-setup
```

The rendering pipeline resolves the reference at build time.

### fgd-overview (generate fresh — sets the context)

Generate 4-6 slides covering:

1. **What is this FGD?** (1-2 slides, layout: `content`)
   - What the discussion topic is, in plain language
   - Why this research matters — who will use the findings and how
   - What participants will experience during the session

2. **Session logistics** (1 slide, layout: `stats` or `content`)
   - Session duration (typically 75-90 min)
   - Number of participants per session (typically 6-12)
   - Where sessions happen (venue type)
   - If using `stats` layout: max 3 items, each with `big:` (the prominent number/value) and `label:` (short description). No `body` field. Example:
     ```yaml
     stats:
       - big: "75-90 min"
         label: "Session length"
       - big: "6-12"
         label: "Participants per group"
       - big: "3 sessions"
         label: "Your weekly target"
     ```

3. **Your role as facilitator** (1 slide, layout: `content` or `two_column`)
   - You are a guide, not a teacher — your job is to listen and ask
   - Stay neutral — no right or wrong answers
   - Make sure every voice is heard, not just the loudest
   - Keep the group on topic and on time

4. **Three steps to complete a delivery** (1-2 slides, layout: `timeline`)
   - Step 1: Run the FGD session (75-90 min)
   - Step 2: Submit the attestation form within 24 hours (5 fields, ~30 seconds)
   - Step 3: Write the session Google Doc within 72 hours (using OCS chatbot to help)
   - Make the three-step structure crystal clear — payment requires all three

### running-the-session (generate fresh — core facilitation training)

Generate 6-10 slides covering:

1. **Before you start** (1 slide, layout: `checklist`)
   - Venue is set up (chairs in a circle, no distractions)
   - Recording device is charged and working
   - Question guide is printed or on your phone
   - Sentinel readiness form submitted in CommCare
   - Consent forms are ready
   - Refreshments available (if applicable)

2. **Getting consent** (1-2 slides, layout: `content`)
   - Read the consent script exactly as written — do not paraphrase
   - Every participant must give verbal consent on recording before you begin
   - If someone declines, thank them and let them leave — no pressure
   - Note who consented on your tracking sheet

3. **Question guide walkthrough** (2-3 slides, layout: `content` or `two_column`)
   - Walk through the structure of the question guide (warm-up, core, closing)
   - Show how to use probing questions: "Can you tell me more?" "Why do you think that?"
   - Time allocation per section
   - If using `two_column`: one side for the question category, one side for facilitation tips

4. **Facilitation skills** (1-2 slides, layout: `two_column` or `content`)
   - **Do**: Make eye contact, nod, pause after questions, invite quiet participants by name, summarize what you heard
   - **Don't**: Share your own opinion, interrupt, allow one person to dominate, rush through questions, read from your phone while someone is talking
   - Managing difficult moments: disagreements, off-topic tangents, emotional responses

5. **Wrapping up** (1 slide, layout: `content`)
   - Thank all participants
   - Summarize key themes you heard (1-2 sentences — this is practice for the doc)
   - Stop the recording
   - Collect any materials

### after-the-session (generate fresh — documentation and attestation)

Generate 4-6 slides covering:

1. **Submit the attestation form** (1-2 slides, layout: `walkthrough` or `content`)
   - Open CommCare, find the attestation form
   - Five fields: consent confirmation, session date, venue name, GPS location, group photo
   - Must be submitted within 24 hours of the session
   - If a screenshot alias exists for the attestation form, use `walkthrough` layout with the `@alias`. Otherwise use `content` layout.

2. **Writing your session document** (1-2 slides, layout: `content`)
   - Within 72 hours, create a Google Doc following the Output Spec
   - What to include: key themes, notable quotes, participant dynamics, your observations
   - What NOT to include: participant names (use P1, P2, etc.), your own opinions stated as findings

3. **Using the OCS chatbot** (1-2 slides, layout: `content` or `walkthrough`)
   - The chatbot helps you structure your session document
   - How to access it: open the Connect app, tap the chat icon
   - What to ask: "Help me write up my session," "What should I include in the findings section?"
   - The chatbot knows the Output Spec — let it guide you
   - Pre-session: ask about facilitation tips, question guide clarifications
   - Post-session: ask for help structuring your Google Doc

4. **Payment** (1 slide, layout: `stats` or `content`)
   - Payment is per verified delivery (all three steps complete)
   - Payment amount, method, and timing from PDD
   - Quality review: coordinator listens to a sample of recordings
   - If using `stats` layout: max 3 items with `big:` and `label:`. Example:
     ```yaml
     stats:
       - big: "USD 15.00"
         label: "Per verified session"
       - big: "72 hours"
         label: "Doc deadline after session"
       - big: "Weekly"
         label: "Payment cycle"
     ```

### practice (generate fresh)

Generate 4-6 slides using a mix of facilitation patterns and FGD-specific exercises:

1. **Guided Learn completion** — use the `guided-learn` pattern from `_common/facilitation.yaml`. Set `{{N}}` to "1" for the first module. If the PDD lists multiple Learn modules, add one slide per module.

2. **Consent script read-aloud** (layout: `exercise`)
   - Duration: 10 min
   - Each person reads the consent script aloud to a partner
   - Partner listens for: clarity, pace, eye contact, confidence
   - Switch roles and repeat

3. **Mock FGD** (layout: `exercise`)
   - Duration: 30-45 min
   - Split into groups of 6-8
   - One person facilitates using 2-3 questions from the question guide
   - Others play participants (assign personas if helpful — "you are skeptical," "you are enthusiastic," "you are quiet")
   - After 15 min, pause for feedback: What went well? What was hard?
   - Rotate facilitator and repeat

4. **OCS chatbot practice** (layout: `exercise`)
   - Duration: 10-15 min
   - Open the chatbot on your phone
   - Ask it: "What should I do if a participant gets upset?"
   - Ask it: "Help me prepare for a session about [topic from PDD]"
   - Share interesting answers with the group

5. **Attestation form walkthrough** (layout: `exercise` or `walkthrough`)
   - Duration: 5 min
   - Open CommCare, find the attestation form
   - Fill out a practice submission together as a group
   - Confirm sync

### resources (include by reference)

Include the `_common/resources.yaml` module verbatim. Fill `{{LLO_CONTACT}}` from `run_state.yaml` if available, otherwise leave the placeholder. In the spec, reference it as:

```yaml
- id: resources
  ref: _common/resources
  overrides:
    LLO_CONTACT: "{{LLO_CONTACT}}"
```

## Layout Selection Rules

Choose the layout that best fits each slide's content:

| Layout | When to use | Word budget |
|--------|-------------|-------------|
| `cover` | First slide only — title + subtitle + date | 10-15 words |
| `agenda` | Session agenda with timed items | 5-8 words per item |
| `content` | Text-heavy explanations, lists, descriptions | 40-80 words |
| `two_column` | Side-by-side comparisons, do/don't lists | 20-40 words per side |
| `walkthrough` | Single screenshot with numbered annotations | 30-50 words |
| `mobile_flow` | Multi-step phone workflow (2-4 screenshots in sequence) | 5-10 words per caption |
| `stats` | Key numbers (payment amounts, thresholds, counts). Max 3 items. Each item has `big` (the number) and `label` (short description). No `body` field. | 5-10 words per label |
| `before_after` | Comparing correct vs incorrect facilitation behaviors | 15-25 words per side |
| `exercise` | Hands-on practice activity with instructions | 30-60 words |
| `checklist` | Pre-session or readiness checklists | 5-10 words per item |
| `closing` | Final slide — thank you + key reminders | 30-50 words |
| `quote` | Testimonial or motivational quote | 15-30 words |
| `map` | Geographic coverage area | 10-20 words caption |
| `timeline` | Sequential process or schedule | 5-10 words per step |

**FGD layout distribution differs from atomic-visit:**
- **More `content` and `two_column`** — facilitation skills, consent procedures, and documentation guidance are text-heavy.
- **More `exercise`** — the practice module is longer and includes mock facilitation, consent read-aloud, and chatbot interaction.
- **Fewer `walkthrough` and `mobile_flow`** — CommCare interaction is minimal (sentinel form + attestation form only). Expect only 2-3 screenshot slides total.
- **`timeline` is useful** for the three-step delivery sequence.
- **Default to `content` when uncertain.**

## Screenshot Integration

Reference screenshots using the `@alias` format: `@play-store-search`, `@connect-home`, `@attestation-form`, etc.

Rules:
- Every `@alias` MUST exist in the screenshot manifest. Do not invent aliases.
- Common aliases from `_common/platform-setup.yaml` are pre-defined (e.g., `@play-store-search`, `@commcare-install`, `@connect-home`). These are resolved by the rendering pipeline from the common screenshot set.
- Opportunity-specific aliases come from the run's screenshot manifest. For FGD opps, expect only 2-3 opp-specific screenshots: sentinel readiness form and attestation form. Use the exact alias strings from that manifest.
- If a screenshot is not available for a step, use layout `content` instead of `walkthrough`/`mobile_flow`. Never reference a nonexistent screenshot.

## Tone and Language Guidelines

- **Reading level**: High-school equivalent. Short sentences. Simple words.
- **Concrete actions**: "Read the consent script word-for-word" not "Obtain informed consent". Name exact steps.
- **No jargon**: No "beneficiary", "respondent", "informant", "module" (use "participant", "person in the group", "section"). Exception: "CommCare", "Connect", "PersonalID", "Learn", and "OCS chatbot" are proper nouns — always capitalize.
- **Active voice**: "You will lead 3 group discussions per week" not "3 discussions will be facilitated weekly".
- **No speaker notes**: The deck is self-contained. Everything the trainer needs is on the slides.
- **Numbers are concrete**: "$15 per session" not "compensation per delivery unit". "6-12 participants per group" not "target group size".
- **Positive framing**: "Let everyone finish their thought before asking the next question" not "Don't interrupt participants".
- **Facilitation tone**: Emphasize listening, neutrality, curiosity, and respect for participants. The facilitator is a guide, not an expert. "Your job is to ask and listen, not to teach or correct."

## Output Format

Produce a single `spec.yaml` file with all placeholders filled. The file must:

1. Pass YAML syntax validation
2. Have every `@alias` reference match the screenshot manifest
3. Have a total slide count between 25 and 40
4. Have every slide with a non-empty `title`
5. Use only layouts from the 14 defined types above
6. Include `platform-setup` and `resources` as `ref:` includes, not inline copies
7. Have minimal `walkthrough`/`mobile_flow` slides (2-3 max for opp-specific content, beyond the common platform-setup module)
