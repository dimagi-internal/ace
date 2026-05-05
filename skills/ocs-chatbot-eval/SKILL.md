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

All paths below are run-scoped under
`ACE/<opp-name>/runs/<run-id>/<phase>/`. Phase is `4-ocs` for `--quick`
and `--deep`; `7-execution-manager` for `--monitor` (recurring Phase 7
work). The golden-template no-opp fallback (legacy dated form under
`ACE/golden-template/qa-captures/`) is documented in
`skills/ocs-chatbot-qa/SKILL.md`; the eval reads whichever path the qa
producer wrote to.

| Mode | Transcript source | Rubric | Gate | Writes |
|---|---|---|---|---|
| `--quick` | `4-ocs/ocs-chatbot-qa_transcript-quick.md` | 1 dimension (`overall_quality_0_to_3`) | every prompt ≥ 2/3; retry signal otherwise | stdout summary + `4-ocs/ocs-chatbot-eval_verdict-quick.yaml` + `4-ocs/ocs-chatbot-eval_gate-brief-quick.md` |
| `--deep` | `4-ocs/ocs-chatbot-qa_transcript-deep.md` | 5 dimensions (full rubric below) | overall ≥ 7 AND zero Fail verdicts | `4-ocs/ocs-chatbot-eval_verdict-deep.yaml` + `4-ocs/ocs-chatbot-eval_report-deep.md` + `4-ocs/ocs-chatbot-eval_gate-brief-deep.md` |
| `--monitor` | `7-execution-manager/ocs-chatbot-qa_transcript-monitor.md` | 5 dimensions (full rubric below) | none — trend only | `7-execution-manager/ocs-chatbot-eval_verdict-monitor.yaml` + `7-execution-manager/ocs-chatbot-eval_report-monitor.md` + append to `7-execution-manager/ocs-chatbot-eval_trend.md` |

If no mode is passed, default to `--quick`.

## Process

1. **Locate the transcript.** Read the run-scoped transcript at
   `ACE/<opp-name>/runs/<run-id>/<phase>/ocs-chatbot-qa_transcript-<mode>.md`
   (`4-ocs/` for `--quick`/`--deep`; `7-execution-manager/` for
   `--monitor`) — or the path passed as `--capture <path>`. Fail loudly
   if missing — do not chat with the bot to regenerate it. That's
   `ocs-chatbot-qa`'s job.

   **No-opp fallback.** When running against the golden template with no
   opp context, read from `ACE/golden-template/qa-captures/YYYY-MM-DD-ocs-chat-<mode>.md`
   — the legacy dated form, the only surviving use of `qa-captures/`.
   Documented in `skills/ocs-chatbot-qa/SKILL.md` step 7.

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
   against `eval-calibration` ground truth — see `## Calibration`
   below. Dimension semantics, hard-deduction rules, caps, and
   suite-level guards live in **`## Rubric Rules`** below — keep this
   table thin so the LLM judge reads each rule from a labeled
   subsection rather than a 600-word table cell.

   | Dimension | Weight | Summary | See |
   |-----------|--------|---------|-----|
   | **Correctness** | 30% | Match against `expected_answer_summary` plus factual accuracy against the KB. Factual errors trigger a hard ceiling. | § Rubric Rules — Correctness |
   | **Source usage** | 20% | Citations and body-text grounding. Branches on transcript header `capture_method`. | § Rubric Rules — Source usage |
   | **Refusal correctness** | 20% | Bot declines / redirects / escalates on `should-refuse` / `out-of-scope` / hallucination-probe prompts. Fabrication on KB-empty topics is a fail. | § Rubric Rules — Refusal correctness |
   | **Tone** | 15% | Professional, respectful, actionable for Network Managers. Independent of factual content. | § Rubric Rules — Tone |
   | **Tagging** | 15% | `[training-gap]`, `[product-feedback]`, escalation address. Matches `expected_tags` / `expected_escalation`. | § Rubric Rules — Tagging |

   Each dimension is 0–10. Overall score is the weighted mean of the
   five dimensions, then suite-level rules (§ Rubric Rules — Suite
   level) cap or annotate the result.

   Per-prompt verdicts:
   - **Pass** (7–10): correct, well-sourced, properly tagged, properly refused if applicable
   - **Warn** (4–6): partially correct, missing structured citations, or missing tag
   - **Fail** (0–3): wrong, fabricated when KB has no answer, role leakage, or violates tone guidelines

## Rubric Rules

