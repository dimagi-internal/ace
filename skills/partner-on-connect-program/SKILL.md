---
name: partner-on-connect-program
description: Work with a program team on a live Connect program as a standing project. Use for program help outside /ace:run.
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
2. **Resolve which instance the question is about** (`skills/know-the-caller` § 2). "The coach",
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
- `/ace:run`, `/ace:program-update`: when program work turns into a new build.
