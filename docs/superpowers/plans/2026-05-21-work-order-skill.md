# pdd-to-work-order Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new Phase 1 skill (`pdd-to-work-order`) plus its `-qa` and `-eval` companions that draft a contractual Work Order from the approved PDD and the run's `decisions.yaml`, render it to a clean Google Doc, and integrate into the `idea-to-design` agent.

**Architecture:** Three new skills under `skills/` (producer + QA + eval), one new bootstrap script that creates the Drive template once per environment, and an additive edit to `agents/idea-to-design.md` that wires the new skills in as Step 2 / 2.4 / 2.5. QA static checks live as pure functions in `checks.ts` with vitest coverage; producer and eval skills are SKILL.md instruction artifacts. Work-order-specific load-bearing fields are prefixed `wo-*` in `decisions.yaml` to avoid colliding with future Phase 8 solicitation rows.

**Tech Stack:** TypeScript (ESM, `npx tsx`), Google Drive + Docs MCPs, vitest, YAML for verdicts and decisions.

**Spec:** `docs/superpowers/specs/2026-05-21-work-order-skill-design.md`

---

## File Structure

**Create:**
- `skills/pdd-to-work-order/SKILL.md` — producer skill instructions
- `skills/pdd-to-work-order-qa/SKILL.md` — QA skill instructions
- `skills/pdd-to-work-order-qa/checks.ts` — static check functions (importable)
- `skills/pdd-to-work-order-eval/SKILL.md` — eval rubric instructions
- `scripts/bootstrap-work-order-template.ts` — one-time Drive template creation
- `templates/work-order-template.md` — canonical template content (uploaded by bootstrap script)
- `test/skills/pdd-to-work-order-qa/checks.test.ts` — vitest unit tests for QA checks
- `test/skills/pdd-to-work-order-qa/fixtures/good-work-order.md` — passes all checks
- `test/skills/pdd-to-work-order-qa/fixtures/missing-sections.md` — fails section check
- `test/skills/pdd-to-work-order-qa/fixtures/bad-payment-schedule.md` — fails sum-to-100 check
- `test/skills/pdd-to-work-order-qa/fixtures/missing-wo-decisions.yaml` — fails decision-rows check
- `test/skills/pdd-to-work-order-qa/fixtures/good-decisions.yaml` — has all required `wo-*` rows
- `playbook/integrations/work-order-template.md` — operator-facing bootstrap docs

**Modify:**
- `agents/idea-to-design.md` — add Step 2 / 2.4 / 2.5; update frontmatter `skills:` array
- `.env.tpl` — add `WORK_ORDER_TEMPLATE_ID` 1P reference
- `lib/artifact-manifest.ts` — register new artifacts (`pdd-to-work-order.gdoc`, `pdd-to-work-order-qa_result.yaml`, `pdd-to-work-order-eval_verdict.yaml`)
- `skills/_qa-decisions.md` — add row for `pdd-to-work-order-qa` (status: has-qa)

---

## Task 1: Register new artifacts in the manifest

**Files:**
- Modify: `lib/artifact-manifest.ts`
- Test: `test/artifact-manifest.test.ts` (existing; adding entries should leave it green)

- [ ] **Step 1: Read the existing PDD artifact entry to mirror its shape**

Read `lib/artifact-manifest.ts` and locate the entry for `path: '1-design/idea-to-pdd.md'`. Copy its shape exactly.

- [ ] **Step 2: Add three new artifact entries**

Append to the artifact list (alphabetical-ish by path within `1-design/` is fine; put right after the `idea-to-pdd*` cluster):

```ts
  {
    path: '1-design/pdd-to-work-order.gdoc',
    producedBy: 'pdd-to-work-order',
    consumedBy: [
      'pdd-to-work-order-qa',
      'pdd-to-work-order-eval',
    ],
    phase: 'design',
    required: false,
    description: 'Contractual Work Order draft derived from the PDD and decisions.yaml. Generic by default — Partner identity is a placeholder unless an LLO was supplied. Re-runs create pdd-to-work-order-2.gdoc, pdd-to-work-order-3.gdoc, etc.; products.work_order in run_state.yaml points at the latest. Parallel to Phase 8 solicitation, not a replacement. Spec: docs/superpowers/specs/2026-05-21-work-order-skill-design.md',
  },
  {
    path: '1-design/pdd-to-work-order-qa_result.yaml',
    producedBy: 'pdd-to-work-order-qa',
    consumedBy: ['ace-orchestrator', 'pdd-to-work-order-eval'],
    phase: 'design',
    required: false,
    description: 'QA verdict for pdd-to-work-order: structural pass/fail across the 8 checks defined in skills/pdd-to-work-order-qa/checks.ts.',
  },
  {
    path: '1-design/pdd-to-work-order-eval_verdict.yaml',
    producedBy: 'pdd-to-work-order-eval',
    consumedBy: ['ace-orchestrator', 'opp-eval'],
    phase: 'design',
    required: false,
    description: 'Per-skill -eval verdict for pdd-to-work-order: contractual clarity, PDD alignment, decisions traceability, verification realism, archetype fit. Shape matches skills/README.md § QA vs Eval.',
  },
```

- [ ] **Step 3: Run manifest tests**

Run: `npx vitest run test/artifact-manifest.test.ts`
Expected: PASS (the three new entries should not break existing fixture validations because they are `required: false`).

- [ ] **Step 4: Commit**

```bash
git add lib/artifact-manifest.ts
git commit -m "feat(manifest): register work-order artifacts"
```

---

## Task 2: Author the canonical work-order template (markdown)

**Files:**
- Create: `templates/work-order-template.md`

- [ ] **Step 1: Write the template**

The template is the canonical body content the bootstrap script will upload to Drive as a Google Doc. Tokens use `{{...}}` (snake_case) so the skill can replace them via `docs_batch_update`. Mirror the malaria example exactly, with tokenized fields.

```markdown
# Work Order Agreement #{{wo_number}}
## {{opp_title}}

| Work Order Number | {{wo_number}} |
|---|---|
| Work Order Date | {{wo_date}} |
| Work Order Title | {{opp_title}} |
| Period of Performance | {{wo_period_of_performance}} |

## 1. Background

{{background_body}}

## 2. Scope of Work

{{scope_body}}

## 3. Geographic Coverage

{{geographic_coverage_body}}

## 4. Deliverables and Verification

### 4.1 Primary Deliverable

{{primary_deliverable_body}}

### 4.2 Definition of a Verified Unit

{{verified_unit_body}}

### 4.3 Reporting Deliverables

{{reporting_body}}

## 5. Timeline and Milestones

{{timeline_table}}

The Partner will flag any timeline risk in writing to Dimagi within 24 hours of identification.

## 6. Payment Terms

### 6.1 Total Not-to-Exceed

Dimagi's total financial commitment under this Work Order is USD {{wo_total_not_to_exceed_usd}}, not-to-exceed, inclusive of all field collection costs, FLW compensation, supervision, transport, and partner reporting time.

### 6.2 Payment Schedule

{{payment_schedule_table}}

Dimagi will pay only for verified units.

## 7. Roles and Responsibilities

{{roles_raci_table}}

## 8. Permissions, Ethics, and Compliance

### 8.1 Permissions

{{permissions_body}}

### 8.2 Ethics

{{ethics_body}}

### 8.3 Security and Duty of Care

The Partner retains sole responsibility for the safety and security of its field teams. The Partner will not deploy FLWs to areas where the prevailing security situation, in the Partner's professional judgement, poses an unacceptable risk.

## 9. Data Handling

{{data_handling_table}}

## Signatures

IN WITNESS WHEREOF, the parties hereto have caused this Work Order to be executed by their authorized agents as of the date first above written, and annexed to the parties' MSA dated __________________.

**Subcontractor**

By: __________________________

Name: [Partner Name]

Title: [Partner Title]

Date: ________________________

Address for correspondence:
[Partner Address]

**Dimagi, Inc.**

By: __________________________

Name: Lucina Tse

Title: COO Dimagi, Inc.

Date: ________________________

Address for correspondence:
245 Main Street, 2nd Floor,
Cambridge, MA 02142
(617) 649-2214; legal@dimagi.com

## Annexures

- Annexure A: Program Design Document — see {{pdd_link}}
- Annexure B: {{annexure_b_placeholder}}
```