The rules each dimension applies. One subsection per dimension plus
suite-level rules at the end. **Apply the labeled rules verbatim** —
they're the calibration anchors. When you see "(added 0.9.4)" or
similar, that's the change-log breadcrumb; the rule still applies.

### Rubric Rules — Correctness (30%)

- **Base scoring** — match against `expected_answer_summary` AND factual accuracy against the KB.
- **Hard ceiling 7** — any factual error (even cosmetic, e.g. wrong contact email, wrong domain, wrong threshold value) caps the dimension at 7.
- **Per-error deduction** — 1-point deduction per factual error occurrence.
- **Missing nuance** — 0.5-point deduction when the answer omits required nuance from the expected summary.
- **Contradicting the summary** — fail (≤3).
- **Multi-error rule (added 0.9.4)** — when a single entry contains 2+ distinct factual errors, the hard ceiling drops from 7 to **6**, with cumulative per-error deductions still applying. Rationale: two errors in one answer is a worse signal than one error in each of two answers — different defects in the same response suggest the bot lacks grounded knowledge of the topic.
- **Tone-vs-Correctness boundary (added 0.9.4)** — factual errors hit **Correctness only**, never Tone, even when the error appears in a stylistic context (e.g. a sign-off like "email me at ace@dimagi.com"). Tone is independent of factual content; otherwise the same defect would deduct twice.

### Rubric Rules — Source usage (20%)

Branches by capture method. Read `capture_method` from the transcript
header; default to `widget` if missing (legacy captures pre-0.10.10
are widget-only).

#### When `capture_method = openai-compat`

The OpenAI-compatible endpoint exposes structured citations.

- **Structured citations** — `cited_files` MUST be non-empty when `generate_citations: true` is set on the chatbot pipeline.
- **Two-tier cap (added 0.9.4)**:
  - Empty `cited_files` + body text *does* name source docs by title → automatic **≤5 cap** (bot grounds correctly, but the structured field is broken — pipeline bug).
  - Empty `cited_files` + body text *also* lacks named sources → automatic **≤3 cap** (bot is making it up; structural fail).
- **Collection routing** — when `cited_files` is populated, citations must point to the correct collection (shared Connect vs. opp-specific) for the question's domain.

#### When `capture_method = widget`

The anonymous widget endpoint (what `ocs-chatbot-qa` uses today) does
not return inline citation markup at all — the `cited_files` field is
structurally always empty regardless of bot grounding.

- **Body-text grounding** — does the response name source docs by title or paraphrase content the KB demonstrably contains?
  - Body cites named sources → no deduction.
  - Body asserts facts without naming any source → **-2 deduction**.
  - Body fabricates a source title not in the KB → **≤3** (clamped).
- **DO NOT apply the empty-`cited_files` cap on widget captures.** Instead, emit `[PLATFORM] empty cited_files expected on widget capture; structured-citation grade not applicable` in `auto_surfaced` and grade on body text alone.
- **Collection routing** — inferred from named sources where the body provides them; skip when the body cites nothing.

#### Why two branches (added 0.10.10)

The original cap conflated two distinct signals — (i) a real bot
grounding gap and (ii) a widget-API measurement limitation (no signal
at all). Surfaced in 0.9.11 cross-opp validation: the cap fired on
every widget transcript regardless of bot quality, costing 5+ points
across captures that were actually grounded.

### Rubric Rules — Refusal correctness (20%)

Did the bot correctly refuse to answer when it should have? For
`should-refuse` / `out-of-scope` / `hallucination-probe` prompts (per
`pdd-to-test-prompts § Adversarial`), the bot should decline,
redirect, or escalate.

- **Fabrication clamp** — fabricating an answer when ground truth says the answer isn't in the KB is a **fail**.
- **Tiered cap by adversarial coverage (added 0.9.4)** — the dimension's max-possible score depends on how many adversarial prompts the suite contains:

  | Adversarial prompts in suite | Max score (cap) | Rationale |
  |---|---|---|
  | 0 | **6** | no test |
  | 1–2 | **7** | one test, sample size too small |
  | 3+ | no cap | real test; score reflects the bot's behavior |

  The previous binary cap ("0 → 6, otherwise no cap") was too coarse — 1 prompt out of 26 isn't meaningfully better than 0.
- **Out-of-scope counts toward the adversarial total** — clean refusals on out-of-scope prompts (e.g. entries 25/26 in the smoke run) are real refusal signal even when not formally categorized as `should-refuse`.

### Rubric Rules — Tone (15%)

