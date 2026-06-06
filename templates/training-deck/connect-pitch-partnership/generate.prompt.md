# Pitch Deck Generation Prompt — Connect Partnership Pitch

You are generating a pitch deck spec for a prospect organization not yet on Connect. The output is a fully populated `spec.yaml` file that the rendering pipeline will convert into a Google Slides presentation.

**Key difference from training decks:** This deck is prospect-facing, not FLW-facing. The audience is a decision-maker at a prospect org who has never seen Connect. The goal is to earn a follow-up meeting or a pilot commitment — not to train anyone. Every slide must earn its place in the business case.

## Input Sources

Read these artifacts from the opportunity's Drive folder (`ACE/<opp>/`) or the video production run folder:

1. **Prospect research doc** (`research/deep-research.md` or the Google Doc at `source.pdd_doc_id`) — the primary source of truth for this deck. Extract: prospect org name, program type, geographic coverage, target population, scale (staff count, beneficiary count, annual visit volume), existing data systems, pain points, leadership names/titles. **`source.pdd_doc_id` must be set to this document's Drive fileId** — it is the provenance anchor for the deck. There is no PDD for a prospect (this is pre-engagement); the research doc fills the `pdd_doc_id` role.
2. **Connect-fit analysis** (`research/connect-fit.md`) — the assessed alignment between the prospect's program model and Connect's value proposition. Extract: the strongest fit signals, the biggest risk/friction factor, the recommended entry archetype.
3. **Angles manifest** (`angles.yaml`) — the three pitch angles vetted for this prospect, with a `chosen: true` flag on the selected angle. **The deck arc MUST mirror the chosen angle.** If the video used `day-in-the-life`, the deck opens in the field. If `the-scale-gap`, the deck opens with the reach/quality tension. If `trust-travels`, the deck opens with a proof-of-concept story. Read `angles.yaml` before drafting any module.
4. **Micro-demo screenshot manifest** (`research/demo-manifest.yaml` or `video/screenshot-manifest.yaml`) — available `@alias` references for the proof module's walkthrough slide. Every `@alias` used in the spec MUST exist in this manifest. If the manifest is empty or not yet generated, omit the `proof` module's walkthrough image and use layout `content` instead.
5. **run_state.yaml** (`<run>/run_state.yaml`) — run metadata. Extract: `run_id`, `generated_at` timestamp.

## Token Reference

All `{{TOKENS}}` in `spec.template.yaml` must be filled before the spec is valid. Key tokens:

| Token | Fill from |
|-------|-----------|
| `{{PROSPECT_SLUG}}` | Kebab-case prospect org name (e.g. `global-health-partners`) |
| `{{PROSPECT_NAME}}` | Prospect org display name (≤ 28 chars for cover stencil fit) |
| `{{PROGRAM_NAME}}` | Prospect's program name (e.g. "Community Health Worker Program") |
| `{{GENERATED_AT}}` | ISO 8601 timestamp from `run_state.yaml` |
| `{{RESEARCH_DOC_ID}}` | Drive fileId of the prospect research doc — this fills `source.pdd_doc_id` (required by schema; research doc is the provenance anchor for a prospect pitch) |
| `{{RUN_ID}}` | run_id from `run_state.yaml` |
| `{{COMMON_MANIFEST}}` | Record of common image aliases (e.g. `{connect-logo: drive:<id>}`) or `{}` if none |
| `{{OPP_MANIFEST}}` | Record of prospect/demo image aliases from the screenshot manifest, or `{}` if none |
| `{{DURATION}}` | Estimated deck duration in minutes as a number (e.g. `12`) |
| `{{LANGUAGE}}` | Language code (e.g. `en`) |
| `{{DATE}}` | Month + year of the pitch (e.g. `"June 2026"`) |

## Module-by-Module Content Instructions

### opening

- **cover**: Use prospect org name as title. **HARD CONSTRAINT: title ≤ 28 characters.** Subtitle should be a one-line hook from the chosen angle (e.g. `"Scaling community health with verified pay"`, `"From reach to quality"`, `"What happens when FLWs are paid to succeed"`). The `date:` field gets the month + year.

### their-world

Two slides that establish the prospect's context before introducing Connect.

- **their-context** (`content`): Title = the prospect org's mission in ≤ 8 words (e.g. `"Reaching 500 000 mothers in rural Bihar"`). Body: 2-3 sentences describing their program — who they employ, what those workers do, where they operate. **GROUNDING RULE: every fact must trace to the research doc.** Never invent staffing numbers, coverage areas, or beneficiary counts. If the research doc does not specify a number, write it in plain prose without a number (e.g. "thousands of community health workers" not "12 000 CHWs").
- **their-reach** (`stats`): Title = `"{{PROSPECT_NAME}}'s Scale"` or similar. Use 2 stats drawn from the research doc — e.g. worker count + beneficiary count, or visit volume + geography. **Prefix any unsourced or estimated value with `[TBD] `.** Do NOT invent stats; if the research doc has only 1 verified number, emit 1 stat (stats schema accepts 1).

### the-thesis

