# Connect API Integration

## What Exists Today

The **connect-labs MCP** (in the `connect-labs` repo) exposes approximately 20 tools for
interacting with Connect. These are production-ready and available to ACE skills today.

### Solicitations
- `list_solicitations` — list all solicitations
- `get_solicitation` — get a single solicitation by ID
- `create_solicitation` — create a new solicitation
- `update_solicitation` — update solicitation fields
- `delete_solicitation` — delete a solicitation

### Reviews
- `list_reviews` — list reviews for a solicitation
- `get_review` — get a single review
- `create_review` — submit a review
- `update_review` — update a review

### Awards
- `list_awards` — list awards for a solicitation
- `get_award` — get a single award by ID
- `create_award` — create an award
- `update_award` — update award details

### Funds
- `list_funds` — list available funds
- `get_fund` — get a fund by ID
- `create_fund` — create a fund
- `update_fund` — update fund details

### Opportunity Lookup
- `list_opportunities` — list Connect opportunities
- `get_opportunity` — fetch opportunity details by ID
- `search_opportunities` — search opportunities by name or status

---

## What Needs to Be Built

The following APIs do not exist yet and must be built by Cal's team. They are tracked
under **CCC-301** and related tickets.

### Program + Opportunity CRUD (CCC-301)
- `create_program` — create a new Connect Program
- `update_program` — update program fields
- `create_opportunity` — create a new Opportunity under a Program
- `update_opportunity` — update opportunity fields
- `delete_opportunity` — remove an opportunity

These are the highest-priority gaps. `connect-program-setup` and `connect-opp-setup`
skills are blocked on these.

### Opportunity Configuration APIs
- **Verification rules** — set and update rules that govern what counts as a valid
  delivery (e.g., required form fields, GPS accuracy thresholds)
- **Delivery units** — configure the units of work FLWs are expected to complete
- **Payment units** — configure how payment is calculated per delivery unit

These may be folded into `create_opportunity`/`update_opportunity` or exposed as
separate endpoints. To be determined with Cal's team.

### Invite API
- `send_llo_invite` — send an invitation to an LLO organization to join a Connect
  opportunity. Requires the LLO Directory data model to exist (CCC-300).
- `list_llo_invites` — check invite status for an opportunity

Blocked on: LLO Directory in proper data model (separate ticket from CCC-300).

### Invoice API
- `list_invoices` — pull invoices for a completed opportunity
- `get_invoice` — get invoice details by ID

Needed by the `opp-closeout` skill to pull payment data and create the Jira ticket.

---

## Manual Workaround

Skills that depend on unbuilt APIs will document the required actions and prompt the
user to complete them manually. The skill will:

1. Describe exactly what needs to be done in Connect (with screenshots or step-by-step
   instructions where helpful)
2. Present the configuration values ACE has computed (e.g., verification rule settings
   derived from the IDD)
3. Ask the user to perform the action in the Connect admin UI
4. Wait for confirmation before proceeding to the next step

This means ACE can still orchestrate the full lifecycle — it just has more human
touchpoints until the APIs are built.
