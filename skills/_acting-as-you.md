# Acting as you — "as me"

Shared rule for every ACE write to Connect Labs (workflows, dashboards, the semantic
layer, pipelines, solicitations, labs config) in someone's **own Claude Code**. On a
connect-labs page the narrower rule [`_labs-on-a-page.md`](_labs-on-a-page.md) applies
instead: there ACE only ever acts as the person, through canopy's `site_call`.
*Enforced:* `test/skills/acting-as-you.test.ts`.

## How a person asks

They say **"as me"** in the request: *"As me: repoint the KMC dashboard at opp 1234."*
Nothing else counts as asking. A request without it is ACE's own work, done as
ACE's labs account (`ace@dimagi-ai.com`): run builds, synthetic programmes, demos.

A second request is **short-lived access**: *"request a temporary labs token"*, *"a
no-user-visit step-up"*, or any ask to read something ACE's own labs account gets "not
found" on. It is not "as me" and writes nothing. See
[§ Short-lived access](#short-lived-access-to-what-aces-own-account-cannot-reach).

## Which connection is whom — never assume it from the name

A session can hold two labs connections, and their identities are not fixed:

| Tools | Usually signed in as | But |
|---|---|---|
| `mcp__plugin_ace_connect-labs__*` (ACE plugin) | ace@dimagi-ai.com, from ACE's vault (`LABS_MCP_TOKEN`) | When ACE's vault did not load on this computer, Claude Code signs it in as whoever completed `/mcp`, usually the person. It flips back to ace@ silently the day the vault loads. |
| `mcp__connect_labs__*` (claude.ai connector or a user MCP) | whoever signed it in | Observed signed in as ace@dimagi-ai.com on the owner's own machine (2026-10-27). |

So identity is read, never inferred. **`labs_context({search: "zzzz-no-match"})`
answers `{user: {username, email}}` with an empty tree.** That makes it a cheap
"who am I" check for any labs connection.

## The rule

1. **Before any labs write, say who it will be as.** Run the who-am-I check on the
   connection you will write through, and name the email in your plan
   (*"I'll make this change as ace@dimagi-ai.com"*). A write whose identity you
   did not state is a defect, whoever asked.
2. **"As me" → only a connection whose email is the asker's.** The asker is
   `who_is_asking` in a canopy turn, else `git config user.email`. Check every labs
   connection the session has and use the one that matches.
   - None matches → **stop** and tell them how to add one (below). Never fall back
     to a connection that is someone else, ace@ included.
   - Every write in the task goes through that connection. Do not switch partway.
3. **Prefer a change they approve.** Read the current state first (`workflow_get`,
   `semantic_registry_get`). Propose before saving: `workflow_edit_propose` for a
   workflow, `semantic_registry_validate` before `semantic_registry_create` or
   `semantic_registry_update`. After the write, say what changed, as whom, and how
   to undo it: `labs_config_undo` for labs config, or the before state you recorded.
4. **Only labs can be "as me" today.** ACE's Connect, CommCare HQ, OCS and Drive
   tools act only as ACE's own accounts. A request to change one of those "as me"
   is answered honestly: ACE can do it as ACE (and say so), or the person does it
   themselves. Never present an ACE-account write as theirs.

## Short-lived access to what ACE's own account cannot reach

When ACE's labs account (`ace@dimagi-ai.com`) gets "not found" on something the person
holds, such as the workflows, pipelines or indicator definitions of a real programme,
the first-class way to ask is a **temporary labs token**: one hour, no renewal, approved
by the person in labs. Labs built it for exactly this ("An agent doing one job you asked
for", connect-labs `docs/MCP_SETUP.md` § Which way in; skill
`.claude/skills/labs-token-setup`, § Temporary access for one job).

1. **Say what you will read, and why, before you ask.** Default to **no user visit
   data** (`--no-uservisit-data`): it reads how a programme is built (workflows,
   pipelines, indicator definitions, app structure, solicitations, the org directory,
   targeting) and never a real visit row. Ask for full access only when the job needs
   visit data; that also needs the person's passkey.
2. **Run labs' helper**, from a connect-labs checkout (or fetch the one file with
   `gh api repos/dimagi-internal/connect-labs/contents/.claude/skills/labs-token-setup/setup_labs_token.py`):

   ```
   python setup_labs_token.py https://labs.connect.dimagi.com --temporary --no-uservisit-data --output <private file>
   ```

   It prints an approval link. The person opens it signed in to labs and approves.
3. **It only works where the person's browser and this session are on one computer.**
   Labs sends the token back by redirecting the person's browser to `127.0.0.1`, and
   rejects any other callback (`connect_labs/mcp/admin_views.py`, `_validate_callback`).
   In a cloud-runner turn the token has nowhere to land. Say so plainly and ask them to
   run it from their own Claude Code. Never ask for the token in chat, never add a vault
   secret for it, and never write a sign-in script against `/o/register/`.
4. **Use it only for the job.** Call labs with `Authorization: Bearer $(cat <file>)`.
   Keep the token out of every output, delete the file when done, and say in the reply
   what you read with it. It does not touch `LABS_MCP_TOKEN` or any `claude mcp` entry.

ACE's own full-access mint (`labs-token-mint`, self-minting for ace@) is a different
thing: it makes ACE's token, not a way to see what the person sees.

## Adding a labs connection that is you

In a terminal, once per computer:

```
claude mcp add --transport http --scope user connect_labs https://labs.connect.dimagi.com/mcp/
```

Then in Claude Code run `/mcp`, choose `connect_labs`, and sign in to labs in the
browser as yourself. Ask ACE "who am I on labs?". It runs the check above and should
answer with your email. If a claude.ai **Connect Labs** connector already exists and
answers as someone else, disconnect it and connect it again as yourself.

Never put your own labs token into `LABS_MCP_TOKEN`. That turns ACE's plugin
connection, and every run step on this computer, into you, and leaves your token in a
file.