- [ ] **Step 2: Commit**

```bash
git add templates/work-order-template.md
git commit -m "feat(templates): canonical work-order template content"
```

---

## Task 3: Bootstrap script for the Drive template

**Files:**
- Create: `scripts/bootstrap-work-order-template.ts`

- [ ] **Step 1: Read the OCS bootstrap script as a pattern reference**

Read `scripts/bootstrap-ocs-golden-template.ts` (first 200 lines is enough). Note the env loading + duplicate-check + force-mode flag pattern. The work-order bootstrap is simpler — no Playwright, no chatbot cloning — just Drive MCP operations.

- [ ] **Step 2: Write the bootstrap script**

```typescript
/**
 * Bootstrap the ACE Work Order template (Google Doc).
 *
 * One-time (or refresh) setup. Uploads templates/work-order-template.md to
 * Drive as a Google Doc, lives at the configured ACE templates folder, and
 * prints the resulting file_id for recording as WORK_ORDER_TEMPLATE_ID in
 * the ACE environment's .env.
 *
 * Usage:
 *   ACE_TEMPLATES_FOLDER_ID=<folder id> \
 *     npx tsx scripts/bootstrap-work-order-template.ts
 *
 * Refresh: set WORK_ORDER_BOOTSTRAP_FORCE=1 to delete the existing template
 * (by name) and recreate.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { google } from 'googleapis';
import { loadEnv } from '../lib/env-loader.js'; // or whatever the existing helper is

const TEMPLATE_NAME = process.env.WORK_ORDER_TEMPLATE_NAME ?? 'ACE Work Order Template';
const PARENT_FOLDER_ID = process.env.ACE_TEMPLATES_FOLDER_ID;
const FORCE = process.env.WORK_ORDER_BOOTSTRAP_FORCE === '1';

async function main() {
  loadEnv(); // populates process.env from $CLAUDE_PLUGIN_DATA/.env

  if (!PARENT_FOLDER_ID) {
    console.error('ACE_TEMPLATES_FOLDER_ID is required.');
    process.exit(2);
  }

  const templatePath = path.resolve(__dirname, '..', 'templates', 'work-order-template.md');
  const body = await fs.readFile(templatePath, 'utf-8');

  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/documents'],
  });
  const drive = google.drive({ version: 'v3', auth });

  // Duplicate check
  const existing = await drive.files.list({
    q: `name = '${TEMPLATE_NAME.replace(/'/g, "\\'")}' and '${PARENT_FOLDER_ID}' in parents and trashed = false`,
    fields: 'files(id,name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if ((existing.data.files ?? []).length > 0) {
    const f = existing.data.files![0];
    if (!FORCE) {
      console.error(`Template already exists at file_id=${f.id} (name=${f.name}). Re-run with WORK_ORDER_BOOTSTRAP_FORCE=1 to recreate.`);
      console.log(f.id);
      process.exit(0);
    }
    await drive.files.update({ fileId: f.id!, requestBody: { trashed: true }, supportsAllDrives: true });
    console.error(`Trashed existing template file_id=${f.id}.`);
  }

  // Upload markdown body, convert to Google Doc
  const created = await drive.files.create({
    requestBody: {
      name: TEMPLATE_NAME,
      mimeType: 'application/vnd.google-apps.document',
      parents: [PARENT_FOLDER_ID],
    },
    media: { mimeType: 'text/markdown', body },
    fields: 'id',
    supportsAllDrives: true,
  });

  console.error(`Created ACE Work Order template file_id=${created.data.id}`);
  console.log(created.data.id); // stdout: bare file_id for capture
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Adapt imports to match what the existing scripts use (`loadEnv` may not exist with that name — check the imports in `bootstrap-ocs-golden-template.ts` and align).

- [ ] **Step 3: Smoke-test the script**

Run (will hit live Drive — only do this when ready to provision the real template):
```
ACE_TEMPLATES_FOLDER_ID=<real-folder-id> npx tsx scripts/bootstrap-work-order-template.ts
```
Expected stdout: a Drive file_id. Verify by opening that file_id in the browser.

If not ready to provision live, validate the script compiles:
```
npx tsc --noEmit scripts/bootstrap-work-order-template.ts
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/bootstrap-work-order-template.ts
git commit -m "feat(scripts): bootstrap-work-order-template script"
```

---

## Task 4: QA `checks.ts` — TDD the static checks

**Files:**
- Create: `skills/pdd-to-work-order-qa/checks.ts`
- Create: `test/skills/pdd-to-work-order-qa/checks.test.ts`
- Create: `test/skills/pdd-to-work-order-qa/fixtures/good-work-order.md`
- Create: `test/skills/pdd-to-work-order-qa/fixtures/missing-sections.md`
- Create: `test/skills/pdd-to-work-order-qa/fixtures/bad-payment-schedule.md`
- Create: `test/skills/pdd-to-work-order-qa/fixtures/missing-wo-decisions.yaml`
- Create: `test/skills/pdd-to-work-order-qa/fixtures/good-decisions.yaml`

The 8 checks (per spec):
1. `all_required_sections_present`
2. `required_wo_decisions_present`
3. `period_of_performance_complete`
4. `payment_schedule_sums_to_100`
5. `total_nte_present`
6. `signature_blocks_present`
7. `archetype_appropriate_scope`
8. `no_scaffolding_markers`

- [ ] **Step 1: Write fixture — `good-work-order.md`**

Copy `templates/work-order-template.md` and replace every `{{...}}` token with realistic content. Set archetype-marker phrasing inside the `Scope of Work` section (`per visit`, photo + GPS phrasing) so the archetype-fit check has something to grep. Save to the fixture path.

- [ ] **Step 2: Write fixture — `missing-sections.md`**

Same as `good-work-order.md` but delete the entire `## 6. Payment Terms` section and its sub-sections.

- [ ] **Step 3: Write fixture — `bad-payment-schedule.md`**

Same as `good-work-order.md` but in the payment schedule table, set the milestone percentages to 40% + 50% (sums to 90, not 100).

- [ ] **Step 4: Write fixture — `good-decisions.yaml`**

```yaml
decisions:
  - id: archetype-selection
    phase: 1-design
    skill: idea-to-pdd
    question: Which delivery archetype best fits?
    default: atomic-visit
    options_considered: [atomic-visit, focus-group, multi-stage]
    source: pdd-archetype-frontmatter
    status: applied
  - id: wo-number
    phase: 1-design
    skill: pdd-to-work-order
    question: Sequence number for this WO under the MSA
    default: "[WO-NUMBER]"
    options_considered: []
    source: placeholder
    status: open
    notes: Human fills in the next free WO number under the active MSA.
  - id: wo-period-of-performance
    phase: 1-design
    skill: pdd-to-work-order
    question: Start + end dates for the engagement
    default: "2026-05-22 to 2026-07-31"
    options_considered: []
    source: pdd-timeline-section
    status: applied
  - id: wo-total-not-to-exceed-usd
    phase: 1-design
    skill: pdd-to-work-order
    question: Total NTE budget cap
    default: "2500"
    options_considered: []
    source: pdd-budget-plausibility
    status: applied
  - id: wo-payment-schedule-split
    phase: 1-design
    skill: pdd-to-work-order
    question: Milestone payment percentages
    default: "40/60"
    options_considered: ["50/50", "40/60", "30/40/30"]
    source: ace-default
    status: applied
```

- [ ] **Step 5: Write fixture — `missing-wo-decisions.yaml`**

Same as `good-decisions.yaml` but delete the `wo-total-not-to-exceed-usd` and `wo-payment-schedule-split` rows.

- [ ] **Step 6: Write the failing test file**

