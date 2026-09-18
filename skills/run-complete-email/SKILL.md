---
name: run-complete-email
description: >
  Send a run's completion notice — what it produced, decided, and is unsure
  about, plus its summary link. Use at run close, or on any past run.
disable-model-invocation: false
---

# Run-complete email

When a run finishes, the people who care about it find out by being told, or
they don't find out. ACE already emails counterparts inside a run (`llo-invite`,
`llo-onboarding`, `llo-uat`, `timeline-monitor`); there was no message that says
**"your run is done, here is what came out of it."** This is that message.

## Two things it must do, and one it must not

**It must say what the run is unsure about.** A completion notice that lists only
deliverables invites no reply. Open questions and gates that did not pass are the
honest half, and they are what make a reply worth writing — which is the whole
point, because `inbox-triage` routes that reply straight back into the run.

**It must be re-sendable for a run that finished long ago.** The skill takes an
opp and a run-id; it does not depend on being invoked at the moment the run
closed. That is what lets it be used on the runs already sitting in Drive.

**It must not claim more than the run did.** Every link is one the run actually
produced — read from `run_state.yaml`'s `products` blocks, never assembled from a
naming convention. A phase that did not run is reported as not run, not omitted.
This is the same honesty rule the run-summary page and the Workbench replay hold
to: a reader who finds one overstated line stops trusting the rest.

## When to run

- **At run close.** `ace-orchestrator` invokes it after the last phase settles.
- **On demand,** via `/ace:run-complete-email <opp>[/<run-id>]`, for any run whose
  `run_state.yaml` exists. No requirement that the run reached Phase 10 — a run
  that stopped at Phase 4 gets an email that says so.

## Inputs (read from Drive)

| Source | Used for |
|---|---|
| `ACE/<opp>/runs/<run-id>/run_state.yaml` | phase statuses, per-phase `completed_at`, `products.*`, verdicts |
| `ACE/<opp>/runs/<run-id>/decisions.yaml` | what it chose, and which rows a human overrode |
| `ACE/<opp>/open-questions.md` | what it is unsure about (opp-level, survives runs) |
| `ACE/<opp>/opp.yaml` | display name |

Read `run_state.yaml` and `decisions.yaml` with the DEFAULT `text/plain` export —
they are Google Docs, and a `text/markdown` export escapes their YAML. Prose
(`open-questions.md`) uses `export_as="text/markdown"`. See
`skills/../docs/learnings/drive-prose-export.md` in ace-web for why.

## Output

One artifact: `ACE/<opp>/runs/<run-id>/run-complete-email.md` — a run-level file
at the run-folder root, alongside `run_state.yaml` and `decisions.yaml`.

Re-running overwrites it. The artifact is the body that was (or will be) sent, so
the comms record and the email agree.

## Process

### 1. Resolve the run

`resolve_opp_path` for the opp. When no run-id is given, `resolve_current_run_id`.
Abort with a clear message if `run_state.yaml` is absent — that is a folder that
is not a run, not an empty run.

### 2. Gather, and notice what is missing

Walk `phases.*`: which reached `done`, which are `error` / `partial`, which never
ran. Collect from each phase's `products` block only the links that are present.

Compute the run's elapsed time from the phase boundaries (first `started_at` to
last `completed_at`). ACE stamps phases reliably and steps almost never, so do not
try to report per-step timing — say the run took N hours, not that a skill took M
minutes you cannot source.

Collect every step whose `verdict` is `fail` / `warn`, and every open question.

### 3. Compose

Subject: `<Opp display name> — run <run-id> finished`

Body, in this order, because it is the order a reader cares about:

1. **One sentence** on what the run was for and whether it completed.
2. **What it produced** — one line per real deliverable, each a link. The
   run-summary URL first, since it is the page that holds everything else:
   `${ACE_WEB_BASE_URL}/opps/${ACE_WEB_WORKSPACE}/<opp>/runs/<run-id>/summary`
   (defaults `https://labs.connect.dimagi.com/ace` and `dimagi-team`).
3. **What it decided** — the overridden rows first (a human moved those), then
   a count of the defaults it applied unchallenged.
4. **What it is unsure about** — open questions, and any gate that did not pass,
   each in one line a non-ACE reader can act on. If there are none, say that
   plainly rather than dropping the section.
5. **The ask** — reply to this email. State that a reply is routed back into this
   run automatically, because a reader who thinks they are writing into a void
   does not write.

Plain sentences. No ACE jargon: "the design document", not "the PDD artifact";
"the step that checks it" not "the eval skill". A reader outside the ACE chain
is the audience.

### 4. Write the artifact

`drive_create_doc_from_markdown` to the run-folder root as
`run-complete-email.md`. Write it BEFORE sending, so a send that fails still
leaves the composed body behind to retry from.

### 5. Send

Delegate to `email-communicator` (send). Recipients:
- `--to` when the operator passed one.
- Otherwise the run's own `initiated_by`, falling back to the operator running
  the command.

**Never** default to an external counterpart. This message is an internal
"your run is done" notice; sending a run's rough edges to a partner is a
decision a human makes per-run, not a default this skill takes.

The send goes through `bin/ace-email` like every other ACE send — the rail is
hook-enforced, and approval is governed by the calling context (a turn's review
posture, a run's pause-point mode).

### 6. Record

Append the sent threadId to the run's comms log, so a reply can be routed back to
this run by `inbox-triage` rather than having to be matched by subject.

## Failure modes worth naming

- **A run with no products at all.** Send it anyway: "this run stopped at Phase N
  and produced nothing shareable" is exactly the message someone needs.
- **A fork.** A forked run's copied phases carry the source's `completed_at`, so
  the elapsed figure is meaningless. Detect `forked_from` and say the run was
  forked and from where, rather than reporting an elapsed time that is really the
  fork's own timestamp.
- **`open-questions.md` absent.** Not an error — older opps predate it. Say there
  are none recorded.
