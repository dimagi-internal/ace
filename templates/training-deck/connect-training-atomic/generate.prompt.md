# Training Deck Generation Prompt — Atomic Visit

You are generating a training deck spec for an atomic-visit Connect opportunity. The output is a fully populated `spec.yaml` file that the rendering pipeline will convert into a Google Slides presentation.

## Input Sources

Read these artifacts from the opportunity's Drive folder (`ACE/<opp>/`):

1. **PDD** (`inputs/pdd.md` or the Google Doc at `source.pdd_doc_id`) — the authoritative design document. Extract: opportunity name, program name, target population, visit workflow, form fields, payment structure, quality criteria, geographic scope.
2. **App summary** (`<run>/3-commcare-setup/app-summary.md`) — the CommCare app structure. Extract: form names, case properties, module flow, media references.
3. **Screenshot manifest** (`<run>/3-commcare-setup/screenshot-manifest.yaml` or `<run>/6-qa-and-training/screenshot-manifest.yaml`) — available `@alias` references for app screenshots. Every `@alias` you use in the spec MUST exist in this manifest.
4. **run_state.yaml** (`<run>/run_state.yaml`) — run metadata. Extract: `run_id`, `generated_at` timestamp, OCS chatbot name, Connect opportunity details.
5. **Learn module structure** (from app summary or PDD) — module names and content for practice slide generation.

## Module-by-Module Content Instructions

### welcome (generate fresh)

- **cover**: Use opportunity name as title. Subtitle = `"FLW Training"` (no date — the `date:` field renders the date on its own line below the subtitle; including the date in the subtitle string makes it render twice). The `date:` field gets the month + year (e.g. `"June 2026"`).
- **agenda**: List the module names as agenda items with approximate durations. Total should match `expected_duration_minutes` from the template (150-240 min).
- **icebreaker**: Select ONE icebreaker from `_common/facilitation.yaml`. Pick `two-truths` for groups of 10+, `one-word` for groups of 20+, `common-ground` for groups under 10. Fill the template tokens.

### platform-setup (include by reference)

Include the `_common/platform-setup.yaml` module verbatim. Do NOT regenerate these slides. In the spec, reference it as:

```yaml
- id: platform-setup
  ref: _common/platform-setup
```

The rendering pipeline resolves the reference at build time.

### your-opportunity (generate fresh — this is the core)

This is the heart of the deck. Generate 8-15 slides covering:

1. **Opportunity overview** (1-2 slides, layout: `content` or `two_column`)
   - What the work is, who benefits, why it matters
   - Payment structure: amount per visit, payment schedule, minimum quality threshold

2. **Who you will visit** (1 slide, layout: `content`)
   - Target population description from PDD
   - Eligibility criteria if any
   - What to expect at a typical visit

3. **Your visit workflow** (3-6 slides, layout: `walkthrough` or `mobile_flow`)
   - Walk through EACH form in the app, step by step
   - Use `@alias` screenshots from the manifest for every form screen
   - Name exact buttons: "Tap 'Next'", "Select 'Yes'", "Tap 'Submit'"
   - One slide per major form section or decision point

4. **Quality and verification** (1-2 slides, layout: `content`)
   - How work is verified (GPS, photo, supervisor review, automated checks)
   - Common rejection reasons and how to avoid them
   - Quality threshold required for payment

5. **Payment details** (1 slide, layout: `stats` or `content`)
   - Amount per verified delivery
   - Payment method and timing
   - Minimum deliveries for payout
   - If using `stats` layout: max 3 items, each with `big:` (the prominent number/value) and `label:` (short description). No `body` field — stats slides only have `title` and `stats`. Example:
     ```yaml
     stats:
       - big: "USD 2.50"
         label: "Per verified visit"
       - big: "Weekly"
         label: "Payment cycle"
       - big: "10 visits"
         label: "Minimum for payout"
     ```

6. **Safety and ethics** (1 slide, layout: `content`)
   - Consent requirements
   - Data privacy expectations
   - What to do if someone refuses or is unavailable

### practice (generate fresh)

Generate 3-5 slides using patterns from `_common/facilitation.yaml`:

1. **Guided Learn completion** — use `guided-learn` pattern. Set `{{N}}` to "1" for the first module. If the PDD lists multiple Learn modules, add one slide per module.
2. **Form practice** — use `form-practice` pattern. Set `{{FORM_NAME}}` to the primary delivery form name from the app summary.
3. **Role play** — use `role-play` pattern. Set `{{VISIT_TYPE}}` and `{{ROLE}}` from the PDD's visit description (e.g., `{{VISIT_TYPE}}` = "Household Visit", `{{ROLE}}` = "household member").

### evaluation (generate fresh)

Generate 2-3 slides:

1. **Knowledge check** (layout: `exercise`)
   - 3-5 multiple-choice questions derived from the training content
   - Cover: eligibility criteria, form workflow, quality requirements, payment rules
   - Duration: 10 min

2. **Field readiness checklist** (layout: `checklist`)
   - Items: phone charged, CommCare installed, Learn modules complete, sync completed, practice form submitted, ID badge/materials ready

