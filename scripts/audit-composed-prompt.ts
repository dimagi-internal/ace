#!/usr/bin/env npx tsx
/**
 * audit-composed-prompt.ts — the RUNTIME CALLER for
 * `lib/standing-fabrication-domains.ts` (dimagi-internal/ace#2015).
 *
 * Usage:
 *   npx tsx scripts/audit-composed-prompt.ts <prompt-file>
 *   npx tsx scripts/audit-composed-prompt.ts --stdin < prompt.md
 *   ... [--json]
 *
 * Exit codes:
 *   0 — the `## Do not invent operational specifics` section exists and
 *       carries every standing domain. Safe to publish.
 *   1 — the section is missing, or one or more standing domains are absent.
 *       The composed prompt MUST NOT be published. `ocs-agent-setup`
 *       § Step 7.5 halts the phase on this.
 *   2 — harness error (no argument, unreadable file, empty prompt). Not a
 *       verdict about the prompt; do not treat it as a pass OR as a miss.
 *
 * WHY A SCRIPT AND NOT PROSE. `61e7a785` shipped `auditComposedPrompt()` as
 * the preventer for the ace#1142 fabrication class and nothing ever called
 * it — only its own test did. What that test could pin was that
 * `skills/ocs-agent-setup/SKILL.md` LISTS the four labels; it cannot see the
 * prompt any given run composes, because that prompt is authored at run time
 * by an agent reading that document and pushed straight to OCS. So the
 * invariant reduced to "the agent followed the checklist", which is exactly
 * the prose-does-not-bind failure this repo has now paid for five times on
 * the eval side (ace#1646, #1890, #1891, #1935, #1955 — each one a rule that
 * read correctly and did not fire, replaced by a deterministic pass).
 *
 * An exit code is the halt. A boolean an agent is asked to check is another
 * checklist item.
 *
 * Reads NO environment and makes NO network call — the audit is pure string
 * work over the prompt handed to it, so this script is safe to run anywhere
 * and needs none of the plugin-data `.env` loading the ace#1964 ratchet
 * governs.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  auditComposedPrompt,
  formatStandingDomainReport,
  ANTI_FABRICATION_HEADING,
  STANDING_FABRICATION_DOMAINS,
} from '../lib/standing-fabrication-domains.js';

const USAGE = `Usage:
  npx tsx scripts/audit-composed-prompt.ts <prompt-file> [--json]
  npx tsx scripts/audit-composed-prompt.ts --stdin [--json]

Audits a composed OCS system prompt for the STANDING half of its
"## ${ANTI_FABRICATION_HEADING}" section (${STANDING_FABRICATION_DOMAINS.length} domains).

Exit 0 = every standing domain present (safe to publish).
Exit 1 = section missing or a domain missing (DO NOT publish).
Exit 2 = harness error.`;

export interface AuditCliArgs {
  /** Path to read the prompt from, or null when reading stdin. */
  file: string | null;
  json: boolean;
}

/**
 * Parse argv. Exported so the failure modes are unit-testable without
 * spawning: an unknown flag is a harness error, not a silently ignored one.
 */
export function parseArgs(argv: string[]): AuditCliArgs | { error: string } {
  let file: string | null = null;
  let stdin = false;
  let json = false;

  for (const arg of argv) {
    if (arg === '--stdin') stdin = true;
    else if (arg === '--json') json = true;
    else if (arg === '-h' || arg === '--help') return { error: USAGE };
    else if (arg.startsWith('-')) return { error: `unknown flag: ${arg}\n\n${USAGE}` };
    else if (file !== null) return { error: `more than one prompt file given: ${file}, ${arg}` };
    else file = arg;
  }

  if (stdin && file !== null) return { error: '--stdin takes no file argument' };
  if (!stdin && file === null) return { error: `no prompt given\n\n${USAGE}` };
  return { file: stdin ? null : file, json };
}

function main(argv: string[]): number {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }

  let prompt: string;
  try {
    prompt =
      parsed.file === null
        ? fs.readFileSync(0, 'utf8')
        : fs.readFileSync(parsed.file, 'utf8');
  } catch (err) {
    process.stderr.write(`cannot read prompt: ${(err as Error).message}\n`);
    return 2;
  }

  if (prompt.trim() === '') {
    // An empty prompt is a harness error, not a failed audit. Reporting it as
    // a miss would send the operator to rewrite a section of a file that has
    // no content at all.
    process.stderr.write('the prompt is empty — nothing to audit\n');
    return 2;
  }

  const audit = auditComposedPrompt(prompt);

  if (parsed.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: audit.ok,
          section_present: audit.sectionPresent,
          covered: audit.covered,
          missing: audit.missing.map((d) => ({ id: d.id, label: d.label, why: d.why })),
        },
        null,
        2,
      )}\n`,
    );
  }

  if (audit.ok) {
    if (!parsed.json) {
      process.stdout.write(
        `[STANDING-DOMAINS] OK — all ${STANDING_FABRICATION_DOMAINS.length} standing domains ` +
          `present in "## ${ANTI_FABRICATION_HEADING}".\n`,
      );
    }
    return 0;
  }

  process.stderr.write(`${formatStandingDomainReport(audit)}\n`);
  process.stderr.write(
    '\nDO NOT publish this prompt. Add the missing domain(s) to the ' +
      `"## ${ANTI_FABRICATION_HEADING}" section per ` +
      '`skills/ocs-agent-setup/SKILL.md` § Step 7, then re-run this audit.\n',
  );
  return 1;
}

// Only run when invoked directly, so the arg parser stays importable.
// `pathToFileURL` rather than string-concatenating `file://`: a guard that
// mis-compares exits 0 having audited nothing, which is the one failure mode
// a publish gate must not have.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}

export { main };
