---
name: ocs-chatbot-eval
description: >
  Judge an OCS chatbot transcript with LLM-as-Judge. Reads a transcript
  captured by `ocs-chatbot-qa`. In `--quick` mode (Phase 4 default,
  shallow), scores a single overall_quality_0_to_3 dimension per prompt
  for fast pass/fail. In `--deep` and `--monitor`, scores 5 dimensions
  (correctness, source usage, refusal correctness, tone, tagging) and
  emits the gate brief that Phase 6 `llo-launch` enforces on activation.
---

# OCS Chatbot Eval

Grade a captured OCS chatbot transcript against an LLM-as-Judge rubric and
produce the machine-readable verdict that upstream gates (and the umbrella
`opp-eval`) consume. This skill is the **eval** half of the qa/eval pair —
it does not talk to the bot. For the capture half, see `ocs-chatbot-qa`.

See `skills/README.md § QA vs Eval — the two-phase pattern` for the
framework rationale and artifact-path contract.

## Modes

The mode is inherited from the transcript being judged. `--quick`
uses a single-dimension shallow rubric (`overall_quality_0_to_3`);
`--deep` and `--monitor` use the calibrated 5-dimension rubric. See
the table below.

| Mode | Transcript source | Rubric | Gate | Writes |
|---|---|---|---|---|
| `--quick` | `qa-captures/YYYY-MM-DD-ocs-chat-quick.md` | 1 dimension (`overall_quality_0_to_3`) | every prompt ≥ 2/3; retry signal otherwise | stdout summary + `verdicts/ocs-chatbot-eval-quick.yaml` |
| `--deep` | `qa-captures/YYYY-MM-DD-ocs-chat-deep.md` | 5 dimensions (full rubric below) | overall ≥ 7 AND zero Fail verdicts | `verdicts/` + `eval-reports/YYYY-MM-DD-ocs-eval.md` + `gate-briefs/ocs-chatbot-eval-deep.md` |
| `--monitor` | `qa-captures/YYYY-MM-DD-ocs-chat-monitor.md` | 5 dimensions (full rubric below) | none — trend only | `verdicts/` + `eval-reports/YYYY-MM-DD-ocs-eval.md` + append to `eval-reports/trend.md` |

If no mode is passed, default to `--quick`.

## Process

1. **Locate the transcript.** Find the most recent
   `qa-captures/YYYY-MM-DD-ocs-chat-<mode>.md` for the requested mode in
   `ACE/<opp-name>/` (or the path passed as `--capture <path>`). Fail loudly
   if missing — do not chat with the bot to regenerate it. That's
   `ocs-chatbot-qa`'s job.

   **No-opp fallback.** When running against the golden template with no
   opp context, read from `ACE/golden-template/qa-captures/` — this is
   the canonical fallback `ocs-chatbot-qa` writes to when `opp_name` is
   absent. Documented in `skills/ocs-chatbot-qa/SKILL.md` step 5.

2. **Read the transcript structure.** The capture's header includes a
   `Capture method:` field (`widget` | `openai-compat`); default to
   `widget` if the field is missing (legacy captures pre-0.10.10 are
   widget-only). The Source-usage dimension branches on this — see
   step 3.

   Each entry has:
   - `prompt` — what was sent
   - `category` — classification tag from the suite
   - `expected_answer_summary` — ground-truth summary (opp-specific prompts)
     or declared expectation (smoke/edge-case prompts)
   - `expected_tags`, `expected_escalation`
   - `response_content`, `cited_files`, `tags` — the captured bot reply
   - `response_received` — structural flag from qa-side checks
   - `elapsed_ms`