```typescript
// test/skills/pdd-to-work-order-qa/checks.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  checkAllRequiredSectionsPresent,
  checkRequiredWoDecisionsPresent,
  checkPeriodOfPerformanceComplete,
  checkPaymentScheduleSumsTo100,
  checkTotalNtePresent,
  checkSignatureBlocksPresent,
  checkArchetypeAppropriateScope,
  checkNoScaffoldingMarkers,
  CHECKS,
} from '../../../skills/pdd-to-work-order-qa/checks';

const FX = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8');

describe('pdd-to-work-order-qa checks', () => {
  it('exports CHECKS array in canonical order', () => {
    expect(CHECKS.map((c) => c.id)).toEqual([
      'all_required_sections_present',
      'required_wo_decisions_present',
      'period_of_performance_complete',
      'payment_schedule_sums_to_100',
      'total_nte_present',
      'signature_blocks_present',
      'archetype_appropriate_scope',
      'no_scaffolding_markers',
    ]);
  });

  describe('all_required_sections_present', () => {
    it('passes on good fixture', () => {
      const r = checkAllRequiredSectionsPresent(FX('good-work-order.md'));
      expect(r.pass).toBe(true);
    });
    it('fails when Payment Terms section is missing', () => {
      const r = checkAllRequiredSectionsPresent(FX('missing-sections.md'));
      expect(r.pass).toBe(false);
      expect(r.detail).toMatch(/Payment Terms/i);
    });
  });

  describe('required_wo_decisions_present', () => {
    it('passes when all four wo-* rows present', () => {
      const r = checkRequiredWoDecisionsPresent(FX('good-decisions.yaml'));
      expect(r.pass).toBe(true);
    });
    it('fails when wo-total-not-to-exceed-usd row missing', () => {
      const r = checkRequiredWoDecisionsPresent(FX('missing-wo-decisions.yaml'));
      expect(r.pass).toBe(false);
      expect(r.detail).toMatch(/wo-total-not-to-exceed-usd/);
    });
  });

  describe('period_of_performance_complete', () => {
    it('passes when both dates present', () => {
      const r = checkPeriodOfPerformanceComplete(FX('good-work-order.md'));
      expect(r.pass).toBe(true);
    });
    it('fails when only one date is present', () => {
      const text = FX('good-work-order.md').replace(/2026-05-22 to 2026-07-31/g, '2026-05-22');
      const r = checkPeriodOfPerformanceComplete(text);
      expect(r.pass).toBe(false);
    });
  });

  describe('payment_schedule_sums_to_100', () => {
    it('passes on good fixture', () => {
      const r = checkPaymentScheduleSumsTo100(FX('good-work-order.md'));
      expect(r.pass).toBe(true);
    });
    it('fails when percentages sum to 90', () => {
      const r = checkPaymentScheduleSumsTo100(FX('bad-payment-schedule.md'));
      expect(r.pass).toBe(false);
      expect(r.detail).toMatch(/sum to 100/i);
    });
  });

  describe('total_nte_present', () => {
    it('passes when a USD amount or placeholder is present in section 6.1', () => {
      const r = checkTotalNtePresent(FX('good-work-order.md'));
      expect(r.pass).toBe(true);
    });
    it('fails when section 6.1 lacks any USD amount or placeholder', () => {
      const text = FX('good-work-order.md').replace(/USD 2500/i, 'USD ');
      const r = checkTotalNtePresent(text);
      expect(r.pass).toBe(false);
    });
  });

  describe('signature_blocks_present', () => {
    it('passes when both Subcontractor and Dimagi blocks present', () => {
      const r = checkSignatureBlocksPresent(FX('good-work-order.md'));
      expect(r.pass).toBe(true);
    });
    it('fails when Subcontractor block is missing', () => {
      const text = FX('good-work-order.md').replace(/\*\*Subcontractor\*\*/g, '');
      const r = checkSignatureBlocksPresent(text);
      expect(r.pass).toBe(false);
    });
  });

  describe('archetype_appropriate_scope', () => {
    it('passes when atomic-visit scope mentions per visit and photo/GPS', () => {
      const r = checkArchetypeAppropriateScope(FX('good-work-order.md'), 'atomic-visit');
      expect(r.pass).toBe(true);
    });
    it('fails when atomic-visit scope lacks photo/GPS', () => {
      const text = FX('good-work-order.md').replace(/photo|GPS/gi, 'data');
      const r = checkArchetypeAppropriateScope(text, 'atomic-visit');
      expect(r.pass).toBe(false);
    });
    it('passes when focus-group scope mentions attestation + gdoc', () => {
      const text = FX('good-work-order.md')
        .replace(/per visit/gi, 'per session')
        .replace(/photo and GPS capture/gi, 'attestation form submission and gdoc write-up');
      const r = checkArchetypeAppropriateScope(text, 'focus-group');
      expect(r.pass).toBe(true);
    });
  });

  describe('no_scaffolding_markers', () => {
    it('passes when no markers present', () => {
      const r = checkNoScaffoldingMarkers(FX('good-work-order.md'));
      expect(r.pass).toBe(true);
    });
    it('fails when <<TBD>> leaks through', () => {
      const text = FX('good-work-order.md').replace('Background', '<<TBD>>');
      const r = checkNoScaffoldingMarkers(text);
      expect(r.pass).toBe(false);
      expect(r.detail).toMatch(/<<TBD>>/);
    });
  });
});
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `npx vitest run test/skills/pdd-to-work-order-qa/checks.test.ts`
Expected: ALL FAIL (module does not exist yet).

- [ ] **Step 8: Implement `checks.ts`**

```typescript
// skills/pdd-to-work-order-qa/checks.ts
/**
 * Static QA checks for `pdd-to-work-order-qa`.
 *
 * Each check is a pure function that takes the artifact text (work-order
 * markdown or decisions YAML) and returns a `QACheckResult`. Imported by
 * the skill body at runtime and by per-skill tests under
 * `test/skills/pdd-to-work-order-qa/`.
 *
 * The `CHECKS` array is the canonical ordering — surface in the SKILL.md
 * `## Checks` table simultaneously when adding a check.
 */

import type { QACheck, QACheckResult } from '../../lib/qa-types';

const REQUIRED_SECTIONS = [
  'Background',
  'Scope of Work',
  'Geographic Coverage',
  'Deliverables and Verification',
  'Timeline and Milestones',
  'Payment Terms',
  'Roles and Responsibilities',
  'Permissions, Ethics, and Compliance',
  'Data Handling',
  'Signatures',
  'Annexures',
];

const REQUIRED_WO_DECISIONS = [
  'wo-number',
  'wo-period-of-performance',
  'wo-total-not-to-exceed-usd',
  'wo-payment-schedule-split',
];

export function checkAllRequiredSectionsPresent(text: string): QACheckResult {
  const missing = REQUIRED_SECTIONS.filter(
    (s) => !new RegExp(`^#{1,3}\\s+\\d*\\.?\\s*${escapeRegex(s)}`, 'mi').test(text)
  );
  if (missing.length === 0) return { pass: true };
  return {
    pass: false,
    detail: `Missing sections: ${missing.join(', ')}`,
    auto_fix_hint: `Regenerate the missing sections (${missing.join(', ')}) with substantive content matching their purpose per templates/work-order-template.md.`,
  };
}

export function checkRequiredWoDecisionsPresent(decisionsYamlText: string): QACheckResult {
  const missing = REQUIRED_WO_DECISIONS.filter(
    (id) => !new RegExp(`\\bid:\\s*${escapeRegex(id)}\\b`).test(decisionsYamlText)
  );
  if (missing.length === 0) return { pass: true };
  return {
    pass: false,
    detail: `Missing wo-* decision rows: ${missing.join(', ')}`,
    auto_fix_hint: `Append the missing rows to decisions.yaml with the AI's best inference values and status: applied or status: open per skills/pdd-to-work-order/SKILL.md § Process step 4.`,
  };
}

export function checkPeriodOfPerformanceComplete(text: string): QACheckResult {
  const headerLine = text.match(/Period of Performance\s*\|\s*([^\n|]+)/i)?.[1]?.trim() ?? '';
  if (/\d{4}-\d{2}-\d{2}\s+to\s+\d{4}-\d{2}-\d{2}/i.test(headerLine) || /\[.*\]/.test(headerLine)) {
    return { pass: true };
  }
  return {
    pass: false,
    detail: 'Period of Performance header lacks both start and end dates (or an explicit placeholder).',
    auto_fix_hint: 'Set Period of Performance to "YYYY-MM-DD to YYYY-MM-DD" or to "[Period of Performance — TBD]" placeholder.',
  };
}

