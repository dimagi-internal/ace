# Labs on a page — only as the person who sent

Shared rule for every ACE answer given in a canopy conversation **held on a
connect-labs page** (a workflow run page, the Data page, a marketplace round — the
Connect Labs agent panel). Linked from each skill that can run there; *enforced:*
`test/skills/labs-on-a-page.test.ts` (the links) and
`test/mcp/connect-labs/headers-helper.test.ts` (the helper).

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
