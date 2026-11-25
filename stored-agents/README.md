# Stored agents ACE administers

ACE created these agents and keeps admin on them. Each one is a **stored** agent: canopy-web
holds its definition, and the live revision there is what the agent runs. A directory here is
ACE's working copy of an agent's editable files, kept so that a change gets a test in ACE's CI
before it is published.

| Dir | Agent | Copied from |
|---|---|---|
| `connect-helper/` | `connect-helper` (workspace `connect`) | revision 3, plus the record-question change (ace PR) |

## Changing one

1. Bring the copy up to the live revision first, and check what changed:
   `canopy agent definition diff --slug <slug>` and `canopy agent definition cat --slug <slug> <path>`.
2. Edit the files here, and add or extend a test under `test/stored-agents/`.
3. Merge the PR. Then draft and publish from this copy:
   `canopy agent definition edit --slug <slug> -m "<what>" --set <path> stored-agents/<slug>/<path> …`
   and publish the draft as an agent that administers it (`publish_agent_definition`).
4. Read the published file back (`canopy agent definition cat`) and check that it matches this copy.

Generated files (`.claude-plugin/*`, `.claude/settings.json`, `bin/<slug>-email`, `.gitignore`) are
written by canopy-web and are not kept here.