export function checkPaymentScheduleSumsTo100(text: string): QACheckResult {
  const section = text.split(/##\s*6\.2/i)[1]?.split(/##\s/i)[0] ?? '';
  const percents = Array.from(section.matchAll(/(\d{1,3})\s*%/g)).map((m) => parseInt(m[1], 10));
  if (percents.length === 0) {
    return { pass: false, detail: 'No payment-schedule percentages found in section 6.2.', auto_fix_hint: 'Render the payment schedule table with milestone percentages totaling 100%.' };
  }
  const total = percents.reduce((a, b) => a + b, 0);
  if (total === 100) return { pass: true };
  return {
    pass: false,
    detail: `Payment-schedule percentages sum to ${total} (must sum to 100).`,
    auto_fix_hint: 'Re-derive milestone percentages from the wo-payment-schedule-split decision and re-render.',
  };
}

export function checkTotalNtePresent(text: string): QACheckResult {
  const section = text.split(/##\s*6\.1/i)[1]?.split(/##\s/i)[0] ?? '';
  if (/USD\s+(\d|\[)/i.test(section)) return { pass: true };
  return {
    pass: false,
    detail: 'Total Not-to-Exceed (USD) value missing in section 6.1.',
    auto_fix_hint: 'Insert "USD <amount>" using the wo-total-not-to-exceed-usd decision, or "USD [TBD]" placeholder.',
  };
}

export function checkSignatureBlocksPresent(text: string): QACheckResult {
  const hasSub = /\*\*Subcontractor\*\*/i.test(text);
  const hasDimagi = /\*\*Dimagi.*\*\*/i.test(text);
  if (hasSub && hasDimagi) return { pass: true };
  const missing: string[] = [];
  if (!hasSub) missing.push('Subcontractor');
  if (!hasDimagi) missing.push('Dimagi');
  return {
    pass: false,
    detail: `Missing signature block(s): ${missing.join(', ')}`,
    auto_fix_hint: 'Re-add the missing signature block(s) per templates/work-order-template.md.',
  };
}

export function checkArchetypeAppropriateScope(text: string, archetype: string): QACheckResult {
  const scope = text.split(/##\s*2\.\s*Scope of Work/i)[1]?.split(/##\s/i)[0] ?? '';
  if (archetype === 'atomic-visit') {
    const hasVisit = /per visit|per-visit/i.test(scope);
    const hasPhotoOrGps = /photo|gps/i.test(scope);
    if (hasVisit && hasPhotoOrGps) return { pass: true };
    return {
      pass: false,
      detail: 'atomic-visit scope must reference per-visit deliverables and photo/GPS capture.',
      auto_fix_hint: 'Re-draft Scope of Work to include per-visit phrasing and photo + GPS evidence requirements.',
    };
  }
  if (archetype === 'focus-group') {
    const hasSession = /per session|per-session|attestation/i.test(scope);
    const hasGdoc = /gdoc|google doc/i.test(scope);
    if (hasSession && hasGdoc) return { pass: true };
    return {
      pass: false,
      detail: 'focus-group scope must reference per-session attestation + gdoc write-up.',
      auto_fix_hint: 'Re-draft Scope of Work to include per-session phrasing, attestation form submission, and gdoc write-up.',
    };
  }
  if (archetype === 'multi-stage') {
    const hasStage = /stage\s+1|stage\s+2|per stage/i.test(scope);
    if (hasStage) return { pass: true };
    return {
      pass: false,
      detail: 'multi-stage scope must reference at least one per-stage subsection.',
      auto_fix_hint: 'Re-draft Scope of Work with explicit per-stage subsections.',
    };
  }
  return { pass: false, detail: `Unknown archetype: ${archetype}`, auto_fix_hint: 'Declare archetype: atomic-visit | focus-group | multi-stage in the PDD frontmatter.' };
}

export function checkNoScaffoldingMarkers(text: string): QACheckResult {
  const markers = text.match(/<<[^>]*>>/g);
  if (!markers || markers.length === 0) return { pass: true };
  return {
    pass: false,
    detail: `Leaked AI scaffolding markers: ${[...new Set(markers)].join(', ')}`,
    auto_fix_hint: 'Resolve each <<...>> marker by filling in concrete content or replacing with a [Placeholder] bracket.',
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const CHECKS: QACheck[] = [
  { id: 'all_required_sections_present', run: (ctx) => checkAllRequiredSectionsPresent(ctx.workOrderText) },
  { id: 'required_wo_decisions_present', run: (ctx) => checkRequiredWoDecisionsPresent(ctx.decisionsYamlText) },
  { id: 'period_of_performance_complete', run: (ctx) => checkPeriodOfPerformanceComplete(ctx.workOrderText) },
  { id: 'payment_schedule_sums_to_100', run: (ctx) => checkPaymentScheduleSumsTo100(ctx.workOrderText) },
  { id: 'total_nte_present', run: (ctx) => checkTotalNtePresent(ctx.workOrderText) },
  { id: 'signature_blocks_present', run: (ctx) => checkSignatureBlocksPresent(ctx.workOrderText) },
  { id: 'archetype_appropriate_scope', run: (ctx) => checkArchetypeAppropriateScope(ctx.workOrderText, ctx.archetype) },
  { id: 'no_scaffolding_markers', run: (ctx) => checkNoScaffoldingMarkers(ctx.workOrderText) },
];
```

If `lib/qa-types.ts`'s `QACheck` type does not support a context-bearing `run`, adapt the `CHECKS` shape to match what `idea-to-pdd-qa/checks.ts` uses (and ignore the context argument — check signatures may take only a string in that codebase). Read the existing `QACheck` interface from `lib/qa-types.ts` before finalizing.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run test/skills/pdd-to-work-order-qa/checks.test.ts`
Expected: ALL PASS.

- [ ] **Step 10: Commit**

```bash
git add skills/pdd-to-work-order-qa/checks.ts test/skills/pdd-to-work-order-qa/
git commit -m "feat(pdd-to-work-order-qa): static checks + vitest coverage"
```

---

## Task 5: Producer `SKILL.md`

**Files:**
- Create: `skills/pdd-to-work-order/SKILL.md`

- [ ] **Step 1: Read the existing PDD producer skill for shape**

Read `skills/idea-to-pdd/SKILL.md` (you already have it loaded) — mirror the sections: frontmatter, Inputs, Products, Process, Archetypes, MCP Tools Used, Mode Behavior, Dry-Run Behavior, Change Log.

- [ ] **Step 2: Write the producer SKILL.md**

```markdown
---
name: pdd-to-work-order
description: >
  Draft a contractual Work Order from the approved PDD and the run's
  decisions.yaml. Generic by default — partner identity is a placeholder
  unless an LLO was supplied. Renders to a clean Google Doc. Parallel to
  Phase 8 solicitation, not a replacement.
disable-model-invocation: true
---

# PDD to Work Order

Take the approved PDD and decisions.yaml and produce a contractual Work Order draft, rendered as a clean Google Doc suitable for human review and signature.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 producer | `1-design/idea-to-pdd.md` | scope, deliverables, timeline, target population, success metrics, evidence model |
| Phase 1 producer | `decisions.yaml` | load-bearing values (rate, FLW count, working language, candidate LLO, etc.) — read as-is |
| Run-root | `inputs-manifest.yaml` | optional reference for partner identity if it was supplied as input |
| Operator (optional) | `--llo <slug>` flag | overrides partner-name placeholder |

## Products

- `ACE/<opp-name>/runs/<run-id>/1-design/pdd-to-work-order.gdoc` — the work-order Google Doc (re-runs create `pdd-to-work-order-2.gdoc`, `pdd-to-work-order-3.gdoc`, etc.)
- `run_state.yaml.phases.design.products.work_order` — `{title, file_id}` typed handoff. This skill is the sole writer.
- Appended `wo-*` rows in `ACE/<opp-name>/runs/<run-id>/decisions.yaml` (merge-only — never overwrites existing rows).

## Process

1. **Read inputs in parallel.** Issue one `drive_read_file` block for the PDD, decisions.yaml, and inputs-manifest. Trust context across subsequent steps (do not re-read).

2. **Determine archetype** from the PDD's frontmatter (`archetype: atomic-visit | focus-group | multi-stage`). The archetype branches the Scope of Work, Verification, Roles RACI, and Payment per-unit sections.

3. **Resolve contractual fields.** For each work-order field, apply the inference order:

   - (a) If an existing `decisions.yaml` row from an earlier skill covers it (e.g., `payment-rate`, `flw-count`, `working-language`, `budget-plausibility`), use that value as-is. Never duplicate or rename.
   - (b) If inferable from PDD body (Timeline → period of performance; Success Metrics + Budget → NTE; etc.), use the inference and emit a new `wo-*` row capturing it.
   - (c) If genuinely unknowable (partner name absent, WO# unknown, MSA date unknown), insert a bracketed placeholder like `[Partner Name]` in the gdoc and emit a `wo-*` row with `status: open` + `notes` telling the human what to fill in.

   Common `wo-*` rows to emit when load-bearing:

   | ID | Question | Map to surface |
   |---|---|---|
   | `wo-number` | Sequence number for this WO under the MSA | Header (placeholder if unknown) |
   | `wo-period-of-performance` | Start + end dates | Header + Timeline section |
   | `wo-total-not-to-exceed-usd` | Total NTE budget cap | Payment Terms section |
   | `wo-payment-schedule-split` | Milestone payment percentages (e.g., 40/60) | Payment Schedule sub-table |
   | `wo-mobilization-advance-pct` | Mobilization advance % of cap | Payment Schedule row 1 |
   | `wo-reporting-cadence` | Frequency of progress reports (default: weekly) | Reporting sub-section |
   | `wo-ethics-scope` | Operational-only vs patient-level | Ethics section |
   | `wo-data-storage-region` | Server region for data storage (default: US) | Data Handling section |

4. **Append `wo-*` rows to `decisions.yaml`** via `update_yaml_file` with merge-only semantics. Never overwrite existing rows. Required keys per row per `lib/decisions-schema.ts`: `id`, `phase: 1-design`, `skill: pdd-to-work-order`, `question`, `default`, `options_considered`, `source`, `status`. Optional `notes`.

5. **Render the work-order template to a Google Doc.**
   - `docs_copy_template(templateId=<WORK_ORDER_TEMPLATE_ID from env>, parent=<run-folder file_id>, name="Work Order — <opp-title>")`. If the run already has a `pdd-to-work-order.gdoc`, name the new one `Work Order — <opp-title> (#2)`, etc.
   - `docs_batch_update` with token replacements. Tokens use `{{...}}` snake_case:
     - `{{wo_number}}`, `{{opp_title}}`, `{{wo_date}}` (today, ISO), `{{wo_period_of_performance}}`
     - `{{background_body}}` (synthesized from PDD's Problem Statement + Intervention Design + any named downstream consumer)
     - `{{scope_body}}` (archetype-branched — see below)
     - `{{geographic_coverage_body}}` (from PDD Target Population; `[Geographic Coverage — Partner to propose]` if not specified)
     - `{{primary_deliverable_body}}`, `{{verified_unit_body}}` (from PDD Success Metrics + Evidence Model)
     - `{{reporting_body}}` (from `wo-reporting-cadence`)
     - `{{timeline_table}}` (markdown table from PDD Timeline)
     - `{{wo_total_not_to_exceed_usd}}`, `{{payment_schedule_table}}`
     - `{{roles_raci_table}}` (archetype-derived RACI)
     - `{{permissions_body}}`, `{{ethics_body}}`, `{{data_handling_table}}`
     - `{{pdd_link}}` (Drive URL of the PDD from `phases.design.products.pdd.file_id`)
     - `{{annexure_b_placeholder}}` ("To be provided" if no opp-specific annexure)

6. **Write `run_state.yaml.phases.design.products.work_order`** via `update_yaml_file` with `merge: 'two-level'`:

   ```yaml
   phases:
     design:
       products:
         work_order:
           title: "Work Order — <opp-title>"
           file_id: <gdoc-id>
   ```

7. **Invoke `decisions-render`** so the human-readable `decisions.gdoc` refreshes with the new `wo-*` rows.

## Archetypes

### `atomic-visit` (default)
- Scope: per-visit data capture with photo + GPS standardization.
- Verification: photo + GPS Layer A on the deliver-app form.
- Payment unit: per visit (rate from existing `payment-rate` decision).
- Roles: Dimagi configures app + verification audit; Partner recruits FLWs, runs field ops, transports samples (if applicable).

### `focus-group`
- Scope: per-session facilitation with attestation form submission and gdoc write-up.
- Verification: attestation submission Layer A + gdoc receipt Layer B; coordinator-graded practice-session-pass gates payment.
- Payment unit: per session (facilitator + notetaker rate from existing `per-session-rate` decision); facilitator training stipend on practice-session-pass.
- Roles: Dimagi configures OCS chatbot + attestation form + gdoc template; Partner recruits facilitators + notetakers, runs sessions, completes gdoc.

### `multi-stage`
- Scope: per-stage sub-section, each with its own archetype-shaped scope.
- Verification: per-stage criteria reflecting the stage's archetype.
- Payment: may mix per-visit and per-session units; stage-gate criteria from PDD.
- Roles: per-stage RACI.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`, `update_yaml_file`
- Google Docs: `docs_copy_template`, `docs_batch_update`

## Mode Behavior

- **Default (auto):** infer all fields, draft the gdoc, append `wo-*` rows, write `products.work_order`, proceed.
- **Review:** after the gdoc is written, pause and surface the gdoc URL for human approval before proceeding to the next phase.

## Dry-Run Behavior

When `--dry-run` is active:
- Write the work-order gdoc as normal (Drive writes are reversible).
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-21 | Initial version | ACE team |
```

- [ ] **Step 3: Verify SKILL.md frontmatter passes the skill catalog**

Run: `npm test -- test/skills/` (or whatever covers skill catalog validation)
Expected: PASS. If the catalog validator complains about a missing field, align frontmatter with `skills/idea-to-pdd/SKILL.md`.

- [ ] **Step 4: Commit**

```bash
git add skills/pdd-to-work-order/SKILL.md
git commit -m "feat(pdd-to-work-order): producer skill"
```

---

## Task 6: QA `SKILL.md`

**Files:**
- Create: `skills/pdd-to-work-order-qa/SKILL.md`

- [ ] **Step 1: Write the QA SKILL.md**

Mirror `skills/idea-to-pdd-qa/SKILL.md` (you've already read it). Frontmatter `name: pdd-to-work-order-qa`, `disable-model-invocation: true`. Include the 8-check table with `id`, `type: static`, `description`, `auto-fix on fail` columns matching `checks.ts § CHECKS`.

```markdown
---
name: pdd-to-work-order-qa
description: >
  Structural QA on the work-order artifact produced by pdd-to-work-order.
  Binary pass/fail. Catches missing sections, missing wo-* decision rows,
  malformed payment schedule, leaked scaffolding markers, etc. Static-only;
  no LLM. Gates pdd-to-work-order-eval — eval is skipped if QA fails
  irrecoverably.
disable-model-invocation: true
---

# PDD-to-Work-Order QA

Structural correctness checks on the work-order artifact. Binary verdict: pass / fail / incomplete. Eight static checks, all runnable in <100ms via the importable `checks.ts` module — no LLM.

See `skills/_qa-template.md` for the shared QA contract (verdict YAML format, auto-fix protocol, static-vs-LLM rules).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 producer | `1-design/pdd-to-work-order.gdoc` (latest) | the work order under structural check |
| Phase 1 producer | `decisions.yaml` | required `wo-*` decision-row presence check |

## Products

- `1-design/pdd-to-work-order-qa_result.yaml` — QA result per `lib/qa-types.ts` schema

## Checks

| # | id | type | description | auto-fix on fail |
|---|---|---|---|---|
| 1 | `all_required_sections_present` | static | All 11 required work-order sections present (Background, Scope of Work, Geographic Coverage, Deliverables and Verification, Timeline and Milestones, Payment Terms, Roles and Responsibilities, Permissions/Ethics/Compliance, Data Handling, Signatures, Annexures). | regenerate the missing section(s) with substantive content per templates/work-order-template.md |
| 2 | `required_wo_decisions_present` | static | All four required `wo-*` rows present in decisions.yaml: `wo-number`, `wo-period-of-performance`, `wo-total-not-to-exceed-usd`, `wo-payment-schedule-split`. | append the missing rows with AI's best inference + status: applied/open |
| 3 | `period_of_performance_complete` | static | Header's Period of Performance shows both start and end dates (or explicit placeholder). | render Period of Performance as "YYYY-MM-DD to YYYY-MM-DD" or "[Period of Performance — TBD]" |
| 4 | `payment_schedule_sums_to_100` | static | Milestone percentages in section 6.2 sum to 100. | re-derive percentages from `wo-payment-schedule-split` decision and re-render |
| 5 | `total_nte_present` | static | Total Not-to-Exceed USD value present in section 6.1 (number or `[Placeholder]`). | insert "USD <amount>" from `wo-total-not-to-exceed-usd` or `USD [TBD]` |
| 6 | `signature_blocks_present` | static | Both `**Subcontractor**` and `**Dimagi, Inc.**` signature blocks present. | re-add missing block per templates/work-order-template.md |
| 7 | `archetype_appropriate_scope` | static | Scope of Work language matches declared archetype: atomic-visit references per-visit + photo/GPS; focus-group references per-session + attestation + gdoc; multi-stage references per-stage subsections. | re-draft Scope of Work to match archetype |
| 8 | `no_scaffolding_markers` | static | No leaked `<<...>>` AI scaffolding markers in the work-order body. | resolve each marker with concrete content or `[Placeholder]` bracket |

The static check functions live at `skills/pdd-to-work-order-qa/checks.ts` as importable TS. Every check returns a `QACheckResult` (`{pass, detail?, auto_fix_hint?}`) per `lib/qa-types.ts`.

**Adding a check:** append to the `CHECKS` array in `checks.ts`, add a row to the table above (matching `id`), add a unit test in `test/skills/pdd-to-work-order-qa/checks.test.ts`.

## Process

1. **Read the work-order artifact.** Resolve the latest `pdd-to-work-order.gdoc` (the one referenced by `phases.design.products.work_order.file_id` in `run_state.yaml`). Read its body via `drive_read_file`.

2. **Read decisions.yaml** via `drive_read_file`.

3. **Read PDD archetype** from `run_state.yaml.phases.design.products.pdd` (or read the PDD body and parse the `archetype:` frontmatter line).

4. **Save artifact bodies to local temp paths** so the CLI runner can invoke `checks.ts`:
   ```bash
   TMP_WO=$(mktemp); TMP_DEC=$(mktemp)
   # write drive contents to $TMP_WO and $TMP_DEC
   ```

5. **Invoke the check runner** that imports `checks.ts § CHECKS` and runs each against `{workOrderText, decisionsYamlText, archetype}`. Output: a `QACheckResult[]` aligned with the `CHECKS` array.

6. **Compose and write the verdict YAML** to `1-design/pdd-to-work-order-qa_result.yaml` per the QA verdict schema (`lib/qa-types.ts`). `verdict: pass` iff every check passes; `verdict: fail` with `failures[]` array otherwise (each entry: `{check, detail, auto_fix_hint}`). `verdict: incomplete` if a check could not be evaluated (e.g., decisions.yaml unreadable).

7. **Trigger the producer-retry loop on `verdict: fail`** per `agents/idea-to-design.md § Step 2.4`. After retry: re-run QA. Halt with `verdict: incomplete` when the producer can no longer make progress on the same failures.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-21 | Initial version | ACE team |
```

- [ ] **Step 2: Add the QA skill row to `skills/_qa-decisions.md`**

Read `skills/_qa-decisions.md`. Find the table that registers per-producer QA status. Add a new row for `pdd-to-work-order` with status `has-qa` and rationale: "Static checks live; structural correctness is enforceable without an LLM (section presence, decision-row presence, payment-schedule arithmetic, signature blocks, scaffolding markers). Eval grades the substantive concerns."

- [ ] **Step 3: Commit**

```bash
git add skills/pdd-to-work-order-qa/SKILL.md skills/_qa-decisions.md
git commit -m "feat(pdd-to-work-order-qa): SKILL.md + registry entry"
```

---

## Task 7: Eval `SKILL.md`

**Files:**
- Create: `skills/pdd-to-work-order-eval/SKILL.md`

- [ ] **Step 1: Read the existing eval skill for shape**

Read `skills/idea-to-pdd-eval/SKILL.md` (use the Read tool) — mirror the frontmatter, dimension table, scoring scale, verdict shape, and process steps.

- [ ] **Step 2: Write the eval SKILL.md**

```markdown
---
name: pdd-to-work-order-eval
description: >
  Independent quality re-grade for the Work Order produced by
  pdd-to-work-order. LLM-as-Judge, five quality dimensions: contractual
  clarity, PDD alignment, decisions traceability, verification realism,
  archetype fit. Skipped if pdd-to-work-order-qa returned verdict:
  incomplete. Verdict shape per lib/verdict-schema.ts.
disable-model-invocation: true
---

# PDD-to-Work-Order Eval

LLM-as-Judge quality re-grade. Five dimensions, each scored `pass | partial | fail` with cited evidence from the work-order body and `decisions.yaml`. Two or more non-pass dimensions → `verdict: fail`. A `verdict: fail` here does NOT halt the run on its own — `[BLOCKER]` concerns pause per the orchestrator's Per-Mode Pause Matrix.

If `pdd-to-work-order-qa` returned `verdict: incomplete`, this skill is **skipped** and emits `verdict: incomplete` mirroring QA's outcome.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 producer | `1-design/pdd-to-work-order.gdoc` (latest) | the artifact under quality re-grade |
| Phase 1 producer | `1-design/idea-to-pdd.md` | source-of-truth for PDD alignment check |
| Phase 1 producer | `decisions.yaml` | source-of-truth for decisions traceability check |
| Phase 1 QA | `1-design/pdd-to-work-order-qa_result.yaml` | gating signal |

## Products

- `1-design/pdd-to-work-order-eval_verdict.yaml` — verdict per `lib/verdict-schema.ts`

## Dimensions

Each dimension is scored `pass | partial | fail` with a 1-3 sentence rationale citing specific evidence from the artifacts. Two or more non-pass → `verdict: fail`.

### 1. Contractual clarity
*Could the named partner sign this draft without coming back for clarification on scope, deliverables, payment, or roles?*

Common failure modes: scope describes the intervention but omits unit definitions ("samples" without saying what counts as a verified sample); deliverables reference verification criteria that aren't enumerated anywhere; payment per unit not stated; roles RACI omits responsibilities for sample storage or transport.

### 2. PDD alignment
*Do the scope, deliverables, timeline, and payment trace back to the PDD?*

Common failure modes: scope expands beyond PDD ("includes patient-level data collection" when PDD is operational-only); timeline contradicts PDD Timeline section; geographic coverage adds regions the PDD doesn't mention; payment per unit doesn't match the PDD's `payment-rate` decision.

### 3. Decisions traceability
*Do the contractual numerics in the work order match the corresponding rows in `decisions.yaml`?*

Common failure modes: per-visit rate in section 6 differs from `payment-rate` decision row; FLW count in roles section differs from `flw-count` decision row; period of performance in header differs from `wo-period-of-performance` decision row; total NTE in section 6.1 differs from `wo-total-not-to-exceed-usd`.

### 4. Verification realism
*Are the "verified unit" criteria in section 4.2 actually measurable on the Connect platform?*

Common failure modes: criterion requires data not captured by the Connect app (e.g., "temperature logged during transit" without a temperature field); criterion requires audit data the platform doesn't expose; criterion is subjective ("delivered in good condition") without an audit mechanism.

### 5. Archetype fit
*Does the work-order shape match the declared archetype?*

Common failure modes: declared archetype is `focus-group` but scope describes per-visit data collection; declared archetype is `atomic-visit` but payment schedule is per-session; multi-stage PDD with a single-stage work order.

## Process

1. **Check the gating signal.** Read `pdd-to-work-order-qa_result.yaml`. If `verdict: incomplete`, emit `pdd-to-work-order-eval_verdict.yaml` with `verdict: incomplete` and return. If `verdict: fail`, proceed (QA's failures are auto-fixable; eval still grades the substantive concerns of the latest draft).

2. **Read the artifacts.** Work order body, PDD body, decisions.yaml. Parallel `drive_read_file` block.

3. **Grade each dimension.** For each of the five dimensions:
   - State the dimension question.
   - Quote 1-3 specific pieces of evidence from the work order, PDD, or decisions.yaml.
   - Assign `pass | partial | fail` with a 1-3 sentence rationale.

4. **Compute the verdict.** `verdict: pass` if all dimensions pass. `verdict: partial` if exactly one is non-pass. `verdict: fail` if two or more are non-pass.

5. **Surface blockers.** Add a `concerns[]` array for any dimension grading `fail` where the underlying gap could compromise the contract's enforceability (e.g., verification criteria that aren't measurable, scope mismatches with PDD). Mark such entries `severity: blocker` so the orchestrator surfaces them at the Phase 1→2 pause.

6. **Write the verdict YAML** to `1-design/pdd-to-work-order-eval_verdict.yaml` per `lib/verdict-schema.ts`. Required keys: `skill`, `run_id`, `verdict`, `dimensions[]` (with `id`, `grade`, `evidence[]`, `rationale`), `concerns[]` (optional), `summary`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-21 | Initial version | ACE team |
```

- [ ] **Step 3: Commit**

```bash
git add skills/pdd-to-work-order-eval/SKILL.md
git commit -m "feat(pdd-to-work-order-eval): quality re-grade rubric"
```

---

## Task 8: Wire the new skills into the `idea-to-design` agent

**Files:**
- Modify: `agents/idea-to-design.md`

- [ ] **Step 1: Update the frontmatter `skills:` array**

Find the existing frontmatter block in `agents/idea-to-design.md`:

```yaml
skills:
  - { name: idea-to-pdd, has_judge: true, qa_skill: idea-to-pdd-qa, eval_skill: idea-to-pdd-eval }
```

Replace with:

```yaml
skills:
  - { name: idea-to-pdd, has_judge: true, qa_skill: idea-to-pdd-qa, eval_skill: idea-to-pdd-eval }
  - { name: pdd-to-work-order, has_judge: true, qa_skill: pdd-to-work-order-qa, eval_skill: pdd-to-work-order-eval }
```

- [ ] **Step 2: Append Step 2 / 2.4 / 2.5 to the workflow body**

Find the existing `### Completion` section near the end. Insert the following block immediately before `### Completion`:

```markdown
### Step 2: PDD → Work Order
Invoke the `pdd-to-work-order` skill.
- Inputs (already in subagent context from Step 1 — do NOT re-read):
  - `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md` (the PDD)
  - `ACE/<opp-name>/runs/<run-id>/decisions.yaml` (load-bearing decisions)
- Output:
  - `ACE/<opp-name>/runs/<run-id>/1-design/pdd-to-work-order.gdoc` (re-runs create `pdd-to-work-order-2.gdoc`, etc.)
  - `run_state.yaml.phases.design.products.work_order` block
  - Appended `wo-*` rows in `decisions.yaml` (merge-only)
- **Gate (review mode):** present the work-order URL for approval before continuing.

### Step 2.4: PDD-to-Work-Order QA (structural pass/fail)

Invoke the `pdd-to-work-order-qa` skill — runs 8 static structural checks against the produced work order.

- Input:
  - `ACE/<opp-name>/runs/<run-id>/1-design/pdd-to-work-order.gdoc` (latest)
  - `ACE/<opp-name>/runs/<run-id>/decisions.yaml`
- Output: `ACE/<opp-name>/runs/<run-id>/1-design/pdd-to-work-order-qa_result.yaml`
- **QA gates eval:** if `verdict: fail`, dispatch the producer with each `failures[].auto_fix_hint`, then re-run QA. Halt with `verdict: incomplete` when the producer can no longer make progress on the same failures. NEVER silently proceed to eval when QA failed.

### Step 2.5: PDD-to-Work-Order eval (independent quality re-grade)
Unless `--no-evals` was passed AND QA verdict is `pass`, invoke the `pdd-to-work-order-eval` skill.
- Inputs: work-order gdoc + PDD + decisions.yaml (all in subagent context).
- Output: `ACE/<opp-name>/runs/<run-id>/1-design/pdd-to-work-order-eval_verdict.yaml`
- If QA verdict was `incomplete`, this step is **skipped** (eval emits `verdict: incomplete`).
```

- [ ] **Step 3: Update the `### Completion` section**

Find:
```
Write phase summary to `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-design_summary.md`,
```

Insert after the summary path is computed (or in the summary content itself) a line listing both the PDD URL and the work-order URL. Concretely, update the summary contract:

```
The summary now lists both:
- PDD: `phases.design.products.pdd.file_id` (Drive URL)
- Work Order: `phases.design.products.work_order.file_id` (Drive URL)
```

- [ ] **Step 4: Verify the agent doc lints/validates**

Run any agent-frontmatter validator:
```
npm test -- agents/
```
Or grep for the catalog scripts:
```
grep -l "skills:" scripts/*.ts | head -3
```
If there's a `verify-agents.ts` or similar, run it. Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add agents/idea-to-design.md
git commit -m "feat(idea-to-design): wire pdd-to-work-order skill triple"
```

---

## Task 9: Update `.env.tpl` + operator-facing docs

**Files:**
- Modify: `.env.tpl`
- Create: `playbook/integrations/work-order-template.md`

- [ ] **Step 1: Add `WORK_ORDER_TEMPLATE_ID` to `.env.tpl`**

Find the existing `ACE_TRAINING_DECK_TEMPLATE_ID` line (around line 211). Add an adjacent entry following the same 1Password reference pattern. If the 1P field doesn't exist yet, document where to create it:

```
# Work-order template (Google Doc); see playbook/integrations/work-order-template.md to bootstrap.
WORK_ORDER_TEMPLATE_ID=op://AI-Agents/ACE - Open Chat Studio/Config/work_order_template_id
```

- [ ] **Step 2: Write the operator-facing bootstrap docs**

Create `playbook/integrations/work-order-template.md`:

```markdown
# Work-Order Template — Bootstrap

The `pdd-to-work-order` skill renders Work Orders by copying a Google Doc template and replacing `{{...}}` tokens. The template is per-deployment Drive state, not committed to the repo. This page documents how to provision it.

## One-time bootstrap

```bash
# Ensure ACE_TEMPLATES_FOLDER_ID is set (the Drive folder where ACE keeps its templates)
ACE_TEMPLATES_FOLDER_ID=<folder id> npx tsx scripts/bootstrap-work-order-template.ts
```

The script:
1. Reads `templates/work-order-template.md` (canonical content).
2. Uploads it to Drive as a Google Doc named "ACE Work Order Template".
3. Prints the resulting file_id to stdout.

Record the file_id in 1Password at `AI-Agents/ACE - Open Chat Studio/Config/work_order_template_id`, then re-run `op inject -i .env.tpl -o $CLAUDE_PLUGIN_DATA/.env --force` (or `/ace:setup --force-env`).

## Refresh

To replace an existing template with the latest `templates/work-order-template.md`:

```bash
ACE_TEMPLATES_FOLDER_ID=<folder id> WORK_ORDER_BOOTSTRAP_FORCE=1 \
  npx tsx scripts/bootstrap-work-order-template.ts
```

The old template is trashed (recoverable for 30 days in Drive) and a new one is created. Record the new file_id in 1Password.

## Token contract

The skill replaces these `{{...}}` tokens in the template:

| Token | Source |
|---|---|
| `{{wo_number}}` | `wo-number` decision (placeholder if open) |
| `{{opp_title}}` | PDD H1 |
| `{{wo_date}}` | today (ISO) |
| `{{wo_period_of_performance}}` | `wo-period-of-performance` decision |
| `{{background_body}}` | PDD Problem Statement + Intervention Design |
| `{{scope_body}}` | Archetype-branched |
| `{{geographic_coverage_body}}` | PDD Target Population |
| `{{primary_deliverable_body}}` | PDD Success Metrics + Evidence Model |
| `{{verified_unit_body}}` | PDD Evidence Model Layer A |
| `{{reporting_body}}` | `wo-reporting-cadence` |
| `{{timeline_table}}` | PDD Timeline |
| `{{wo_total_not_to_exceed_usd}}` | `wo-total-not-to-exceed-usd` decision |
| `{{payment_schedule_table}}` | `wo-payment-schedule-split` + `wo-mobilization-advance-pct` |
| `{{roles_raci_table}}` | Archetype-derived |
| `{{permissions_body}}`, `{{ethics_body}}` | Template defaults + PDD scope |
| `{{data_handling_table}}` | Template defaults + PDD data-subject treatment |
| `{{pdd_link}}` | `phases.design.products.pdd.file_id` URL |
| `{{annexure_b_placeholder}}` | "To be provided" if no opp-specific annexure |

Editing the template adds or removes tokens — make sure the skill's `## Process step 5` lists every token the template uses.
```

- [ ] **Step 3: Commit**

```bash
git add .env.tpl playbook/integrations/work-order-template.md
git commit -m "feat(env+docs): wire WORK_ORDER_TEMPLATE_ID + bootstrap docs"
```

---

## Task 10: End-to-end smoke validation against a real PDD

**Files:**
- (no new files)

- [ ] **Step 1: Pick a recent run with an approved PDD**

Run:
```bash
ls -la $CLAUDE_PLUGIN_DATA 2>/dev/null || echo "no plugin data dir"
```

Identify a recent opp + run from `/ace:status`:
```bash
/ace:status
```

Pick one whose PDD is in `1-design/idea-to-pdd.md`.

- [ ] **Step 2: Invoke the new skill via `/ace:step`**

```bash
/ace:step pdd-to-work-order <opp-name>/<run-id>
```

Expected:
- `1-design/pdd-to-work-order.gdoc` appears in Drive.
- `decisions.yaml` has new `wo-*` rows.
- `run_state.yaml.phases.design.products.work_order` is populated.

- [ ] **Step 3: Eyeball the generated gdoc**

Open the gdoc in the browser. Verify:
- All 11 sections present and substantive.
- Period of Performance has dates (or `[Placeholder]`).
- Payment schedule percentages sum to 100.
- Signature blocks present.
- Scope of Work language matches the PDD's declared archetype.

- [ ] **Step 4: Invoke `pdd-to-work-order-qa` via `/ace:step`**

```bash
/ace:step pdd-to-work-order-qa <opp-name>/<run-id>
```

Expected: `verdict: pass` in `1-design/pdd-to-work-order-qa_result.yaml`. If any check fails, capture the failure and either fix the producer (Step 5 token list, archetype branching) or the check (false positive in `checks.ts`).

- [ ] **Step 5: Invoke `pdd-to-work-order-eval` via `/ace:step`**

```bash
/ace:step pdd-to-work-order-eval <opp-name>/<run-id>
```

Expected: `verdict: pass` or `verdict: partial` with cited evidence per dimension. Read the verdict; if any dimension is `fail`, audit whether the work-order body genuinely fails that dimension or whether the rubric needs tightening.

- [ ] **Step 6: Capture findings (no commit unless code changed)**

If the smoke test surfaced any class-level bug, file an issue or open a follow-up PR. If everything ran clean, this is a no-op step.

---

## Task 11: Ship the change

**Files:**
- Modify: `VERSION` (via `scripts/version-bump.sh`)

- [ ] **Step 1: Bump version**

Run:
```bash
bash scripts/version-bump.sh
```

This writes `VERSION` + syncs the three sibling JSON files via the pre-commit hook on the next commit. The script picks `max(local, origin) + patch+1`.

- [ ] **Step 2: Commit the version bump**

```bash
git add VERSION .claude-plugin/plugin.json .claude-plugin/marketplace.json package.json
git commit -m "chore: bump VERSION for pdd-to-work-order skill"
```

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin emdash/work-order-1rjnp
gh pr create --title "feat(phase-1): pdd-to-work-order skill triple" --body "$(cat <<'EOF'
## Summary
- New Phase 1 skill `pdd-to-work-order` drafts a contractual Work Order from the approved PDD and the run's decisions.yaml.
- `wo-*` prefix for work-order-specific decision rows; existing decisions (`payment-rate`, `flw-count`, etc.) are read as-is.
- QA + eval companions: 8 static structural checks + 5-dimension LLM-as-Judge quality re-grade.
- Auto-invoked in `/ace:run` as Step 2 of the `idea-to-design` agent.
- Generic by default — `[Partner Name]` placeholder unless an LLO is supplied. Parallel to Phase 8 solicitation, not a replacement.

Spec: `docs/superpowers/specs/2026-05-21-work-order-skill-design.md`
Plan: `docs/superpowers/plans/2026-05-21-work-order-skill.md`

## Test plan
- [ ] `npx vitest run test/skills/pdd-to-work-order-qa/checks.test.ts` passes (8 check unit tests).
- [ ] `npm test` overall still green (no regressions in manifest tests).
- [ ] `npx tsc --noEmit scripts/bootstrap-work-order-template.ts` clean.
- [ ] Smoke test: `/ace:step pdd-to-work-order <opp>/<run>` against a recent approved PDD produces a clean work-order gdoc with expected sections and tokens replaced.
- [ ] QA `/ace:step pdd-to-work-order-qa <opp>/<run>` returns `verdict: pass` on the smoke-test artifact.
- [ ] Eval `/ace:step pdd-to-work-order-eval <opp>/<run>` returns `verdict: pass` or `verdict: partial` with cited evidence.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Arm auto-merge**

```bash
gh pr merge --auto --merge
```

- [ ] **Step 5: Wait for the merge, then update the local plugin**

After the PR merges (watch via `gh pr view --json state,mergedAt` if needed), run in this session:

```
/ace:update
```

If the change includes any MCP-server-side changes (it does not in this PR), also `/reload-plugins`.

---

## Notes for the implementing engineer

- **Skill files are stateless LLM-instruction documents.** Don't try to write Python/TS code "for" a SKILL.md — the LLM follows the instructions at runtime. `checks.ts` is the only TS file; it's pure functions.
- **`docs_copy_template` + `docs_batch_update`** are MCP atoms — use them via the gdrive MCP, not direct Google API calls in skill code. Skill code uses the MCP layer; only the bootstrap script touches Google API directly.
- **`decisions.yaml` merge semantics.** Use `update_yaml_file` with `merge: 'two-level'` (or whatever the existing pattern is — check how `idea-to-pdd` writes its decisions). Never overwrite existing rows. If a `wo-*` row already exists from a prior run of this skill, leave it (the new run picks the next free WO# variant from the gdoc name).
- **Re-run semantics.** Each `/ace:step pdd-to-work-order` creates a NEW gdoc (`pdd-to-work-order-2.gdoc`, `pdd-to-work-order-3.gdoc`, ...) and updates `phases.design.products.work_order.file_id` to point at the latest. Older gdocs stay in the run folder as audit trail.
- **Dimagi signatory is hardcoded** (Lucina Tse, COO) in the template — not parameterized. If a second signatory is ever needed, that's a follow-up PR that templatizes the Dimagi signature block.
- **Phase 8 still runs.** This skill is parallel to the solicitation, not a replacement. The work order may be signed independently after the solicitation is formally "awarded" to the pre-named LLO.

---

## Self-review checklist (run before handoff)

- [ ] **Spec coverage.** Every section in `docs/superpowers/specs/2026-05-21-work-order-skill-design.md` is implemented by at least one task:
  - Skill identity, inputs, outputs → Task 5
  - Decisions log convention (wo-* rows) → Tasks 5, 6 (QA check 2)
  - Process steps → Task 5
  - Section template → Task 2 (template content), Task 5 (skill renders it)
  - Archetype branching → Task 5 (skill), Task 4 (check 7)
  - QA 8 checks → Task 4 (TDD) + Task 6 (SKILL.md table)
  - Eval 5 dimensions → Task 7
  - Agent integration → Task 8
  - Write-back contract → Tasks 1 (manifest), 5 (skill writes `products.work_order`)
  - Template provisioning → Tasks 2 (canonical content), 3 (bootstrap script), 9 (operator docs)
  - Re-run semantics → Task 5 (skill creates new gdoc each time), Task 8 (Notes)
  - Dimagi signatory hardcoded → Task 2 (template), Task 5 (skill doesn't template it)
- [ ] **Placeholder scan.** No "TBD" / "fill in later" / "similar to Task N" — every step has concrete code or content.
- [ ] **Type consistency.** Check IDs in Task 4 (`all_required_sections_present`, etc.) match Task 6 SKILL.md table and Task 1 manifest descriptions.
- [ ] **Frequent commits.** Each task ends with `git commit`; no task batches multiple unrelated changes.
