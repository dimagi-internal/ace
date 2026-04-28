---
name: ocs-chatbot-eval
description: >
  Judge an OCS chatbot transcript with LLM-as-Judge. Reads a transcript
  captured by `ocs-chatbot-qa`, scores each response across 4 dimensions
  (correctness, source usage, tone, tagging), writes a verdict YAML and
  human-readable report, and emits the Phase 4 gate brief in --deep mode.
---

# OCS Chatbot Eval

Grade a captured OCS chatbot transcript against an LLM-as-Judge rubric and
produce the machine-readable verdict that upstream gates (and the umbrella
`opp-eval`) consume. This skill is the **eval** half of the qa/eval pair —
it does not talk to the bot. For the capture half, see `ocs-chatbot-qa`.

See `skills/README.md § QA vs Eval — the two-phase pattern` for the
framework rationale and artifact-path contract.

## Modes

The mode is inherited from the transcript being judged. The same 4-dimension
rubric applies in every mode; what changes is suite size and gate behavior.

| Mode | Transcript source | Gate | Writes |
|---|---|---|---|
| `--quick` | `qa-captures/YYYY-MM-DD-ocs-chat-quick.md` | overall ≥ 7 passes; retry signal otherwise | stdout summary + `verdicts/ocs-chatbot-eval-quick.yaml` |
| `--deep` | `qa-captures/YYYY-MM-DD-ocs-chat-deep.md` | overall ≥ 7 AND zero Fail verdicts | `verdicts/` + `eval-reports/YYYY-MM-DD-ocs-eval.md` + `gate-briefs/ocs-chatbot-eval-deep.md` |
| `--monitor` | `qa-captures/YYYY-MM-DD-ocs-chat-monitor.md` | none — trend only | `verdicts/` + `eval-reports/YYYY-MM-DD-ocs-eval.md` + append to `eval-reports/trend.md` |

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

2. **Read the transcript structure.** Each entry in the capture has:
   - `prompt` — what was sent
   - `category` — classification tag from the suite
   - `expected_answer_summary` — ground-truth summary (opp-specific prompts)
     or declared expectation (smoke/edge-case prompts)
   - `expected_tags`, `expected_escalation`
   - `response_content`, `cited_files`, `tags` — the captured bot reply
   - `response_received` — structural flag from qa-side checks
   - `elapsed_ms`

3. **Grade each response (LLM-as-Judge).** For each entry, score across 5
   dimensions. The rubric is calibrated against `eval-calibration` ground
   truth — see `## Calibration` below.

   | Dimension | Weight | Criteria |
   |-----------|--------|----------|
   | **Correctness** | 30% | Match against `expected_answer_summary` AND factual accuracy against knowledge base. **Hard ceiling 7 if any factual error appears, even cosmetic** (wrong contact email, wrong domain, wrong threshold value). The bot writing `ace@dimagi.com` instead of `ace@dimagi-ai.com` is a 1-point Correctness deduction per occurrence; same for any other concrete factoid the bot got wrong. Missing nuance from the expected summary is a 0.5-point deduction; contradicting the summary is a fail (≤3). |
   | **Source usage** | 20% | Two parts: (a) **Structured citations** — the API `cited_files` field MUST be non-empty when `generate_citations: true` is set on the chatbot pipeline. Empty `cited_files` is automatic ≤5 in this dimension regardless of body-text grounding. (b) **Collection routing** — when populated, citations point to the correct collection (shared Connect vs. opp-specific) for the question's domain. |
   | **Refusal correctness** | 20% | Did the bot correctly refuse to answer when it should have? For `should-refuse` / `out-of-scope` / `hallucination-probe` prompts (per `pdd-to-test-prompts § Adversarial`), the bot should decline, redirect, or escalate. **Fabricating an answer when ground truth says the answer isn't in the KB is a fail.** For non-adversarial prompts, score from the bot's behavior on the closest analog prompts in the suite. **Critical default:** when the suite contains **zero** adversarial prompts, this dimension caps at **6** (warn), not 10. Refusal discipline that has never been tested is unmeasured, not perfect — and the weighted overall must reflect that gap, not silently credit it. The gate brief surfaces `[INFO] thin adversarial coverage` separately, but the score itself bites. (This rule was added in 0.9.1 after the 0.9.0 calibration run revealed the original "default to 10" was hiding 2.0 weighted points of inflation per run.) |
   | **Tone** | 15% | Professional, respectful, actionable for experienced Network Managers. Not condescending. Maintains the standardized framing where applicable (e.g., the vendor-education talk's "market-wide, never accusatory" framing). |
   | **Tagging** | 15% | `[training-gap]` for basic-confusion answers, `[product-feedback]` for bug reports, escalation to `ace@dimagi-ai.com` for out-of-scope. Matches `expected_tags` / `expected_escalation`. |

   Each dimension is 0–10. Overall score is the weighted average.

   Per-prompt verdicts:
   - **Pass** (7–10): correct, well-sourced, properly tagged, properly refused if applicable
   - **Warn** (4–6): partially correct, missing structured citations, or missing tag
   - **Fail** (0–3): wrong, fabricated when KB has no answer, role leakage, or violates tone guidelines

   **Inflation guard:** if the same factual error (e.g., the email-domain typo) appears in ≥2 entries in the same suite, it counts as a **suite-level [WARN]** and the overall score is capped at 8.5 regardless of per-entry math. Repeated mistakes are a calibration signal, not noise.

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
   `opp-eval` can aggregate uniformly):

   ```yaml
   skill: ocs-chatbot-eval
   target: <experiment_id>
   mode: quick | deep | monitor
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

5. **Apply the gate (mode-dependent):**
   - `--quick`: overall ≥ 7 passes. On fail, return a retry signal so the
     caller (`ocs-setup` agent) can re-run `ocs-agent-setup`'s prompt-patch
     once before escalating.
   - `--deep`: overall ≥ 7 AND every Fail verdict resolved. On fail,
     escalate to admin group with the report attached.
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
