import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 1 reads reviewer comments on the INPUT documents, not only on the
 * prior run's PDD, and it replies to them without resolving (ace#2372).
 *
 * ## The failure class
 *
 * `drive_list_comments` had exactly one caller: `idea-to-pdd` step 1, reading
 * the PRIOR run's PDD. On a componentized programme the component PDDs in
 * `inputs/` ARE the design. Their author keeps them current through live
 * shortcuts and reviews them where she writes them. Measured 2026-09-11: 8
 * unresolved threads on the `poverty-graduation` Targeting PDD
 * (target `1u-QzTn1G82n5U5J5txjUFjoNOnlQzGEnmU3B57AcYNs`), none of which any
 * run had read. Nothing reported the loss.
 *
 * ## What this pins, and why each check is load-bearing
 *
 * 1. The comment step names the inputs manifest as a SOURCE. Without that,
 *    the author's threads stay invisible, which was the defect.
 * 2. The call goes to the shortcut's TARGET. `drive_list_comments` does not
 *    follow shortcuts (the shortcut id returned `File not found`), so an
 *    instruction that says "every input" but calls the entry's own `file_id`
 *    errors on every shortcut, i.e. on every componentized input. The check
 *    is tied to the atom: while its handler does not resolve shortcuts, the
 *    skill must carry `resolved_target_id`, and the manifest's producer and
 *    capture step must record that field.
 * 3. Never resolve an author's thread. Resolving stays for ACE's own PDD.
 *    Both halves are asserted, so neither can be dropped to satisfy the other.
 * 4. The already-incorporated case uses a disposition kind that actually
 *    exists in `lib/feedback-ledger.ts`. A kind that exists only in prose
 *    renders as UNROUTED, which tells the author "we ignored you".
 */

const REPO = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');

const SKILL = read('skills/idea-to-pdd/SKILL.md');
const ORCHESTRATOR = read('agents/ace-orchestrator.md');
const GDRIVE = read('mcp/google-drive-server.ts');
const LEDGER = read('lib/feedback-ledger.ts');

/** The input-document block, from its heading to the `## Open` reader rule. */
const INPUT_BLOCK_START = '**Read the comment threads on the INPUT documents too';
const INPUT_BLOCK_END = '**Read `## Open` ONLY.**';

function inputBlock(skill: string): string {
  const start = skill.indexOf(INPUT_BLOCK_START);
  if (start < 0) return '';
  const end = skill.indexOf(INPUT_BLOCK_END, start);
  return end < 0 ? skill.slice(start) : skill.slice(start, end);
}

/** The prior-run-PDD comment step: from its heading to the input block. */
function priorPddBlock(skill: string): string {
  const start = skill.indexOf("**Read the reviewer's COMMENTS on the prior run's PDD**");
  const end = skill.indexOf(INPUT_BLOCK_START);
  if (start < 0 || end < 0 || end < start) return '';
  return skill.slice(start, end);
}

/** The Inputs table rows (between `## Inputs` and `## Products`). */
function inputsTable(skill: string): string[] {
  const start = skill.indexOf('## Inputs');
  const end = skill.indexOf('## Products', start);
  return skill
    .slice(start, end)
    .split('\n')
    .filter((l) => l.startsWith('|'));
}

/** The body of one `server.tool('<name>', …)` registration. */
function toolBody(src: string, name: string): string {
  const start = src.indexOf(`'${name}',`);
  if (start < 0) return '';
  const next = src.indexOf('server.tool(', start);
  return next < 0 ? src.slice(start) : src.slice(start, next);
}

