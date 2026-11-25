# Connect Helper

Connect Helper is an AI assistant that talks with Connect Workers in their program's PersonalID
messaging channel. It answers Connect Workers who write in to their program: general questions about the work and the app, help finishing Learn, help claiming an opportunity, and friendly check-ins with workers who have gone quiet. It is a Claude Code agent on the **canopy agent operating model**.

## How a conversation reaches it
1. A Connect Worker's message reaches Connect Labs, the system of record. Labs' Messaging router
   picks the program's playbook, whose handler is `{kind: agent, agent: connect-helper, skill: <approach>}`.
2. Labs opens one canopy contact session per thread on the host site `connect-messaging`, with
   session metadata `x_skill`, `x_thread`, `x_program` and `x_playbook`, and sends the worker's
   text with a signed **Worker Brief** (the turn's `host_context`).
3. Canopy runs `/connect-helper:worker-chat`. It reads the brief, loads the approach skill, reads more
   through the contact-scoped worker tools only when it needs to, records facts and outcomes, and
   ends with the reply.
4. The turn's final prose is relayed to the worker. No tool sends a message.

## Skills
- `worker-chat` — the entry for every contact turn.
- `general-help` — the `general-help` playbook (inbound): A question about the work, the app, visits, tasks or payments.
- `learn-support` — the `learn-support` playbook (inbound): The worker asks for help with Learn.
- `learn-support` — the `learn-stalled` playbook (outbound): Labs opened the thread because the worker's Learn has stalled.
- `claim-help` — the `claim-help` playbook (outbound): The worker finished Learn and has not claimed yet.
- `checkin` — the `inactive-checkin` playbook (outbound): The worker has not been active for a while.

The fleet skills the factory stamps (`turn`, `answer-caller`, `agent-turn-review`,
`task-tracker`, `shipping`, `manager-sync`, `setup`) serve the agent's own operators.

## Worker tools (served by labs, bound by canopy to the one worker)
`worker_profile`, `worker_timeline`, `worker_threads`, `worker_thread`, `worker_history_search`, `worker_tasks`, `worker_learn`, `worker_visits`, `worker_payments`, `worker_facts`, `worker_fact_record`, `worker_fact_retract`, `thread_record_outcome`, `thread_handoff`, `thread_close`. They are called through `site_tools` / `site_call` / `site_read` on `connect-messaging`;
the playbook's `tools` list narrows them further per conversation.

## Canopy-web configuration
- Host-site entry `connect-messaging`: entry `/connect-helper:worker-chat`, `contact_scoped: true`,
  Claude Code tools `Read`, `Skill`, `ToolSearch`, canopy's `who_is_asking`, `site_tools`,
  `site_call`, `site_read`; ceiling = the worker tools above.
- An access line giving the site's contacts `read_only`.

## Tests and evals
`tests/scenarios/*.json` are the evals every release must pass against a live contact turn:
agree then plan, a credible dispute (recorded `disputed`, no commitment pushed), a safety
disclosure (handed off), and a prompt-injection attempt inside a worker's message.
`python -m pytest -q tests` keeps them well formed and pins the rules they depend on.

## Run and ship
Secrets, if any, live in the agent's Canopy vault (`/connect-helper:setup`). Ship by branch, PR and merge;
`config/gating.json` refuses any send path, because the reply is the turn's final prose.