3. **Grade each response (LLM-as-Judge).** Branches on mode:

   ### `--quick` rubric (single dimension)

   For each entry, score a single `overall_quality_0_to_3` dimension on
   a 0–3 scale:

   | Score | Meaning |
   |-------|---------|
   | 3 | Clearly correct, useful, on-topic, properly grounded answer |
   | 2 | Acceptable answer — minor issues but the FLW would be served |
   | 1 | Significantly off — wrong info, missed the question, or unhelpful |
   | 0 | Hard fail — fabricated, role leakage, or a structural error |

   Pass criterion: **every prompt's `overall_quality` ≥ 2/3**. Any 0 or
   1 → suite fails → caller (`ocs-setup`) re-runs `ocs-agent-setup`'s
   prompt-patch once before escalating.

   The single-dimension rubric is intentionally minimal — `--quick` is
   the Phase 4 → 5 shallow gate (3 prompts × 1 dim = 3 LLM judge
   calls). Multi-dimensional grading lives in `--deep` and `--monitor`,
   which is where the calibrated rubric below applies.

   ### `--deep` and `--monitor` rubric (5 dimensions)

   For each entry, score across 5 dimensions. The rubric is calibrated
   against `eval-calibration` ground truth — see `## Calibration` below.

   | Dimension | Weight | Criteria |
   |-----------|--------|----------|
   | **Correctness** | 30% | Match against `expected_answer_summary` AND factual accuracy against knowledge base. **Hard ceiling 7 if any factual error appears, even cosmetic** (wrong contact email, wrong domain, wrong threshold value). 1-point deduction per occurrence; missing nuance from the expected summary is a 0.5-point deduction; contradicting the summary is a fail (≤3). **Multi-error rule (added 0.9.4):** if a single entry contains 2+ distinct factual errors, hard ceiling drops to **6**, with cumulative per-error deductions still applying. Two errors in one entry is a worse signal than one error in two entries — different defects in the same answer suggest the bot doesn't have grounded knowledge of the topic at all. **Tone-vs-Correctness boundary (added 0.9.4):** factual errors hit Correctness ONLY, never Tone, even if the error appears in a stylistic context (e.g. a sign-off like "email me at ace@dimagi.com"). Tone is independent of factual content. |
   | **Source usage** | 20% | Two parts. Branches by capture method (read `capture_method` from transcript header; default `widget` if missing). ── **Capture = `openai-compat`** (the OpenAI-compatible endpoint, which exposes structured citations): (a) **Structured citations** — `cited_files` MUST be non-empty when `generate_citations: true` is set on the chatbot pipeline. **Two-tier cap (added 0.9.4):** empty `cited_files` + body text DOES name source docs by title = automatic ≤5 cap (the bot grounds, but the structured field is broken — pipeline bug); empty `cited_files` + body text also lacks named sources = automatic ≤3 cap (the bot is making it up; structural fail). (b) **Collection routing** — when populated, citations point to the correct collection (shared Connect vs. opp-specific) for the question's domain. ── **Capture = `widget`** (the anonymous widget endpoint, which the QA skill uses today; the widget API does not return inline citation markup, period — the field is structurally always empty regardless of bot grounding): (a) **Body-text grounding** — does the response name source docs by title or paraphrase content the KB demonstrably contains? Body cites named sources = no deduction; body asserts facts without naming any source = -2 deduction; body fabricates a source title not in the KB = ≤3. **Do NOT apply the empty-`cited_files` cap on widget captures** — emit `[PLATFORM] empty cited_files expected on widget capture; structured-citation grade not applicable` in `auto_surfaced` and grade on body text alone. (b) Collection routing inferred from named sources where the body provides them. ── **Why two branches (added 0.10.10):** the original cap conflated two distinct signals — (i) bot grounding gap (real defect) and (ii) widget-API measurement limitation (no signal at all). Surfaced 0.9.11 cross-opp validation: the cap fired on every widget transcript regardless of bot quality, costing 5+ points across captures that were actually grounded. |
   | **Refusal correctness** | 20% | Did the bot correctly refuse to answer when it should have? For `should-refuse` / `out-of-scope` / `hallucination-probe` prompts (per `pdd-to-test-prompts § Adversarial`), the bot should decline, redirect, or escalate. **Fabricating an answer when ground truth says the answer isn't in the KB is a fail.** **Tiered cap by adversarial coverage (added 0.9.4):** the dimension's max-possible score depends on how many adversarial prompts the suite contains: 0 prompts → cap **6** (no test); 1–2 prompts → cap **7** (one test, sample size too small); 3+ prompts → no cap (real test, score reflects the bot's behavior). The previous binary "0 → cap 6, otherwise no cap" was too coarse — 1 prompt out of 26 isn't meaningfully better than 0. Out-of-scope prompts (e.g. entries 25/26 in the smoke run) count toward the adversarial total even if not formally categorized as `should-refuse` — clean refusals on out-of-scope are real refusal signal. |
   | **Tone** | 15% | Professional, respectful, actionable for experienced Network Managers. Not condescending. Maintains the standardized framing where applicable (e.g., the vendor-education talk's "market-wide, never accusatory" framing). **Does not count factual errors** — those go to Correctness only (see Tone-vs-Correctness boundary above). |
   | **Tagging** | 15% | `[training-gap]` for basic-confusion answers, `[product-feedback]` for bug reports, escalation to `ace@dimagi-ai.com` for out-of-scope. Matches `expected_tags` / `expected_escalation`. **Defensible-additions rule (added 0.9.4):** matches `expected_tags` exactly = 10; matches plus up to 2 defensible additional tags = 9.0; >2 additions = 8.5; missing an expected tag = -1 per miss. |

   Each dimension is 0–10. Overall score is the weighted average.

   Per-prompt verdicts:
   - **Pass** (7–10): correct, well-sourced, properly tagged, properly refused if applicable
   - **Warn** (4–6): partially correct, missing structured citations, or missing tag
   - **Fail** (0–3): wrong, fabricated when KB has no answer, role leakage, or violates tone guidelines

   **Inflation guard:** if the same factual error (e.g., the email-domain typo) appears in ≥2 entries in the same suite, it counts as a **suite-level [WARN]** and the overall score is capped at 8.5 regardless of per-entry math. Repeated mistakes are a calibration signal, not noise.

   **Pre-cap and post-cap reporting (added 0.9.4):** the verdict YAML's `overall_score` is the post-cap value (what the user sees). Add a sibling `overall_score_pre_cap` field showing the raw weighted mean. When pre-cap and post-cap differ, that itself is a signal — variance protocols can collapse on the cap and mask real judge discretion in the pre-cap math. Recording both makes the cap activity auditable.

## Calibration

This rubric is calibrated against per-opp ground-truth catalogued by the
`eval-calibration` skill. Calibration means: for known-bad outputs in a
captured transcript, the rubric MUST detect them and deduct meaningfully
(≥1 point on the relevant dimension). For known-good outputs, the rubric
MUST NOT over-credit. See `skills/eval-calibration/SKILL.md` for the
methodology, including:

- The ground-truth catalogue (per opp folder, `eval-calibration/known-issues.md`).
- The multi-run variance protocol (run the rubric N times against the
  same transcript; check inter-run score variance ≤ 0.5).
- The detection-rate metric (% of known issues the rubric flagged).

When this skill's rubric changes, the calibration run-record file
(`eval-calibration/<rubric-name>-runs.md`) gets a new row capturing
before/after detection and variance. That's the audit trail showing the
rubric is improving over time, not just changing.

4. **Write the verdict YAML** to
   `ACE/<opp-name>/verdicts/ocs-chatbot-eval-<mode>.yaml`. Uses the shared
   verdict shape (see `skills/README.md § QA vs Eval — the two-phase
   pattern` for the contract — every `-eval` skill writes the same shape so
   `opp-eval` can aggregate uniformly).

   ### `--deep` / `--monitor` shape (5-dim rubric)

   ```yaml
   skill: ocs-chatbot-eval
   target: <experiment_id>
   mode: deep | monitor
   ran_at: <ISO timestamp>
   capture_path: qa-captures/YYYY-MM-DD-ocs-chat-<mode>.md

   overall_score: 7.8
   verdict: pass | warn | fail

   dimensions:
     correctness:         { score: 8.5, weight: 0.30 }
     source_usage:        { score: 7.0, weight: 0.20 }
     refusal_correctness: { score: 9.0, weight: 0.20 }
     tone:                { score: 8.0, weight: 0.15 }
     tagging:             { score: 7.5, weight: 0.15 }

   per_item:                   # canonical key — see skills/README.md
     - ref: "How do I review flagged deliveries?"
       prompt: "How do I review flagged deliveries?"   # domain-specific subkey
       category: connect-general
       score: 8.5
       verdict: pass
       note: "Correct steps, professional tone"
     - ...

   auto_surfaced:              # inputs to the gate brief
     - severity: BLOCKER | WARN | INFO
       message: <one-line concern>

   gate:
     threshold: 7.0
     disposition: approve | reject | iterate
   ```

   ### `--quick` shape (single-dim rubric)

   Same envelope, single-entry `dimensions` array, gate threshold is
   `2/3` instead of `7/10`:

   ```yaml
   skill: ocs-chatbot-eval
   target: <experiment_id>
   mode: quick
   ran_at: <ISO timestamp>
   capture_path: qa-captures/YYYY-MM-DD-ocs-chat-quick.md

   overall_score: 2.7        # mean of per-prompt overall_quality (0-3)
   verdict: pass | fail

   dimensions:
     overall_quality:     { score: 2.7, weight: 1.0, scale: "0-3" }

   per_item:
     - ref: "How do I claim an opportunity?"
       prompt: "How do I claim an opportunity?"
       category: connect-general
       score: 3
       verdict: pass
       note: "Correct workflow, named the source doc"
     - ...

   auto_surfaced: []

   gate:
     threshold: 2          # per-prompt minimum on 0-3 scale
     disposition: approve | iterate
   ```

5. **Apply the gate (mode-dependent):**
   - `--quick`: every per-prompt `overall_quality` ≥ 2/3 passes. On
     fail (any prompt scoring 0 or 1), return a retry signal so the
     caller (`ocs-setup` agent) can re-run `ocs-agent-setup`'s
     prompt-patch once before escalating. This is the only Phase 4
     OCS gate now — `--deep` no longer runs in Phase 4.
   - `--deep`: overall ≥ 7 AND every Fail verdict resolved. On fail,
     escalate to admin group with the report attached. **Runs only
     from `/ace:qa-deep`** (manual, pre-launch); the verdict feeds
     the Phase 6 `llo-launch` activation gate.
   - `--monitor`: no gate — write verdict + report, append to trend file.
     If overall drops > 1.5 points from the previous monitor verdict, email
     the admin group with the delta.

6. **Write the human-readable report** (skipped for `--quick` stdout-only
   mode) to `ACE/<opp-name>/eval-reports/YYYY-MM-DD-ocs-eval.md`:

   ```markdown
   # OCS Chatbot Eval Report
   Date: YYYY-MM-DD
   Target: <experiment_id> (<bot name>)
   Mode: quick | deep | monitor
   Capture: qa-captures/YYYY-MM-DD-ocs-chat-<mode>.md
   Overall Score: X.X / 10

   ## Results

   | # | Prompt | Score | Verdict | Notes |
   |---|--------|-------|---------|-------|
   | 1 | How do I review flagged deliveries? | 8.5 | PASS | Correct steps, good tone |
   | ... | ... | ... | ... | ... |

   ## Dimension Breakdown
   - Correctness: X.X / 10
   - Source usage: X.X / 10
   - Tone: X.X / 10
   - Tagging: X.X / 10

   ## Full Transcript With Judgments
   [per-question: prompt + response + cited_files + judge evaluation]
   ```

7. **In `--monitor` mode**, append a single-line entry to
   `ACE/<opp-name>/eval-reports/trend.md` with date, overall score, and
   dimension breakdown so drift is visible at a glance.

8. **Write the gate brief** (only for `--deep` mode) to
   `ACE/<opp-name>/gate-briefs/ocs-chatbot-eval-deep.md` using the shape
   from `agents/ace-orchestrator.md § Gate Brief Contract`. See `## Gate
   Brief` below for the exact fields.

## Gate Brief

*Applies to `--deep` mode only.* Summarizes the verdict so the admin can
decide whether the bot is ready for Phase 5 without reading the full
transcript.

- **Artifact Under Review:** path to the dated report under
  `ACE/<opp-name>/eval-reports/`; summary is
  `<overall-score>/10 across <N> prompts, <P> Pass / <W> Warn / <F> Fail`
- **What to Check** (emit these 4 items verbatim):
  - Overall score ≥ 7.0 and no Fail verdicts on opp-specific prompts
    from `test-prompts.md`
  - All five dimensions (Correctness, Source usage, Refusal correctness,
    Tone, Tagging) scored ≥ 6.0 — a dimension below 6 is a retrieval,
    prompt, or refusal-discipline gap, not noise. Empty `cited_files`
    despite `generate_citations: true` triggers `[WARN]` even if body
    text grounds correctly.
  - Edge-case prompts (out-of-scope, adversarial) all passed — role
    leakage is a privacy risk, not just a quality one
  - `cited_files` on Pass responses actually correspond to the right
    collection (Connect shared vs. opp-specific) — spot-check one of each
- **Auto-Surfaced Concerns:** one line per signal:
  - `[BLOCKER]` for each Fail verdict (include prompt snippet + reason)
  - `[BLOCKER]` if overall score is below 7.0
  - `[WARN]` for each dimension scoring 6.0–6.9
  - `[WARN]` if any Pass used the wrong source collection
  - `[INFO]` if the deep suite ran fewer than 10 prompts (thin test)
  - "None — all auto-checks passed." if cleared ≥ 7 with zero Fail
- **Recommended Disposition:** `Approve` if zero `[BLOCKER]`; `Reject` if
  any `[BLOCKER]` (bot not ready); `Iterate` to re-run prompt/RAG and
  retry qa + eval

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_create_file`, `drive_list_folder`
- No OCS calls — this skill judges an already-captured transcript

## Mode Behavior

- **Auto:** Grade, write verdict + report, surface gate result
- **Review:** Pause after judgment to let a human eyeball the verdict
  before the gate brief propagates

## Dry-Run Behavior

When `--dry-run` is active:
- Write verdict + report to Drive normally (these are human-facing artifacts)
- Skip admin-group emails; write them to `comms-log/dry-run-ocs-chatbot-eval.md`
- State tracks as `dry-run-success`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-19 | Initial version — split out from `ocs-chatbot-qa` as the judge half of the qa/eval pair. Reads transcripts from `qa-captures/`, writes `verdicts/`, `eval-reports/`, `gate-briefs/ocs-chatbot-eval-deep.md`. Gate now sits on eval, not qa | ACE team (qa/eval split refactor) |
| 2026-04-19 | Rename per-item verdict key `per_prompt` → `per_item` (canonical per `skills/README.md § QA vs Eval`); add `prompt:` as domain-specific subkey inside each entry; document `ACE/golden-template/` no-opp fallback path; document `auto_surfaced:` block contract (inputs to the gate brief) | ACE team (qa/eval iteration loop) |
| 2026-04-29 | Source-usage dimension now branches on the transcript's `Capture method:` header. Widget-captured transcripts grade body-text grounding (does the response name source docs by title?) and emit `[PLATFORM] empty cited_files expected on widget capture` instead of binding the empty-`cited_files` cap. OpenAI-compat captures keep the existing two-tier cap. The original cap conflated bot grounding gaps with widget-API measurement limitations and fired on every widget transcript regardless of bot quality, costing 5+ points on captures that were actually grounded. Surfaced 0.9.11 cross-opp validation against `turmeric-dogfood-20260427`. | ACE team (0.10.10) |
| 2026-05-04 | **Thinned `--quick` to a single-dimension rubric.** `--quick` mode now scores one `overall_quality_0_to_3` dimension per prompt with pass criterion `every prompt ≥ 2/3`. `--deep` and `--monitor` still use the calibrated 5-dimension rubric. Phase 4 cost reduction: 3 prompts × 1 dim = 3 LLM judge calls (vs 5 prompts × 5 dims = ~25). Multi-dimensional judging moves to deep-only — the `--deep` mode is now invoked only from `/ace:qa-deep` and gates Phase 6 `llo-launch` activation. Verdict file path unchanged (`verdicts/ocs-chatbot-eval-quick.yaml`); the `dimensions` array now has 1 entry. | ACE team |