describe('idea-to-pdd reads comments on the INPUT documents (ace#2372)', () => {
  const block = inputBlock(SKILL);

  it('has the input-document comment block', () => {
    expect(block, `missing block starting "${INPUT_BLOCK_START}"`).not.toBe('');
  });

  it('names the frozen inputs manifest as a comment source, via drive_list_comments', () => {
    expect(block).toContain('inputs-manifest.yaml');
    expect(block).toContain('drive_list_comments');
    const row = inputsTable(SKILL).find(
      (l) => l.includes('drive_list_comments') && l.includes('inputs-manifest.yaml'),
    );
    expect(row, 'Inputs table has no row naming the manifest as a comment source').toBeDefined();
  });

  it('keeps the prior-run PDD as a source too (additive, not a replacement)', () => {
    const rows = inputsTable(SKILL).filter((l) => l.includes('drive_list_comments'));
    expect(rows.some((l) => /PRIOR run's PDD/.test(l))).toBe(true);
    expect(priorPddBlock(SKILL)).not.toBe('');
  });
});

describe('the author owns her thread: reply, never resolve', () => {
  const block = inputBlock(SKILL);

  it('replies on an input document without an action', () => {
    expect(block).toContain('drive_reply_to_comment');
    expect(block).toMatch(/WITHOUT `action`/);
  });

  it("forbids action: 'resolve' on an input document", () => {
    expect(block).toMatch(/Never pass `action: 'resolve'` on an input document/);
    // Removing the instruction is not enough: the block must not TELL anyone
    // to resolve. The only `action: 'resolve'` mention allowed is the ban.
    const mentions = block.match(/action: 'resolve'/g) ?? [];
    expect(mentions.length).toBe(1);
  });

  it("keeps reply-AND-resolve for ACE's own generated PDD", () => {
    const prior = priorPddBlock(SKILL);
    expect(prior).toMatch(/\*\*Reply and resolve\*\* — `drive_reply_to_comment` with `action: 'resolve'`/);
    expect(prior).toMatch(/ACE's OWN\s+generated PDD only/);
  });

  it('never edits the input document body', () => {
    expect(block).toMatch(/ACE never edits an\s+input document's body/);
  });
});

describe("the call goes to a shortcut's TARGET", () => {
  const block = inputBlock(SKILL);
  const listComments = toolBody(GDRIVE, 'drive_list_comments');

  it('the drive_list_comments registration is findable', () => {
    expect(listComments).toContain('drive.comments.list');
  });

  it('while the atom does not follow shortcuts, the skill must name resolved_target_id', () => {
    const atomFollowsShortcuts = /shortcut/i.test(listComments);
    if (atomFollowsShortcuts) return; // the atom resolves it; the instruction is belt-and-braces
    expect(block).toContain('resolved_target_id');
    expect(block).toMatch(/never on the shortcut's own `file_id`/);
  });

  it("the manifest's producer emits resolved_target_id for a shortcut", () => {
    expect(GDRIVE).toMatch(/entry\.resolved_target_id\s*=\s*f\.shortcutDetails\.targetId/);
  });

  it('the orchestrator capture step records resolved_target_id in the frozen manifest', () => {
    const start = ORCHESTRATOR.indexOf('**5c. Capture the manifest');
    const end = ORCHESTRATOR.indexOf('**5d.', start);
    const step5c = ORCHESTRATOR.slice(start, end);
    expect(step5c).toContain('resolved_target_id');
    expect(step5c).toContain('resolved_target_mime_type');
  });

  it("idea-to-pdd's own manifest shape shows a shortcut entry with its target", () => {
    expect(SKILL).toMatch(/mime_type: application\/vnd\.google-apps\.shortcut\n\s+resolved_target_id:/);
  });
});

describe('already-incorporated threads get a disposition, not a duplicate requirement', () => {
  const block = inputBlock(SKILL);

  it('names a disposition kind the ledger actually has', () => {
    const union = LEDGER.slice(
      LEDGER.indexOf('export type DispositionKind'),
      LEDGER.indexOf('export type DispositionStatus'),
    );
    const kinds = [...union.matchAll(/\|\s*'([a-z-]+)'/g)].map((m) => m[1]);
    expect(kinds).toContain('accepted-edit');
    expect(block).toContain('`accepted-edit`');
  });

  it('requires citing the section and forbids restating it as a new requirement', () => {
    expect(block).toMatch(/cites the section/);
    expect(block).toMatch(/Do NOT restate it as a new\s+requirement/);
  });

  it('captures each thread once: the Drive comment id rides in the item anchor', () => {
    expect(block).toMatch(/drive-comment:<id>/);
    expect(block).toMatch(/NOT\s+captured again/);
  });
});
