# Verify before you send — the contract for anything that leaves ACE

**Nothing goes to a person until you have opened it yourself, as they will open it.**

This is the one rule. Everything below is what it means in the cases where it has already
failed. It binds every outbound artifact — an email, a shared doc, a link in a Slack reply,
an instruction in a work order, a training deck — and it binds ad-hoc prose you compose by
hand in a turn exactly as it binds a skill's output.

*Enforced:* `bin/ace-email` refuses an unverified body (§ The rail). `test/skills/verify-before-send.test.ts`
pins this file's clauses and requires every outbound-producing skill to link it.

---

## Why this file exists

On thread `1a1691a41973d718` (2026-11-02 → 2026-11-13) ACE sent a programme partner four
Labs report links. None of them worked. His reply:

> All the labs URLs you share lead me to this page […] If I search for Inline nothing
> appears. […] **This is the fourth time you sent me urls that lead to pages not containing
> the information I wanted. Can you please be more careful?**

"Be more careful" is not a mechanism, and the diagnosis is worse than carelessness. In the
turn that sent those links ACE **had already run a check, seen that it proved nothing, and
written so in its own close-out** — then sent anyway. The correct URL form was **already
documented** in this repo, recorded months earlier from a previous occurrence
(`skills/demo-data-setup-qa/SKILL.md`: *"`/run/?opportunity_id=` with no `run_id` → workflow
LIST"*). Knowing was never the problem. Nothing stood between knowing and sending.

That is what this file and its rail are: the thing that stands there.

---

## 1. A link is verified when you have OPENED it and seen the content you are promising

Not when it was created. Not when an API returned the id. Not when it returned `200`.

**A `200` is not evidence.** Measured 2026-11-13 on a real Labs dashboard:

| What was requested | Result |
|---|---|
| `/labs/workflow/11988/run/` (what was sent) | **302**, 0 bytes |
| `/labs/workflow/11988/run/?run_id=11990` | **302**, 0 bytes |
| `…?run_id=99999999&opportunity_id=10174` (wrong run) | **200**, 177 KB, **no data** — a shell with the right title |
| `…?run_id=11990&opportunity_id=10174` | **200**, 193 KB, the dashboard |

The third row is the trap. A wrong id returned `200` *and* the correct page title. Anyone
checking for "does it load" or "is the title right" passes it. So:

- **Name what you expect to SEE before you fetch**, then assert that string is present —
  a figure, a heading, the specific wording you are telling them to look at.
- **Compare against a control** where one is cheap: fetch the same URL with a deliberately
  wrong id. Whatever the good one has that the control lacks is the actual content.
- **A redirect is a failure.** `302` means the page you promised did not render.

## 2. Verify as the RECIPIENT, not as yourself

This is the half that is routinely skipped, and it is why the 2026-11-13 links failed for a
reader while being perfectly reachable to the sender.

Two independent questions, and you owe an answer to both:

1. **Does this URL identify the thing on its own?** Many surfaces resolve against *the
   reader's own current selection*. The Labs workflow URL above has no opportunity in it, so
   it renders whatever the reader happens to have selected — for the sender, the right
   thing; for the partner, "No Workflows Found". **A link whose meaning depends on the
   reader's session state is a broken link.** Put every identifier in the URL.
2. **Can this person reach it at all?** Access is rarely "logged in or not":
   - Labs synthetic opportunities are hidden from the selectors by a **per-user** toggle
     that is off by default (`view_synthetic_opps`) — a UI opt-in, not a security control.
     A person can be fully authorised and still unable to find the thing by looking.
   - Labs-only opps gate reads on `allowed_domains` plus a Dimagi carve-out, and a
     Workspace on the labs org replaces both with role checks.
   - CommCare HQ's stock `Read Only` role cannot open an app link at all.
   - A Drive file shared with you is not shared with them.

   **State the basis.** Not "they should be able to see it" — *which rule grants it*. If you
   cannot name the rule, you have not checked. If the rule depends on something only they
   can change, say so in the message and tell them exactly where the switch is.

**Never tell a person to "just try it and let me know".** That is the sender's work moved
onto the reader, and after the second time it reads as not caring.

## 3. Never ask someone to do something you have not confirmed they can do

ACE told the same partner to *"delete two verification rules on the Deliver screen — only
the page you have admin on"*, as the two-minute item blocking completion. **No such page
exists.** Connect builds that formset without `can_delete`, so the control renders for
nobody; deletion needs a platform superuser. The ask was unactionable on arrival, and it was
the first thing he read.

Before an instruction goes out: open the surface, find the control you are naming, and
confirm the person's role can use it. **Naming a UI element you have not looked at is the
same error as sending a link you have not opened.**

## 4. Never remove a surface without naming the one that replaces it

*"Not worth your time right now… please don't rely on it for the demo"* — about the page the
partner was using to review the work — left him with nothing and no alternative, so he came
back the next day still blocked. If something is broken, the message must carry the route
that works. "Don't use that" is half an answer.

## 5. An inherited claim is an unverified claim

A fact carried over from an earlier message, a prior turn's summary, or a board card is
**not** verified by having been written down. Re-read the artifact.

Two live examples from the same thread, one day apart:
- *"Neither rule can fire"* was generalised from a note that had only ever claimed it for
  **one** of the two rules. It happened to be true; it was luck until the released app was
  read.
- An **apology** for unverified links itself contained *"checked that each one shows the
  data"* when only one of four had been checked at data level — the identical error, one
  message later, inside the correction for it.

**A correction is held to a higher bar than the thing it corrects, not a lower one.** Before
sending an apology, verify its claims harder than you verified the ones you are apologising
for.

## 6. Never put our internal plumbing in a counterpart's message

Logins, credentials, tokens, keyrings, runner setup, `.env`, service accounts, which of our
sessions expired. A broken credential is **our** fault to fix and to state as a fault —
"the page is broken at our end, I have no date yet" is the whole of what they need. The
fleet rule is in canopy's `agent-core/turn.md` Step 1; this file restates it because the
send path is where it leaks.

## 7. When your own check fails, fix the check: the person is not your verifier

ACE has its own accounts: Labs and Connect as `ace@dimagi-ai.com` (`/ace:labs-login`,
`/ace:connect-login`), plus the HQ and OCS sessions. If you cannot open the page you are
about to point someone at, the failure is in your setup: a stale session, a login that did
not stick, or an account that lacks access. Debug it the way you would debug any other
defect. **Do not hand the check to the person**: no "I couldn't open it, please check it",
no "you should see X, tell me if you don't". That is § 2's "just try it and let me know"
with an excuse attached. It is still wrong when the person is the owner, and when you have
already said your login is broken.

Owner, 2026-11-18, after ACE said its screenshots *"only reach the login page… Please open
this Dayo link and check it"*: *"you have your own login to be able to login so I don't know
what you mean."* The re-run of `/ace:labs-login` succeeded at once. What actually stood in
the way was access: ACE's Labs user had no email on file, and Labs gates labs-only synthetic
opps by email domain (`SyntheticOpportunity.is_visible_to` / `is_accessible_to`). ACE was
signed in, but it could not see the opportunity.

So, in order:

1. **Re-run the login**, then retry the check. Most failures end here.
2. **Find out which account you are**, and what it can see (`labs_context` returns `user.email`
   and the opps it can see). Your own account may simply not have the access the person has.
   That is a finding, not a reason to stop.
3. **Fix what is yours to fix**, then verify.
4. **Only a fix outside your authority goes back to the person.** Even then, give them the
   diagnosis and the one action that unblocks it, never the verification. For example: "ACE's Labs user
   has no email, so it can't see opp 10133; one-row fix, OK to run it?" That asks for a
   decision. "Please open the link and check it" asks them to do your job.

---

## The rail

`bin/ace-email` refuses to send a body containing a link to one of our own surfaces unless a
**link-verification receipt** exists for that exact body (ace#3426; repro: thread
`1a1691a41973d718`, four unopened Labs links):

```bash
# Run it bare first — it lists the body's gated links with their indices.
bin/ace-verify-links --body-file <body> \
  --recipients "fconte@dimagi.com,stewari@dimagi.com" \
  --expect  "1=Hanna colorimeter" \
  --control "1=<the same URL with a deliberately wrong id>" \
  --access  "labs.connect.dimagi.com=any @dimagi.com account: is_accessible_to grants Dimagi users"
```

It fetches each link with ACE's live sessions, asserts the expected string is present, and
records the verdict keyed to the body's hash. Editing the body invalidates the receipt, by
design — the same contract as the pre-send review receipt.

Links are addressed by **index**, not by URL: a deep-link's query string contains `=`, so a
`<url>=<text>` form splits in the wrong place and silently matches nothing.

**A stale session is reported as a stale session**, not as broken links (exit 2, no receipt
written). That distinction matters: when every link bounces to a login page the tempting
move is to rewrite links that were already correct. Refresh with `/ace:labs-login` or
`/ace:connect-login` and run it again.

The rail refuses on `--dry-run` too, so a draft is caught before it reaches an approval gate
rather than after. There is no override for a failed fetch: a link you could not open is a
link you may not send.

**The receipt records recipients**, and the rail refuses when the message goes to someone the
verification did not cover — so "I checked it for Fio" cannot silently become "and therefore
it works for Sagar".

## What the rail cannot check, and you still must

- **Whether the scope in a URL matches the dashboard's owner** (an opp-owned dashboard given
  `program_id` renders "not found") — `skills/demo-data-setup-qa` owns that.
- **Whether the content is the RIGHT content** — the rail proves a string is on the page, not
  that the page answers their question.
- **Whether a person can reach it**, beyond recording the basis you stated. If you wrote a
  basis you did not check, the receipt makes that a lie you signed rather than an oversight.
- **Anything you send by another channel.** Slack, a doc comment, a board card: same rule,
  no rail. Open it first.