- **thesis-divider** (`section`): A short phrase (≤ 24 chars) that names the core tension the chosen angle builds on. Examples: `"The Quality Gap"`, `"The Scale Paradox"`, `"Proof Travels Far"`. This is the moment the deck pivots from their world to the opportunity.
- **thesis-content** (`content`): Title = a direct statement of what Connect unlocks for them (e.g. `"Verify quality. Pay on outcomes."`). Body: 2-3 sentences explaining the expansion thesis — Connect lets orgs like theirs pay FLWs for verified, counted work, creating a self-reinforcing quality loop. Mirror the chosen angle's language.

### how-connect-works

- **connect-lifecycle** (`timeline`): Title = `"The Connect Lifecycle"` or similar. Four steps in order: Learn → Deliver → Verify → Pay. Each `detail:` should be 1 sentence explaining what happens in that phase from the FLW's perspective. Keep technical jargon out — the audience is program staff, not engineers.

### proof

- **micro-demo** (`walkthrough`): Title = `"See It in 60 Seconds"` or similar. Body: 2-3 sentences describing what the screenshot shows — which step of the Connect flow, what the FLW is doing, what data is being captured. `image:` must be an `@alias` that exists in the screenshot manifest. If no screenshot is available, switch layout to `content` and describe the demo moment in prose (note this in the `notes:` field so the presenter knows to add a screenshot before finalizing).

### business-case

Two slides that make the financial and operational case.

- **outcomes** (`stats`): Title = `"What Programs Report"` or similar. 2-3 stats drawn from Connect platform data, the connect-fit analysis, or published research cited in the research doc. Examples: verification rate, time-to-payment reduction, FLW retention increase. **Every stat must be sourced.** Prefix unsourced values with `[TBD] `.
- **why-connect** (`two_column`): Title = `"Why Connect, Why Now"`. Left column = the friction they have today (high heading + 2-3 sentences naming the specific pain from the research doc). Right column = what Connect changes (heading + 2-3 sentences). Match tone to the chosen angle: `day-in-the-life` → focus on FLW experience; `the-scale-gap` → focus on quality at scale; `trust-travels` → focus on verified outcomes as trust-building.

### the-ask

- **closing** (`closing`): Title = `"Let's Build This Together"` or a variant that matches the chosen angle's tone. Body: 2-3 sentences naming the concrete next step — what you're asking the prospect to commit to (a pilot design call, a 3-month pilot, a site visit) + who to contact + the timeline. **Name Dimagi and Connect explicitly** — this is a branded ask, not a generic CTA. Only include the prospect's name if it's been used throughout the deck.

## Arc Coherence — Mirror the Video

The video and the deck are the SAME story in two formats. The chosen angle in `angles.yaml` defines the narrative spine:

- **day-in-the-life**: Open in the field → show what the FLW's day looks like → reveal how Connect changes that day → close with the prospect seeing their FLWs in that story.
- **the-scale-gap**: Open with the reach/quality tension → name the gap → show how Connect closes it → close with a data-backed call to pilot.
- **trust-travels**: Open with a proof story → generalize to the prospect's context → show the mechanism → close with the prospect joining the cohort.

Check: does the chosen thesis-divider title name the angle's core tension? Does the their-context slide use the angle's framing? Does the closing CTA resolve the tension opened at the top? If any slide breaks the arc, revise it.

## Grounding Rules (load-bearing for a prospect-facing deck)

1. **Every cited stat traces to the research doc or the connect-fit analysis.** No invented numbers. If a number is not in those docs, write it as prose or prefix with `[TBD] `.
2. **Dimagi chrome only.** The deck may reference Connect, CommCare, and Dimagi by name. Do not invent partner org names, program names, or geography that aren't in the inputs.
3. **Prospect name and logo only.** Use the prospect's actual name from the research doc. Do not invent a logo alias — only reference `@alias` keys that exist in the screenshot/opp manifest.
4. **No backstory inflation.** Don't invent "a long history of community health work" or "10 years of innovation" unless the research doc says it. Short, sourced, direct.

## Layout Selection Rules

| Layout | When to use |
|--------|-------------|
| `cover` | Opening slide — title + subtitle hook + date |
| `section` | Narrative pivot point — the-thesis divider only |
| `content` | Mission/context description, thesis statement, fallback for unavailable screenshots |
| `stats` | Prospect scale numbers, Connect outcome data — max 3 items; each needs `big` + `label` |
| `timeline` | The 4-step Connect lifecycle |
| `walkthrough` | Single micro-demo screenshot + caption body |
| `two_column` | Today vs. Connect side-by-side comparison |
| `closing` | The ask — title + body CTA |

Default to `content` when uncertain.

## Output Format

Produce a single `spec.yaml` with all `{{TOKENS}}` filled. The file must:

1. Pass YAML syntax validation.
2. Have `archetype: partnership-pitch` and `voice.audience: prospect`.
3. Have `source.pdd_doc_id` set to the research doc's Drive fileId (not a placeholder — fill it from the actual fileId before emitting).
4. Have a total slide count between 10 and 12. Add or remove optional slides (e.g. `their-reach` stats slide) to stay in range — but never drop cover or closing.
5. Have every slide with a non-empty `title` and non-empty `notes` (50-150 words, addressed to the presenter in second person).
6. Have every `@alias` reference match an entry in the screenshot/opp manifest.
7. Mirror the chosen video angle's arc end-to-end.
8. Have every cited stat sourced to a specific doc — no invented numbers.
