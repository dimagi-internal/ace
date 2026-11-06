# Labs on a page — only as the person who sent

Shared rule for every ACE answer given in a canopy conversation **held on a
connect-labs page** (a workflow run page, the Data page, a marketplace round — the
Connect Labs agent panel). Linked from each skill that can run there; *enforced:*
`test/skills/labs-on-a-page.test.ts` (the links) and
`test/mcp/connect-labs/headers-helper.test.ts` (the helper).

Off a labs page, in someone's own Claude Code, the rule is [`_acting-as-you.md`](_acting-as-you.md) ("as me").

## How you know you are on one

The caller envelope has a `site` block naming `connect-labs` (canopy-web
`caller_context.site`; the hook prints "This conversation is held on a
connect-labs page"), and on a cloud runner the turn has `CANOPY_PAGE_SITE=connect-labs`.
It holds **whoever asked — ACE's owner and admins included** (owner decision,
2026-10-26).

## The rule

On a labs page you reach labs **only through canopy's gateway, as the person who
sent**, under the act-as-you permission they granted from the page (their host
grant). What they may see in labs is what you may see — never what ACE's own
account (`ace@dimagi-ai.com`) can.

1. `who_is_asking` — who sent, and whether they are verified.
2. `current_page` — what they are looking at. On a workflow run page its `filters`
   carry `definition_id`, `run_id` and the run's scope (`opportunity_id` OR
   `program_id`): call every workflow tool with that scope; `visible_ids` and
   `filters.drilled` are "these" / "this".
3. `site_tools` — the labs tools this page's grant reaches. Call them **only through
   `site_call`** (`site_read` for a `resource_link` a tool returned). A tool missing
   from `site_tools` is not available to this person on this page — say so, never
   route around it.
4. The page's own actions (`page_showQuery`, `page_proposeSave`, `page_openItem`,
   `page_showVisit`, …) are **canopy's** tools, not labs': call them directly
   (`ToolSearch` loads one not yet in your list), never through `site_call`.

## Writing to labs from a page: you propose, they confirm

A write on a labs page is never yours to make: it is proposed through `site_call` →
`workflow_edit_propose` and saved only when the person clicks Confirm on the card
canopy shows them, as them. On a marketplace round page the proposals are:

- `marketplace_reviews_write` — `{round_slug, reviews: [...], summary_url?}`: the
  round's whole batch of AI reviews in one proposal (each review is a `create_review`
  input: `response_id`, `criteria_scores`, `claims`, `outcome`, `flags`, `ask_next`,
  `provenance`). Labs checks every review as the save would (quotes found in the
  answer, its own flags and outcomes) and refuses the proposal, writing nothing, if
  any fails — fix what it names and propose again. Never call `create_review` one by
  one from a page: it is not in the page's permission.
- `marketplace_round_criteria_set` — a round's criteria, same card.

After proposing, say what it will do and stop: the person confirms in the chat. A
proposal this page's permission does not cover comes back refused; say so — do not look
for another way in. Reads on a round page (`reviews:read`): `marketplace_round_responses`,
`list_reviews`, `get_review`, `marketplace_round_scores`.

## What you never do there

- **Never call the native `connect-labs` MCP** (`mcp__plugin_ace_connect-labs__*`,
  `mcp__connect_labs__*`). On a page turn canopy withholds ACE's own labs token
  (`LABS_MCP_TOKEN`) and `scripts/labs-auth-headers.mjs` sends no credential, so it is
  unauthenticated; and if it ever answered, it would answer as ACE, not as them.
- Never read a labs token from disk (`~/.ace/.env`, the plugin data `.env`) or reach
  labs any other way (browser session, curl). On a laptop runner the token is still on
  the disk: this rule is the boundary there.
- When `site_call` is refused (no grant, "has ended", "not something you may use"),
  say why in plain words and ask them to send again from the page — never fall back.

## Answering

Answer data questions the way labsdata does (`dimagi-internal/labsdata`
`skills/answer-data/SKILL.md`): read the workflow first (`data_workflow_context`),
find the field before querying, count the right thing and say which, check
`truncated`, react to typed errors instead of thrashing, and give one line of
provenance. A change to labs is proposed with `workflow_edit_propose` (through
`site_call`) and saved only on the person's Confirm.
