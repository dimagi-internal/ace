# ace-web attribution — who a run is FOR

Shared contract for every ACE call that makes ace-web **start a run**: the
`fork` action (`skills/fork-run`) and the `seeded-run` action
(`agents/iterate-loop.md`, and any ad-hoc "start a fresh run" a session makes).
Linked from each of them; *enforced:* `test/skills/ace-web-attribution.test.ts`.

## The two identities

`ACE_WEB_PAT_TOKEN` is **ACE's own** ace-web token by default — `/ace:setup`
signs in to ace-web as `ace@dimagi-ai.com` and writes it. A call made with it
is made BY ACE. That is correct (ACE is the one doing the work), but on its
own it says nothing about the person who asked for the work.

So a run-starting call carries both:

| field | who | set by |
|---|---|---|
| `initiated_by` (run_state) | the authenticated caller — ACE, or a human using their own PAT | ace-web, from the token. Never sent. |
| `requested_by` (request body) | the human whose request this is | **you**, on every run-starting call |

Resolve `requested_by` from the source of the request, in this order:

1. **A canopy-started session** (emdash task name `c-…` / `cx-…`, or a prompt
   carrying `--caller <path>`): the asker in the caller envelope — the
   `who_is_asking` tool, or the `--caller` file's `who.contact.email` /
   `who.user.email`.
2. **An `/ace:turn` acting on a routed thread:** the act-tier sender of that
   thread (canopy-web's grant — `canopy caller tier` → `act` — is what lets them steer a run).
3. **An interactive session:** the operator at the keyboard —
   `git config user.email`.

If none of these yields an email, **stop and ask** rather than omitting the
field or guessing. An unattributed run is the failure this contract exists to
prevent.

## Why (2026-10-01)

Jonathan asked an interactive session for a fresh Spark run. It POSTed
`seeded-run` with ACE's token and no attribution, so ace-web recorded
`spark-facilitator/20261001-2208` as `initiated_by: ace@dimagi-ai.com`, and
canopy turn `2727e227…` showed the asker as contact `ace@dimagi-ai.com`.
No record anywhere said who wanted the run. (The same run also never executed:
canopy-web resolved ACE's own login as an outside contact and confined the
session to ask-only. That is fixed server-side. canopy-web now recognises an
agent's own login, and ace-web#845's `seeded-run` refuses up front with a 409
`run_actor_unresolvable` (code at `extras.code`) instead of returning a 202 for a
run that can't execute.)

## What ace-web does with it (ace-web#845)

- Records `requested_by` next to `initiated_by` in the run's `run_state.yaml`
  (omitted when unknown), on the ace-web session, and in the canopy session
  title (`… — requested by <email>`) and metadata.
- Echoes `initiated_by` and `requested_by` in the `seeded-run` 202 and the
  `fork` 201.
- Shows the run's creator as `<requested_by> (via ACE)`.
- Which callers count as agents is set by ace-web's `ACE_AGENT_IDENTITIES`
  (default `ace@dimagi-ai.com`). For an agent caller, a missing
  `requested_by` is recorded as nothing. That's why ACE never omits it.

`/ace:ace-web-pat-mint` is the other option: the call is then made under the
human's own name and `requested_by` defaults to them. Don't send a
`requested_by` that differs from a human token's owner. ace-web rejects it with
400 `requested_by_forbidden`.