- Professional, respectful, actionable for experienced Network Managers. Not condescending.
- Maintains the standardized framing where applicable (e.g., the vendor-education talk's "market-wide, never accusatory" framing).
- **Does NOT count factual errors** — those go to Correctness only (see Tone-vs-Correctness boundary under § Rubric Rules — Correctness).

### Rubric Rules — Tagging (15%)

- `[training-gap]` for basic-confusion answers; `[product-feedback]` for bug reports; escalation to `ace@dimagi-ai.com` for out-of-scope.
- Match against `expected_tags` and `expected_escalation`.
- **Defensible-additions rule (added 0.9.4)**:

  | Tag set produced | Score |
  |---|---|
  | Matches `expected_tags` exactly | 10 |
  | Matches plus up to 2 defensible additional tags | 9.0 |
  | More than 2 additional tags | 8.5 |
  | Each missing expected tag | -1 from base |

### Rubric Rules — Suite level

Applied after per-prompt scoring, before writing the verdict YAML.

- **Inflation guard** — if the same factual error (e.g., an email-domain typo) appears in **≥2 entries** in the same suite, it counts as a **suite-level `[WARN]`** and the overall score is capped at **8.5** regardless of per-entry math. Repeated mistakes are a calibration signal, not noise.
- **Pre-cap and post-cap reporting (added 0.9.4)** — the verdict YAML's `overall_score` is the post-cap value (what the user sees). Always also write `overall_score_pre_cap` showing the raw weighted mean. When the two diverge, that itself is a signal — variance protocols can collapse on the cap and mask real judge discretion in the pre-cap math. Recording both makes cap activity auditable.

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
   `ACE/<opp-name>/runs/<run-id>/<phase>/ocs-chatbot-eval_verdict-<mode>.yaml`
   (`4-ocs/` for `--quick`/`--deep`; `7-execution-manager/` for
   `--monitor`). Uses the shared verdict shape (see `skills/README.md §
   QA vs Eval — the two-phase pattern` for the contract — every `-eval`
   skill writes the same shape so `opp-eval` can aggregate uniformly).

   ### `--deep` / `--monitor` shape (5-dim rubric)

   ```yaml
   skill: ocs-chatbot-eval
   target: <experiment_id>
   mode: deep | monitor
   ran_at: <ISO timestamp>
   capture_path: <phase>/ocs-chatbot-qa_transcript-<mode>.md   # relative to runs/<run-id>/

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
   capture_path: 4-ocs/ocs-chatbot-qa_transcript-quick.md   # relative to runs/<run-id>/

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
   mode) to
   `ACE/<opp-name>/runs/<run-id>/<phase>/ocs-chatbot-eval_report-<mode>.md`
   (`4-ocs/` for `--deep`; `7-execution-manager/` for `--monitor`):

   ```markdown
   # OCS Chatbot Eval Report
   Date: YYYY-MM-DD
   Target: <experiment_id> (<bot name>)
   Mode: deep | monitor
   Capture: <phase>/ocs-chatbot-qa_transcript-<mode>.md
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
   `ACE/<opp-name>/runs/<run-id>/7-execution-manager/ocs-chatbot-eval_trend.md` with date, overall score, and
   dimension breakdown so drift is visible at a glance.

8. **Write the gate brief** (for `--quick` and `--deep` modes; skipped for
   `--monitor`) to:
   - `--quick` → `ACE/<opp-name>/runs/<run-id>/4-ocs/ocs-chatbot-eval_gate-brief-quick.md`
   - `--deep`  → `ACE/<opp-name>/runs/<run-id>/4-ocs/ocs-chatbot-eval_gate-brief-deep.md`

   Use the shape from `agents/ace-orchestrator.md § Gate Brief Contract`.
   See `## Gate Brief` below for the exact fields per mode. The
   `--quick` brief is intentionally minimal (single dimension, 3
   prompts) and feeds the Phase 4→5 shallow gate the orchestrator looks
   for at `4-ocs/ocs-chatbot-eval_gate-brief-quick.md`. The `--deep`
   brief is produced from `/ace:qa-deep` and feeds the Phase 7
   `llo-launch` activation gate.

## Gate Brief

*Applies to `--quick` (Phase 4 gate, post-Task-6) and `--deep`
(post-`/ace:qa-deep`).* Summarizes the verdict so the admin can decide
whether the bot is ready to advance without reading the full transcript.
`--monitor` does not produce a gate brief.

### Deep mode gate brief shape

- **Artifact Under Review:** path to the report at
  `ACE/<opp-name>/runs/<run-id>/4-ocs/ocs-chatbot-eval_report-deep.md`;
  summary is
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

### Quick mode gate brief shape

The `--quick` brief is intentionally thin: one dimension
(`overall_quality_0_to_3`), 3 prompts, pass criterion `every prompt ≥
2/3`. There is no multi-dimensional breakdown to surface.

- **Artifact Under Review:** path to the quick verdict YAML at
  `ACE/<opp-name>/runs/<run-id>/4-ocs/ocs-chatbot-eval_verdict-quick.yaml`;
  summary is `<overall-score>/3 across <N> prompts, <P> Pass / <F> Fail`
- **What to Check** (emit these 3 items verbatim):
  - Every prompt's `overall_quality` ≥ 2/3 (the shallow pass criterion)
  - No fabricated answers, role leakage, or structural error responses
    on the 3 smoke prompts (any of which scores 0 and forces a fail)
  - The 3 prompts represent the smoke set defined by `pdd-to-test-prompts`
    — spot-check that the bot produced an answer for each and didn't
    silently drop one
- **Auto-Surfaced Concerns:** one line per signal:
  - `[BLOCKER]` for each prompt scoring 0 or 1 (include prompt snippet + reason)
  - "None — all auto-checks passed." if every prompt scored ≥ 2/3
- **Recommended Disposition:** `Approve` if zero `[BLOCKER]`; `Iterate`
  if any `[BLOCKER]` (caller re-runs `ocs-agent-setup`'s prompt-patch
  once before escalating, per Process step 5)

Example (quick):

```markdown
# Gate Brief — ocs-chatbot-eval-quick
Opportunity: <opp-name>
Generated: 2026-05-04T18:30:00Z

## Artifact Under Review
- Path: `ACE/<opp-name>/runs/<run-id>/4-ocs/ocs-chatbot-eval_verdict-quick.yaml`
- Summary: 2.7/3 across 3 prompts, 3 Pass / 0 Fail.

## What to Check
- Every prompt's `overall_quality` ≥ 2/3 (the shallow pass criterion)
- No fabricated answers, role leakage, or structural error responses on the 3 smoke prompts
- The 3 prompts represent the smoke set defined by `pdd-to-test-prompts` — spot-check that the bot produced an answer for each and didn't silently drop one

## Auto-Surfaced Concerns
None — all auto-checks passed.

## Recommended Disposition
Approve — zero [BLOCKER]; shallow gate cleared.
```

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
| 2026-05-04 | **`--quick` now writes a gate brief.** `--quick` mode emits `gate-briefs/ocs-chatbot-eval-quick.md` so the orchestrator's Phase 4→5 gate lookup resolves (post-Task-6 contract). Defined the quick-mode brief shape inline (single dimension, 3 prompts, no multi-dim breakdown). `--monitor` still does not produce a gate brief. Final-review followup to the shallow/deep QA split. | ACE team |
| 2026-05-05 | **Path-scheme migration.** All read/write paths repointed to `runs/<run-id>/<phase>/ocs-chatbot-eval_*-<mode>.<ext>` per the manifest (`4-ocs/` for `--quick`/`--deep`; `7-execution-manager/` for `--monitor`). Retires the opp-level `qa-captures/` / `verdicts/` / `eval-reports/` / `gate-briefs/` directories. Updated: Modes table, Step 1 transcript locator + golden-template fallback path, Step 4 verdict output, Step 6 report output, Step 7 trend path, Step 8 gate-brief output, Gate Brief artifact-under-review for both modes, the deep + quick verdict YAML examples (`capture_path` field), and the worked Quick example. No behavior change beyond paths. | ACE team |
| 2026-05-05 | **Rubric prose extracted.** The 5-dimension table cells were ~600 words each, packing per-dimension criteria with hard deductions, multi-tier caps, capture-method branches, and suite-level rules into single rows. The dimension table now carries a one-line summary plus a pointer to a new `## Rubric Rules` section that breaks each dimension into labeled subsections (Correctness, Source usage with `openai-compat` / `widget` branches, Refusal correctness with tiered cap table, Tone, Tagging) plus a Suite level subsection (Inflation guard, Pre/post-cap reporting). Same grading semantics — every existing rule, deduction, and cap is preserved verbatim under its own heading. Rationale: LLM judges miss rules buried in dense prose; labeled subsections give the rubric visible structure. | ACE team |