3. **Next steps** (layout: `content`)
   - When field work starts
   - First-day logistics
   - Who to contact with questions

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
| `before_after` | Comparing correct vs incorrect form entries | 15-25 words per side |
| `exercise` | Hands-on practice activity with instructions | 30-60 words |
| `checklist` | Pre-flight or readiness checklists | 5-10 words per item |
| `closing` | Final slide — thank you + key reminders | 30-50 words |
| `quote` | Testimonial or motivational quote | 15-30 words |
| `map` | Geographic coverage area | 10-20 words caption |
| `timeline` | Sequential process or schedule | 5-10 words per step |

**Default to `content` when uncertain.** Prefer `walkthrough` and `mobile_flow` over `content` when screenshots are available — visual slides train faster than text slides.

## Screenshot Integration

Reference screenshots using the `@alias` format: `@play-store-search`, `@connect-home`, `@form-household-q1`, etc.

Rules:
- Every `@alias` MUST exist in the screenshot manifest. Do not invent aliases.
- Common aliases from `_common/platform-setup.yaml` are pre-defined (e.g., `@play-store-search`, `@commcare-install`, `@connect-home`). These are resolved by the rendering pipeline from the common screenshot set.
- Opportunity-specific aliases come from the run's screenshot manifest. Use the exact alias strings from that manifest.
- If a screenshot is not available for a step, use layout `content` instead of `walkthrough`/`mobile_flow`. Never reference a nonexistent screenshot.

## Tone and Language Guidelines

- **Reading level**: High-school equivalent. Short sentences. Simple words.
- **Concrete actions**: "Tap 'Submit'" not "Submit the form". Name exact buttons, menus, and screens.
- **No jargon, and every abbreviation defined on first use** (B3): Avoid "beneficiary", "case", "module" (use "person you visit", "record", "section"). Exceptions — always capitalize as proper nouns: "CommCare", "Connect", "PersonalID", "Learn", "OCS" (define as "Open Chat Studio" on first use). **For any organization-specific abbreviation** (e.g. "DFHF", "MOH", "PHC"), expand on its first appearance in the deck — write "the Dimagi Field Health Foundation (DFHF)" the first time, then "DFHF" thereafter. **Any all-caps 2-5-letter sequence in body text or speaker notes that isn't a proper-noun exception above must be defined inline once.** The deck's audience is field workers, not insiders — assume zero prior org context.
- **Active voice**: "You will visit 20 households" not "20 households will be visited".
- **Body copy depth (B2b)**: Walkthrough and content slides need **1-2 full sentences minimum** in the body field — not 4-7 word fragments. The trainee reads the slide alone; a single fragment like "Tap Start to claim" leaves out the WHY ("this signals you'll accept the work and your CommCare app will download the training modules"). Write full sentences that teach.
- **Consistent title pattern within a flow (B2b)**: When emitting a sequence of walkthrough slides (e.g. Steps 1-9 of the platform setup), use ONE consistent title prefix pattern for ALL slides in the sequence — either all "Step N: <verb phrase>" or all bare titles. Mixing ("Step 1:", "Step 2:", "Connect Home", "Sync") breaks visual flow. Pick a pattern when you start the sequence and hold it.
- **No internal contradictions across slides (B4)**: Numeric claims (sample counts, payment amounts, durations, thresholds) must be consistent across all slides in the deck. If slide 5 says "5-10 locations per day" and slide 12 says "10-15 samples per day" and slide 18 says "Maximum 15", that's three different numbers that confuse the trainee. Pick ONE per dimension (locations vs samples are different units; be explicit) and use it everywhere.
- **Numbers are concrete**: "$2.50 per visit" not "compensation per delivery unit". "20 households per week" not "target volume".
- **Positive framing**: "Sync after each form to keep your data safe" not "If you don't sync, you might lose data".

## Speaker Notes (REQUIRED on every slide)

Every slide MUST carry a `notes:` field (Zod-validated as optional, but
the deck is incomplete without them). The notes are what the trainer
reads aloud; the body text is what the trainee sees on the screen. They
are NOT redundant — notes add context, examples, and facilitator cues
the trainee shouldn't see verbatim.

Length: 50-150 words per slide. Format: prose, not bullets. Voice:
addressed to the trainer in second person ("Ask the room…", "Pause
here for…", "If anyone says X, redirect to…").

What to include per layout:
- **cover, section, closing** — opener / transition / wrap-up cues
- **agenda** — total session duration + what to highlight (the
  trickiest module, expected break points)
- **content, two_column** — the one or two background facts that
  make the slide land (a real-world example, why it matters)
- **walkthrough, mobile_flow, mobile_zoom** — what to watch for on
  the FLW's phone screen, what mistakes are common at this step,
  what to say if a trainee gets stuck
- **stats** — what each number means in context (where it came from,
  what counts as exceeding it, what happens when you don't hit it)
- **exercise** — facilitation cues (how to form groups, how long to
  let people struggle, the answer to the most common confused question)
- **checklist** — which items trip people up, how to handle "I forgot"
- **timeline** — what counts as on/behind schedule, what to say
  if someone is far behind

## Output Format

Produce a single `spec.yaml` file with all placeholders filled. The file must:

1. Pass YAML syntax validation
2. Have every `@alias` reference match the screenshot manifest
3. Have a total slide count between 30 and 45
4. Have every slide with a non-empty `title`
5. Have every slide with a non-empty `notes` (50-150 words, trainer-voice)
6. Use only layouts from the 14 defined types above
7. Include `platform-setup` and `resources` as `ref:` includes, not inline copies
8. Cover slide subtitle = `"FLW Training"` only (no date — date renders separately via the `date:` field)
