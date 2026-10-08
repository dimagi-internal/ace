# canopy-web — how ACE writes DDD artifacts

ACE writes three things to canopy-web: DDD **narratives/reviews** (`scripts.ddd.narrative post`,
the `canopy:ddd` loop's `ddd-narrative-review` / `ddd-upload`), **cut / hero videos**
(`snippets upload-video`, `video-engine/render_locally.py` uploads, `canopy:ddd-ace-render`),
and **walkthrough shares** (`canopy:walkthrough-share`).

## The rule: every write goes through `bin/ace-canopy-web`

canopy's CLI resolves **identity** as `CANOPY_WEB_PAT` → the cwd's agent `.env` →
`~/.claude/canopy/workbench-token`, and **workspace** as arg → `CANOPY_WEB_WORKSPACE` →
`<repo>/.canopy/ddd/config.yaml` → the org default. Run from a canopy checkout with neither pinned,
an ACE write lands in the default workspace **under whoever owns the workbench token** — on the
owner's laptop, Jonathan. That is ace#2805: the chlorine demo narrative, meant for `connect`, was
posted as Jonathan into `dimagi`, its 8 cut videos followed, and the session reported "connect"
without reading it back.

```bash
ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
WS="${WS:-$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['ddd_workspace'])" "$ACE_ROOT/config/canopy-web.json")}"

"$ACE_ROOT/bin/ace-canopy-web" --workspace "$WS" check            # identity + editor-role preflight
"$ACE_ROOT/bin/ace-canopy-web" --workspace "$WS" -- <canopy command…>
"$ACE_ROOT/bin/ace-canopy-web" --workspace "$WS" verify narrative <slug>
"$ACE_ROOT/bin/ace-canopy-web" --workspace "$WS" verify walkthrough <id>
```

- **Identity** is ACE's own PAT from ACE's `.env` — never an inherited `CANOPY_WEB_PAT`, never the
  workbench token — and the wrapper refuses unless it authenticates as `ace@dimagi-ai.com`.
- **Workspace** is required and explicit: `config/canopy-web.json` `ddd_workspace`, overridden by
  `/ace:demo --workspace` or an opp's `opp.yaml` `canopy_web.workspace`. The wrapper refuses unless
  ACE is editor/admin/owner there — an agent never writes into a workspace it cannot edit.
- **Read back before reporting.** `verify` reads the artifact under `/api/w/<ws>/…`; only a 200
  lets you say where it lives. A flat-route read proves nothing: it succeeds from any workspace.
- **A subagent does not inherit this.** When you dispatch `Agent(canopy:ddd)` (or any canopy skill
  that writes), put the wrapper invocation and `$WS` in the prompt verbatim and require every
  canopy-web write to run through it, then `verify` the result yourself after it returns.

## Links: workspace-addressed only

Every canopy-web link ACE writes anywhere a person reads it (email, Docs, run pages, reports)
is `https://canopy.dimagi.com/w/<workspace>/…`:

| Artifact | Link |
|---|---|
| Narrative | `https://canopy.dimagi.com/w/<ws>/ddd/<slug>` |
| Review (guest) | `https://canopy.dimagi.com/w/<ws>/review/<id>?t=<token>` |
| Walkthrough / cut video | `https://canopy.dimagi.com/w/<ws>/walkthrough/<id>?t=<token>` |

Never a flat `/review/<id>`, `/walkthrough/<id>`, `/ddd/<slug>`, `/share/<token>` or the
legacy `/w/<uuid>`; those depended on redirects canopy-web is removing (canopy-web#1337). On
2026-10-08 a flat `/review/<id>/` link, copied from `scripts.ddd.narrative post` output, went
out in an external email. Two rails now enforce this:

- **The wrapper rewrites.** `bin/ace-canopy-web` streams the wrapped command's output with every
  flat link rewritten to `/w/<ws>/…` (each rewrite noted on stderr), and `verify` prints the scoped
  `url` to cite.
- **The send path refuses.** `bin/ace-email` refuses a body carrying a flat canopy-web link (exit
  3, dry-run included). There is no override, because the scoped form always exists.

The rule lives in `bin/canopy_url_scope.py`. `test/docs/no-flat-canopy-urls.test.ts` keeps
flat links out of ACE's own prose.

Already misfiled? `move_narrative` (canopy-web MCP) re-homes a narrative with its reviews and
walkthroughs: dry-run first, then run; it needs editor on both sides.

Server-side halves (scoped URLs, no silent default, editor-on-target): canopy-web#1289.
