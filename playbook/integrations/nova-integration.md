# Nova Integration

## Nova's Role in ACE

Nova generates CommCare applications from Intervention Design Documents (IDDs). In the
ACE workflow, once the IDD is approved, ACE passes it to Nova to generate both:
- A **Learn app** — training/knowledge app for FLWs
- A **Deliver app** — data collection app for FLW service delivery

These two app generation steps (`idd-to-learn-app`, `idd-to-deliver-app`) can run in
parallel. Nova's output is then fed to `app-deploy` for upload to CommCare HQ.

---

## What Needs Exploration

The key open question is: **can Nova be driven programmatically by ACE?**

This needs to be explored with Braxton. The answer determines which integration
option ACE uses.

### What we need to know
- Does Nova have or plan to have a REST API for app generation?
- Can Nova accept an IDD as input and return a `.ccz` / app JSON without human
  interaction?
- What is Nova's current input format? (structured JSON? Markdown IDD? form input?)
- What authentication/authorization model would a Nova API use?
- What is the expected latency for app generation? (seconds? minutes?)
- Are there quality or validation steps in Nova that ACE needs to handle?

---

## Integration Options

### Option 1: Nova API (Preferred)

Nova exposes a REST API (or we add one) that accepts an IDD and returns a generated
CommCare app package.

```
POST /api/generate-app
{
  "idd": "<markdown content>",
  "app_type": "learn" | "deliver",
  "project_space": "crispr-connect"
}

→ { "app_package_url": "...", "app_id": "...", "status": "complete" }
```

ACE calls this API directly via the Nova MCP server (to be built). No human in the
loop for app generation.

**Preferred because:** Fully automated. ACE can generate apps as part of the pipeline
without blocking on human action.

### Option 2: Nova Fork

Fork the Nova codebase and add a headless/API mode to the fork. ACE runs the forked
Nova locally or in a container and calls it directly.

**Viable if:** Nova's architecture makes adding an API mode straightforward, and the
Dimagi team is willing to maintain a fork.

**Downside:** Fork maintenance burden. Changes to upstream Nova must be selectively
merged. Only recommended if Option 1 is infeasible.

### Option 3: Nova via Headless Browser (Not Recommended)

Drive Nova's web UI using a headless browser (e.g., Puppeteer via gstack). ACE fills
in the IDD form fields, clicks Generate, and downloads the output.

**Not recommended because:** Brittle to UI changes, error-prone, hard to debug, and
not a real API integration. Should only be considered as a last resort if Nova cannot
expose any programmatic interface.

---

## Manual Workaround

Until Nova integration is resolved with Braxton:

1. The `idd-to-learn-app` and `idd-to-deliver-app` skills generate a **Nova brief**
   from the approved IDD — a structured document with all the information Nova needs
   to generate the app
2. The skill presents this brief and instructs the user to:
   - Open Nova
   - Create a new app using the brief as input
   - Export the generated app package
3. The user provides the exported app package path/URL
4. ACE proceeds to `app-deploy` with the user-provided package

This manual flow still benefits from ACE's IDD-to-brief generation, which structures
the requirements in the exact format Nova expects. The human step is just the Nova
interaction itself.
