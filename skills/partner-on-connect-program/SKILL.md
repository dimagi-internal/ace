---
name: partner-on-connect-program
description: Work with a program team on a live Connect program, including changes to what is live. Use for program help outside /ace:run.
---

# Partner on a Connect program

ACE is the program teams' AI partner for all things Connect, not only the builder of new
programs (Jon, 2026-10-07, when the Kangaroo Care team asked to work with ACE on Labs metrics
tooling). That work is ongoing, comes from several people, and outlives any single build.
So it is a **canopy project**, with ACE's knowledge of Connect layered on top.

This skill describes the extension. The project and task mechanics are fleet-wide: follow
`skills/task-tracker`, which reads canopy's `agent-core/task-tracker.md`, and
`skills/gdoc-writer` for deliverables. Do not re-implement either one here.

## A program project is not an opp

| | Program project (this skill) | ACE opp (`/ace:run`) |
|---|---|---|
| Subject | A live Connect program and its team | One new opportunity built from scratch |
| Lifetime | As long as the team works with ACE | One run, then frozen |
| State | canopy-web project + tasks; Drive `Projects/<name>/` | `ACE/<opp>/runs/<run>/run_state.yaml` |
| Human surface | The board, the threads, the deliverables | The run's ace-web page |
| Source context | The program context doc (below), read live | The frozen `inputs/` manifest |

**Bridge, don't merge.** When program work needs a new build (a new opportunity, or a fresh app
for a new partner), start a normal ACE opp: create `ACE/<opp>/inputs/` holding *shortcuts* to
the program's living docs, and run it through `/ace:run`. Then link that run's ace-web page to
the project. Program work never writes a `run_state.yaml`, and an opp never reads the project's
board. When asked about a run, read it through its ace-web page and artifacts. Don't
reconstruct it.

## The project

- **One project per program**, named as the team names the program, for example
  `Kangaroo Care`. The board project and the Drive folder share that one name (task-tracker
  § Projects). If a folder already exists under an old name, rename it to match rather than
  starting a second folder.
- **One task per thread of work** (a tool being built, a question being chased), filed into
  the project. **Owner** is the program-team person who owns the outcome.
- **Outcome** on the project says what the partnership is for right now, in the team's words.

## The program context doc

One Google Doc in the project folder, titled `<Program> — program context`. It holds only
**pointers and decisions**. Facts that live in another system go in as a link or an ID, never as
a copy. The team edits it. ACE appends decisions with the date and who made them, and never
rewrites what someone else wrote.

| Section | What goes in it | Preferred form (never stale) |
|---|---|---|
| Names | What the team calls the program and its parts, and any retired names | Plain text. Retired names are still searched for, never written in prose |
| Scope | Connect org(s) and program, opportunities in and out of scope, with the reason | Connect org slug + opportunity IDs |
| Apps | Learn/Deliver apps per opportunity, and which build counts | HQ domain + app ID, and "latest released" unless stated |
| AI coaches and bots | Every OCS bot the program uses (coaches, Q&A bots), what each is for, and which Labs reports trigger it | OCS team + bot id/public id per bot. There is rarely just one, so a question about "the coach" is resolved here first |
| Metrics | Indicator definitions, reports, cohorts | Labs registry, workflow and cohort IDs. A spreadsheet is the drafting space; the registry is the authority once adopted |
| Living docs | Design docs, protocols, the team's working sheets | Drive links shared with ace@dimagi-ai.com (commenter) |
| Decisions | What was decided, by whom, when | Dated lines. A decision made only in Slack or email reaches no future session unless it lands here |
| Data access | What ACE may read, and who approved it | One line per grant, with the owner's approval |
| People | Who is on the team and what each person owns | Names and emails |
| Builds | ACE opps and runs started for this program | ace-web run-page links |

## Every session

1. **Find the project.** `canopy agent projects --slug ace --active`, then read its tasks and
   the context doc. If the request doesn't map to a project, ask which program it is. Don't
   guess from an acronym.
2. **Resolve which instance the question is about.** "The coach",
   "the app" or "the report" means one of the program's instances in the context doc. Name it before
   answering, or ask. Never answer for ACE's generic template as if it were the program's.
3. **Re-read live only what the question needs.** Use the context doc's pointers:
   - the HQ app via the `commcare_*` atoms
   - the opportunity via the `connect_*` atoms
   - metrics via the `connect-labs` registry and workflow atoms
   - docs via Drive

   Search under the program's retired names too.
4. **Say what you read and when** in the answer. A dated snapshot from the folder is reference,
   never the source. The 2026-08-12 KC field audit, for example, describes the apps as they
   were that day.
5. **Write back.** Log the turn on the task (`canopy agent turn … --task T<N>`). Put
   deliverables on the project's links. Append any decision to the context doc.

## Changing a live program

Most requests a program team makes are changes to something already live: "add a question to
the Deliver form", "lower the pass mark", "the coach should mention X", "add a payment unit for
the follow-up visit". These are modifications to existing objects. They are **not** new builds.
Never route one into `/ace:run`, which creates a fresh opportunity and a fresh app and would
leave the partner with two of each.

**What counts as a change:** any write to an object listed in the context doc's Scope, Apps,
AI coaches and bots, or Metrics. That covers an app edit plus re-release, an opportunity's
verification flags, payment units, dates or budget, the Learn passing score, a bot's prompt,
knowledge or tools, a solicitation's fields, and a Labs workflow's opportunities or template.
Reading and answering are not changes.

**Procedure:**

1. **Name the object and its current state.** Resolve it from the context doc (§ Every
   session step 2), then read it live and record the before state: the field values, the app
   build number, the bot version.
