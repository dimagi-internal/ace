import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `InputValidationError: … could not be parsed as JSON` is Claude Code's own
 * client-side error, and CLAUDE.md must say so where a reader will FIND it.
 *
 * ## The failure class: a correct note filed under the wrong heading
 *
 * The mechanism was established and written down once: `commcare-nova#459` was
 * closed NOT_PLANNED after request logs showed zero malformed bodies and 23.4 KB
 * payloads returning 200. The error is raised when streamed tool-call args fail
 * local `JSON.parse` BEFORE any request is made — the tool never ran.
 *
 * But it was filed inside CLAUDE.md's Nova paragraph. Anyone hitting the same
 * string on a different MCP has no reason to read the Nova bullet, so the class
 * has now been re-derived as a server defect twice:
 *
 *   1. Nova `add_fields` — a ~5-fields-per-call cadence guarding a size limit
 *      that does not exist, burning ~20 batches on one 51-field form.
 *   2. `ace-gdrive`'s `update_yaml_file` (Ada conduct cycle, 2026-09-02) — read
 *      as "callers must pre-serialize a nested patch into a JSON string, and the
 *      tool should accept a structured object instead". Both halves are false:
 *      `patch` is `z.record(z.unknown())` and always has been, and the logged
 *      payload was a real object, truncated at 6,119 bytes mid-generation.
 *
 * The second one nearly shipped a schema change to a tool whose schema was
 * already correct — and no server-side change can affect an error raised before
 * the request leaves the client, so the "return a schema-shaped reason instead
 * of an opaque parse error" remedy was unimplementable by construction.
 *
 * SCOPE, deliberately narrow. Two assertions about ONE note:
 *
 *   1. The note exists OUTSIDE the Nova paragraph — findable by a reader who
 *      arrived from any tool, not just Nova's.
 *   2. It states the load-bearing facts: client-side origin, that the call never
 *      reached the server, and that it is not a size limit. Deleting any of the
 *      three restores the exact misreading that produced both re-derivations.
 */

const ROOT = join(__dirname, '..', '..');
const CLAUDE_MD = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');

/** The bullet carrying the general note — i.e. NOT the Nova paragraph. */
function generalNoteBullet(): string | undefined {
  return CLAUDE_MD.split('\n- ')
    .find(
      (b) =>
        b.includes('could not be parsed as JSON') &&
        !b.includes('commcare-nova#545') &&
        !b.includes('Nova SHIPPED'),
    );
}

describe('InputValidationError provenance is documented outside the Nova bullet', () => {
  it('CLAUDE.md carries a standalone note, not only the Nova one', () => {
    const bullet = generalNoteBullet();
    expect(
      bullet,
      'CLAUDE.md documents `could not be parsed as JSON` ONLY inside the Nova ' +
        'paragraph. A reader debugging any other MCP will not find it there, ' +
        'and has twice re-derived it as a server defect. Keep a standalone ' +
        'gotcha entry.',
    ).toBeDefined();
  });

  it('the note states client-side origin, never-reached-the-server, and not-a-size-limit', () => {
    const bullet = generalNoteBullet() ?? '';
    const required: [RegExp, string][] = [
      [/client[- ]side/i, 'that the error is raised CLIENT-SIDE by Claude Code'],
      [
        /before any request is made|never ran|never saw|did not reach/i,
        'that the tool never ran / the request never reached the server',
      ],
      [/not a size limit|NOT a size limit/i, 'that it is NOT a payload size limit'],
    ];
    const missing = required.filter(([re]) => !re.test(bullet)).map(([, what]) => what);
    expect(
      missing,
      `The note dropped: ${missing.join('; ')}. Each one is a fact whose absence ` +
        'produced a real misdiagnosis — respectively: filing a schema bug against ' +
        'the MCP, "re-derive the payload the server rejected" (there is none), and ' +
        'defensive pre-batching against a limit that does not exist.',
    ).toEqual([]);
  });

  it('does not ASSERT that update_yaml_file requires a pre-serialized JSON string', () => {
    // Scan per bullet so the entry that DEBUNKS the claim (which necessarily
    // quotes it) is not itself read as making it. A bullet counts as a debunk
    // if it names the real schema or marks the quote as false.
    const DEBUNK = /z\.record|always has been|is false|are false|does not|misread/i;
    const asserted = CLAUDE_MD.split('\n- ').filter(
      (b) =>
        /update_yaml_file/.test(b) &&
        /pre-serializ|serialized JSON string/i.test(b) &&
        !DEBUNK.test(b),
    );
    expect(
      asserted,
      'A doc asserts `update_yaml_file` needs a pre-serialized patch. Its schema ' +
        'is `patch: z.record(z.unknown())` — a structured object, and always was. ' +
        'That misreading is what the 2026-09-02 finding rested on.',
    ).toEqual([]);
  });
});
