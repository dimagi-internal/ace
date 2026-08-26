---
name: upstream-regression-triage
description: >
  Find which upstream change broke a working integration. Use when a call that
  worked before now fails, and ACE's own code on that path is unchanged.
disable-model-invocation: false
---

# Upstream Regression Triage

ACE talks to five systems it does not own. They ship continuously — OCS merged
24 PRs in the five days around 2026-08-18 — and a change in any of them can
break an ACE call path that has not been touched in months.

**This skill exists because that failure is invisible to code reading.** The
symptom is "it worked on Thursday, it fails today, and `git log` on our side is
empty", and the natural conclusion from reading ACE's code is *"nothing here is
wrong, so this is blocked on a live probe."* That conclusion is usually wrong
and always expensive: it parks a `blocks-e2e` defect behind a surface visit
nobody schedules. The answer is normally sitting in a merged upstream PR that
takes about five minutes to find.

**Do not confuse this with `systematic-debugging`.** That asks "what is wrong
with this code?" This asks "what changed *underneath* this code, and when?" —
so the primary evidence is a diff in someone else's repo, not a trace in ours.

## Inputs

| Input | Where from | Required |
|---|---|---|
| The failing symptom, verbatim | run log, issue body, error payload | yes |
| **Last-known-good evidence** — an artifact of the same kind that worked, with a timestamp | Drive run folder, OCS/Connect object created earlier, a prior green run | yes — without it there is no window |
| First-known-bad timestamp | the failing run | yes |
| The ACE call path — the exact function that makes the failing call | `mcp/<system>/backends/*.ts` | yes |
| Prior triage verdicts on the same symptom | the issue's comments | no |

## Products

One markdown verdict, written to the run folder when a run is in flight
(`<N>-<phase>/upstream-regression_<system>.md`) or attached as an issue comment
when triaging out of band. It states, in this order:

1. the window (last-known-good → first-known-bad), with the evidence for each end
2. the suspect PR — number, title, merge date, and the **file in upstream source
   that confirms the mechanism**, not just the PR title
3. which side owns the fix: ACE adapts, or upstream regressed
4. if ACE adapts: the exact change. If upstream: the reproducer to send them
5. the one live observation that would falsify the conclusion

## Process

1. **Confirm ACE's side is actually unchanged.** If our code on that path moved
   in the window, this is an ordinary regression — stop and use
   `superpowers:systematic-debugging` instead.

   ```bash
   git log --since=<last-known-good> --oneline -- mcp/<system>/ lib/<helper>.ts
   git log -L <start>,<end>:mcp/<system>/backends/playwright.ts | head -40
   ```

   "Unchanged since April" is the strongest possible signal that the cause is
   upstream. Record it — it is what justifies the rest of this procedure.

2. **Establish the window, and make both ends evidence.** A window with a guessed
   left edge produces a suspect list nobody can trust. The left edge is a
   *thing that worked*: an OCS chatbot cloned on the 14th that still answers, a
   Connect opp created last week that still reads back, a green run log. Name
   the object and its timestamp.

3. **Resolve the upstream repo.** Verified reachable 2026-08-18 — all public,
   all readable with the ambient `gh` auth, no extra token:

   | System | Repo | ACE surface |
   |---|---|---|
   | Open Chat Studio | `dimagi/open-chat-studio` | `mcp/ocs/` |
   | CommCare Connect | `dimagi/commcare-connect` | `mcp/connect/` (`connect_*`) |
   | CommCare HQ | `dimagi/commcare-hq` | `mcp/connect/backends/commcare.ts` |
   | Nova | `voidcraft-labs/commcare-nova` | `mcp/` via the nova plugin |
   | Connect Labs | `dimagi-internal/connect-labs` | `connect-labs` MCP |

   Do not guess a slug — `dimagi/commcare-nova` does not exist, and a 404 here
   reads as "no upstream changes" if you are not paying attention.

4. **List what merged in the window.**

   ```bash
   gh pr list --repo <upstream> --state merged --limit 100 \
     --search "merged:<good-date>..<bad-date>" \
     --json number,title,mergedAt -q '.[] | "\(.mergedAt[:10]) #\(.number) \(.title)"' | sort
   ```

   Read every title. The list is normally 10–30 items and this is the cheapest
   step in the skill.