2. **Check the platform's limits before proposing anything.** The playbook index
   (`playbook/README.md`, "how do I do X on surface Y") and the matching
   `playbook/integrations/<surface>.md` say which operations exist and which do not. The traps
   that make a plausible change wrong are:
   - **A `DeliverUnit` is shared across opportunities wired to the same released Deliver
     app** (ace#573). A payment unit cannot be bound to a deliver unit another opportunity
     already holds, and no atom deletes a payment unit. Adding or changing payment units on a
     live opportunity is constrained, so check before promising it.
   - **The Learn `passing_score` lives on the shared `CommCareApp` row** (ace#1350). Changing
     it with `connect_set_learn_passing_score` changes the gate for every opportunity in the
     org wired to that Learn app. Name those opportunities in the proposal.
   - **An opportunity's holding org is create-time only.** `target_organization_slug` cannot
     be changed (`connect_update_opportunity` has no org field). A wrong org means a new
     opportunity, which is a build, not a change.
   - **An app edit only reaches workers once it is released.** The path is a Nova edit
     (`nova:edit`, or the private-work atoms), upload to the **same** HQ app ID, re-apply the
     HQ settings, rebuild and release, then confirm the opportunity sees the new deliver units.
     Whether a live opportunity picks up a re-release on its own is not documented. Read it
     back rather than assuming it.
   - **An OCS bot's public link serves only the published version.** Republish after any
     prompt or knowledge change (`ocs-knowledge-refresh` covers knowledge).
3. **Propose the change with before and after.** One message to the requester or owner gives
   the object, its before state, the intended after state, what else it touches (other
   opportunities on the same app, workers mid-Learn, live Labs reports), and how it will be
   verified. The owner approves any outbound or shared act (manual-mode turns), and a change to
   a live opportunity or a released app is one. Program-team members can direct the work, but
   approval follows § Guardrails, Who steers.
4. **Make the change through the existing skills and atoms.** Don't hand-roll a procedure a
   skill already owns. Examples: `nova:edit` then `app-deploy` / `app-hq-settings` /
   `app-release` / `app-release-qa` for an app; the `connect_*` update atoms for an
   opportunity; `ocs-knowledge-refresh` or the `ocs_set_chatbot_*` atoms for a bot;
   `app-case-sharing` for case sharing. Where a skill still reads its IDs only from a run's
   artifacts, pass the IDs from the context doc and note the gap on the task.
5. **Verify against a fresh read.** Never trust the write's status alone: re-read the object
   and compare it with the agreed after state.
6. **Log it.** Append a dated line to the context doc's Decisions: what changed, the before
   and after values, who asked, who approved, and the evidence (a link or ID). Log the turn on
   the board task. A change that lands only in an email or a session reaches no future session.

A change too large to finish in one turn (an app edit plus release, a multi-step
reconfiguration) is dispatched to its own session with the project, the context-doc link and
the asks verbatim, the same way `inbox-triage` dispatches a run.

## When a build becomes a program project

A program ACE built through `/ace:run` becomes a program project **once it is live**, meaning
after Phase 9 go-live (`llo-launch`) has activated the partner's opportunity. From then on,
requests about it are program work under this skill, not steps of the run:

- Open the project (§ The project) if none exists, and seed its context doc's Scope, Apps and
  AI coaches and bots from the run's `run_state.yaml` products. Copy the IDs as pointers, not
  the artifacts.
- Put the run's ace-web page (`ace_web_summary_url`) in the context doc's Builds section, so
  the build history stays one click away.
- The run itself stays frozen. A change to the live program is never written back into that
  run's `run_state.yaml`. It is logged in the context doc's Decisions.

Before go-live the run still owns its objects, and changes go through the run (its pause points
or `/ace:step`).

## Guardrails

- **Data.** People may share with ACE only what they would share with their own AI assistant
  (owner, 2026-10-07). ACE runs in an ordinary Claude session with no extra data controls, and
  ZDR mode is reserved for Jon. Point people to that rule. Don't make up a stricter or looser
  one. What ACE's own accounts can reach is a separate question, so check it live, not from
  memory: on 2026-10-07 its Labs account could list the real KC programs through the Dimagi
  org, after an August write-up said it saw only synthetic copies. Granting ACE an account
  membership, for example adding `ace@dimagi-ai.com` to a program's Connect org, is the
  owner's decision. Record it in the context doc's Data access section.
- **Who steers.** Program-team members can direct the project's work. Outbound and shared acts
  need the owner's approval in a manual-mode turn: publishing or cloning in Labs, sharing a
  doc, emailing a partner, granting access. This follows `skills/explain-ace` § 2 and
  canopy-web's `docs/architecture/access.md`.
- **Documents shared with ACE.** Ask the person to share with `ace@dimagi-ai.com` as
  commenter. A Drive "file not found" for both of ACE's identities means the file hasn't been
  shared with ACE. It does not mean the file is gone.
- **No inferred backstory.** A target, threshold or scope rule that isn't in the context doc or a
  linked source is a question for the team, not a default.
- **Terminology.** Use the program's current names in everything a human reads. Identifiers
  (folder names, app files, slugs) stay as they are.

## Related skills

- `skills/task-tracker`: board and project mechanics.
- `skills/gdoc-writer`: publishing deliverables into `Projects/<name>/`.
- `skills/explain-ace`: interaction and security model questions.
- `skills/inbox-triage`: how inbound mail is routed to a program project (§ 2b) and handled as
  Program work (§ 2d).
- `playbook/README.md` and `playbook/integrations/*.md`: what each platform can and cannot do
  when changing a live object.
- `/ace:run`, `/ace:program-update`: when program work turns into a new build.
