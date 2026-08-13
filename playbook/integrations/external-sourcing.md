# External sourcing — pulling instruments from login-gated sites

## Scope, and why this is a doc rather than a skill

ACE's input boundary is **Drive**. `idea-to-pdd` reads source material only
from the frozen `runs/<run-id>/inputs-manifest.yaml` over `ACE/<opp>/inputs/`,
and halts rather than proceed without it ("Do not invent source material").
`program-input-sweep`, the only other ingestion path, also reads a Drive
folder. Sourcing an instrument is therefore an **operator act upstream of the
pipeline** — a one-shot acquisition that produces a durable Drive artifact
which every downstream phase then consumes.

So this is deliberately not a skill and not an MCP atom:

- An atom is ruled out by CLAUDE.md § Gotchas — Playwright backends are
  HTTP-only, `page.request` exclusively, no click-driving, no selectors. A Box
  JS-viewer download is click-driving by definition.
- A skill would carry selectors against third-party UI with no CI coverage —
  the same unmonitorable-drift class ACE has already paid for once with mobile
  selector maps.

What *is* worth keeping is the diagnosis below. It is un-testable external
knowledge about how Box actually behaves, and it cost about an hour to derive
(dimagi-internal/ace#890, `hh-poverty-targeting` / PovGraduate, 2026-07-22).

## Login-gated instrument downloads (Box-hosted)

Observed on povertyindex.org, and expected to generalise to any Drupal-ish
portal that fronts Box.

**Registration and email validation work fine through the gstack `browse`
skill** — an image CAPTCHA is solvable by screenshotting the element and
reading it, and the validation link can be pulled from ACE's own Gmail inbox.
The download is the part that breaks.

### The failure ladder — don't re-derive it

Resource links `302 → box.com/shared/static/<hash>.<ext>`, and Box redirects
that to its JS viewer at `app.box.com/s/<hash>`. Consequently:

| Attempt | Result | Why |
|---|---|---|
| `browse download --navigate` (portal URL *or* the Box static URL) | **times out** | no native download event fires — Box serves a viewer, not a file |
| in-page `fetch()` of Box's `index.php?rm=box_download` | **0 bytes** | CORS-opaque redirect to `dl.boxcloud.com` |
| `curl` with Drupal/Box session cookies + `request_token` | **HTTP 512** | Box's download needs a JS-constructed token flow |

### What works

Drive a full Playwright browser directly with `acceptDownloads: true` and wait
on the native download event. `playwright` is already a direct dependency of
this repo, so this needs no new code and no new deps — write a scratch script
and run it with `npx tsx`.

```js
const { chromium } = require('playwright');
const ctx = await (await chromium.launch({ headless: true }))
  .newContext({ acceptDownloads: true });
const page = await ctx.newPage();
await page.goto('https://app.box.com/s/<hash>', { waitUntil: 'domcontentloaded' });
const [dl] = await Promise.all([
  page.waitForEvent('download'),
  page.getByRole('button', { name: /download/i }).first().click(),
]);
await dl.saveAs(dest);
```

**Write that scratch script to a `mktemp` path**, not a predictable one —
`commands/ocs-login.md` is the in-repo precedent, and ace#1046 is the class it
avoids (a stale artifact at a guessable path read back as if fresh).

### The two non-obvious facts

1. **Box public `/s/<hash>` shares download anonymously.** The portal login is
   needed only to *discover* the hashes, which are visible on the country page
   once signed in. No session or cookie plumbing is needed for the download
   itself — which is why the curl-with-cookies branch above was a dead end in
   more than one way.
2. **The selector is third-party UI with no CI coverage.** Re-derive
   `getByRole('button', {name:/download/i})` from the live page rather than
   trusting the snippet above; per CLAUDE.md § close the loop to the source of
   truth, a transcribed selector is a guess. All four Nigeria PPI files
   (Scorecard + Lookup xlsx, User Guide pdf, Data Analysis Tool xlsx,
   Interview Guidance pdf) downloaded on the first Playwright pass when it was
   derived live.

### Credentials

ACE has a povertyindex.org account for future PPI pulls. The original issue
recorded it in 1Password vault `AI-Agents`, item
`6ikom2wiawzgymc2ms5evm4qku` — **that pointer is stale**: per CLAUDE.md
§ Auth model, ACE's vault is now `Agent-Ace` and the legacy shared `AI-Agents`
vault "still holds copies but is no longer read". Verify the item exists in
`Agent-Ace` (and move it if not) before relying on it.

### Where the file goes

Into `ACE/<opp>/inputs/`, like any other human-curated input. The skill never
fetches; it reads the manifest.
