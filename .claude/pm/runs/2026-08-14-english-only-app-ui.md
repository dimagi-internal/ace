# 2026-08-14 — English-only app UI: don't ship a convincing fake

## Lens

Jonathan asked a status question — *"can you check if nova added proper itext /
internationalization support?"* — and the answer set the work. It hadn't: live
`tools/list` against `mcp.commcare.app` returned **81 tools** (up from 63 on
2026-07-31) with **zero hits** for `itext` / `locale` / `i18n` / `translat`,
`update_app` down to `name` alone, and the architect's own 70k-char operating
prompt never mentioning language. The only language-shaped parameter on the
whole surface is `defaultLanguageCode` on messaging automations — the language
of an outbound SMS, not a form-label channel.

His call on hearing that: *"the multiple languages inline is a terrible solution
and it only makes sense to solve it correctly when truly localized. so for now,
update ace to only build in english."*

That is the lens, and it generalizes past localization: **when a platform can't
deliver a capability, ship the honest limited version — never a substitute that
looks like the capability.** The inline-stacking fallback (sanctioned 2026-07-30,
ace#968) tripled every label's reading load for exactly the low-literacy cohorts
the PDDs single out, AND reported the problem as solved, so nobody pushed
upstream for the real channel. The fake was worse than the absence.

## Do it

Three PRs merged, 0.13.860 → 0.13.869.

| PR | What |
|----|------|
| #1392 | The change: `localization-layer` → `english-only-ui`, `localization_match` → `language_conformance` (inverted), Table B row, Phase 1 guidance, downstream QA, the preventer test |
| #1398 | Residual sweep — `playbook/` and `CLAUDE.md` still called trilingual payloads ACE's norm |
| #1401 | Self-audit: my own unverified OCS-chatbot language claim, marked unmeasured |

Design calls worth recording:

- **The dimension INVERTED rather than disappearing** — kept at 8% with the same
  null-when-N/A, so no reweighting and every other calibration anchor stays
  valid. English-only is now full credit; systematic stacking is ≤3 → `fail`.
  The criteria say the inversion out loud, because a judge re-reading this
  rubric carries months of "English-only = fail" in its own priors.
- **Table B, not Table A.** CommCare has itext and HQ supports app languages —
  it is *ACE's builder* that is closed. The section's own evidence-discipline
  rule says over-claiming a platform constraint costs you the capability, and
  that section already shipped with exactly that error once.
- **Both calibration anchors amended, not deleted.** The ITN negative control
  required `localization_match ≤3 → fail` on an English-only build against a
  French PDD; that artifact now scores full credit there. Clause removed with
  the reason in place; the other three dimensions still force `fail`.

## Closed

- **#1391** — filed as the forward anchor, because #968 was CLOSED and its
  recorded resolution was the *opposite* decision, so every doc citing ace#968
  pointed at stale reasoning. #968 and #1181 carry pointer comments.

## Backlog

- **Measure the OCS chatbot in a non-English working language.** #1392 asserted
  it "answers in whatever language the worker types" — never measured. #1401
  marked it unmeasured; a live `ocs_send_test_message` probe would let the
  caveat come out. Load-bearing, because it is the answer to "where did the
  language support go?"
- **Existing trilingual apps now fail a re-eval.** Raised with Jonathan; he is
  rebuilding them, so no grandfather clause was added.

## Meta-observations

- **A status question is a lens.** "Did Nova add itext?" looked like a lookup.
  Answering it *at the source* — live `tools/list`, not the docs, not the
  session's possibly-stale MCP subprocess — produced the evidence that made the
  decision obvious. The docs' own claim ("re-confirmed 2026-07-31 across all 63
  live tools") was still true and still worth re-checking; the tool count had
  moved 29% since.
- **The revert direction was the cheap one, so it needed a test.** The retired
  instruction lived in four skills, two rubrics and a component brief. And
  because the dimension inverted rather than disappeared, a stale rubric line
  does not fail loudly — it silently grades every *correct* build as broken.
  `test/skills/english-only-ui.test.ts` was negative-controlled (restored the
  old instruction and the old dimension name, confirmed red) before being
  trusted green.
- **Sweep width is a real failure mode.** The first pass covered `skills/`,
  `agents/`, `templates/`, `commands/`, `docs/superpowers/`, `test/`, `lib/` —
  and missed `playbook/` and `CLAUDE.md`, both read at the start of every
  session. Found only because "good to close out?" was asked a second time.
- **Self-audit caught what review would have.** The unverified OCS claim was
  mine, written in the same PR that added rules about not predicting other
  systems' behavior. Worth re-reading your own diff against the conventions you
  just cited.
