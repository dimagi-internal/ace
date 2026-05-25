# ACE — Product Context

## What It Is
ACE (AI Connect Engine) is a Claude Code plugin that orchestrates the 21-step CRISPR-Connect lifecycle for Connect opportunities — from idea through IDD, Nova app generation, CommCare deployment, LLO onboarding, monitoring, and closeout.

## Who Uses It
- **Primary users**: Dimagi CRISPR admin group (Matt, Neal, Jon, Sarvesh, Cal). They run ACE against individual Connect opportunities, review outputs at gate steps, and merge skill improvements back into the plugin repo.
- **Indirect users**: LLOs and FLWs whose work ACE generates and monitors — they don't touch ACE directly.
- **Usage pattern**: One ACE instance per Connect opportunity, run in "review" mode with human approval at gates (IDD, app deploy, LLO invite). Skills improve continuously via edits → PR → merge, same as canopy.

## What Matters Most
1. **Time from idea to LLO go-live ≤ 1 week** with minimal Dimagi intervention by end of Q2 2026.
2. **Zero "bad sends"** — no emails, publishes, or invites that had to be recalled.
3. **Skills that generalize** — ACE should handle IDDs beyond the atomic-visit pattern (focus groups, qualitative research, longitudinal pilots) without hard-forking the skill set per IDD type.

## Tech Stack
- Claude Code plugin: agents + skills (SKILL.md) + commands, canopy-style
- 8 agents (ace-orchestrator + 6 phase + ocs-tester), 24 skills, 10 commands
- 2 MCP servers: Google Drive (built, TS/Node), OCS (scaffold stubs)
- External deps: connect-labs MCP (~20 tools, gaps tracked as CCC-301), Nova (bot API TBD), CommCare HQ, OCS, Jira
- Companion repo: `ace-web` (Django + Channels + React on GCP Cloud Run) — browser chat/transcript harness, separate repo

## Current State
All 19 SKILL.md stubs exist with process steps, tool lists, mode behavior, change logs. Many skills carry "current workaround" sections because underlying APIs (Program/Opp creation, Nova bot, OCS, CommCare upload/publish) aren't built yet — they degrade gracefully to human-in-the-loop. Eval framework exists (IDD → Nova → Blueprint at 88%). Dry-run mode + CRISPR-Test-001 fixture + structural validation landed recently. Most recent work (PR #3) added two sample IDDs that stress-test the framework: a clean case (turmeric market survey) and a hard case (vaccine hesitancy focus groups) that exposed gaps in current skill assumptions.

## Known Considerations
- **Atomic-visit bias:** every current skill implicitly assumes "delivery = one FLW visit = photo + GPS + form." Focus-group and other qualitative IDDs don't fit. See `docs/examples/idd-stress-test-observations.md`.
- **Manual fallbacks are expected, not tech debt.** Most "NOT YET BUILT" API notes are waiting on Cal's team / CCC-301 — don't propose implementing those APIs from this repo.
- **Plugin source is source-of-truth.** SKILL.md files are both the plan AND the docs. `/ace:docs` regenerates `docs/generated/playbook.md` from them.
- **Don't touch ace-web from this repo.** It's a separate GitHub repo; the submodule was removed in favor of a README link.
- **LLM-as-Judge runs inside skills** — skills self-evaluate before the next step. Criteria live in each SKILL.md.
- **Regression risk is real.** ACE sends emails, publishes apps, creates Jira tickets. SKILL.md edits should be re-tested against CRISPR-Test-001 before live runs.