5. **Filter by blast radius, and be strict about it.** Map the failing call to the
   upstream subsystem it actually touches, then discard PRs that cannot reach it.
   Getting this wrong is the main way this procedure produces a confident wrong
   answer.

   Worked example: ACE reaches an OCS chatbot through the **anonymous embedded
   widget** (`/api/chat/start/` with `public_id` + `embed_key`). So OCS #4198
   "Pin OAuth applications to the chatbots they may reach" — a perfect-looking
   suspect, and the top hit on title alone — is **out of scope**, because it
   gates `chatbots:interact` for OAuth client-credentials apps and ACE does not
   use that surface. Establish which API surface you are on *before* ranking.

6. **Rank by the discriminator, not by plausibility.** Ask what differs between
   the thing that works and the thing that fails. Almost always it is
   **new-vs-existing**: a newly created object fails where an older one of the
   same kind succeeds. That points hard at *creation-path* changes and away from
   runtime changes, because a migration usually backfills existing rows into the
   safe state while new writes take the new default.

7. **Confirm the mechanism in upstream source. Never stop at the PR title.**

   ```bash
   gh pr diff <n> --repo <upstream>
   gh api repos/<upstream>/contents/<path> -q .content | base64 -d
   ```

   A title is a hypothesis. The claim you are allowed to make is the one you can
   point at a line for. Trace it all the way to the call site that runs on ACE's
   path — a form field is not enough; find the view or wrapper that saves it.

8. **Decide who owns the fix.**
   - **ACE adapts** — upstream made a legitimate change and ACE's call is now
     under-specified (a new required field, a renamed param, a new default).
     Fix it here, with a test naming the upstream PR.
   - **Upstream regressed** — behaviour changed in a way no caller could have
     anticipated. File there with the two-object control (the working old one,
     the failing new one), and record the ACE-side workaround if there is one.

9. **State the falsifier.** One observation that would prove you wrong. If you
   cannot name one, you have a story rather than a diagnosis.

## Recurring upstream-change classes

Check these first — each has already cost a run.

- **The Django checkbox trap.** A `BooleanField` added to a `ModelForm`'s
  `Meta.fields` is rendered as a checkbox, and **a checkbox absent from POST data
  resolves to `False`** — the model's `default=True` does not apply once the form
  owns the field. So a new field with a safe default silently flips every
  hand-built POST that predates it, while the migration backfills existing rows
  to the safe value. Signature: *new objects broken, existing objects fine.*
  Seen twice — OCS #4202 added `enabled` to `ChannelForm` and every widget
  channel ACE created came up disabled (ace#1492); and the read-side twin, where
  a valueless checked checkbox extracts to `''` and is misread (ace#1491).
- **A new required field on a create form.** Same shape, louder failure — usually
  a 400 with an `errorlist`, so easier to spot than the checkbox case.
- **Permission/allowlist tightening.** "Empty means none" migrations. Signature:
  everything breaks at once, including the control — which is what distinguishes
  it from the checkbox class.
- **A renamed or removed API field.** Read-backs silently degrade rather than
  erroring; a field starts reading as `''`/`false` forever.
- **Model/provider deprecation.** An LLM or integration provider is retired
  upstream; anything pinned to it fails while everything else is fine.

## MCP Tools Used

None. This skill is `gh` + `git` against public repos, deliberately — the
evidence is upstream source, and no ACE MCP surface can see it.

## Mode Behavior

- `--quick` — steps 1–5 only: confirm our side is unchanged, produce the ranked
  suspect list, stop. Use inside a live run to decide whether to keep going.
- default — full procedure through the verdict, no writes to upstream.
- `--file` — additionally open the ACE issue (or comment on the existing one)
  per `CLAUDE.md § File ACE issues mid-run`, including the search-first rule.

Never opens an upstream issue or PR without explicit operator approval —
that is an outward-facing action against another team's tracker.

## Related skills

`superpowers:systematic-debugging` owns "what is wrong with this code"; this
skill owns "what changed underneath it". `skills/shipping` ships whatever
ACE-side adaptation this concludes with.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-08-18 | Created. Motivated by ace#1492, where three separate triages concluded "blocked on a live OCS probe" while the cause — OCS #4202 adding `enabled` to `ChannelForm.Meta.fields`, merged 2026-08-17 — was readable in a public diff the whole time. Repo table verified reachable the same day. | ACE |
