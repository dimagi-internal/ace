/**
 * ace#1901 — `ocs_list_chatbots`'s DEFAULT page must fit in the tool-result
 * cap, and it must offer the same path handle the rest of the plugin uses.
 *
 * This is the atom-registration half of the fix (the pure half is
 * test/lib/ocs-list-projection.test.ts). It is a SOURCE-level test on purpose:
 * `mcp/ocs-server.ts` does a top-level `await server.connect(transport)`, so
 * importing it connects stdio — the same reason
 * test/mcp/registration-coverage.test.ts parses statically.
 *
 * ace#1448 is why this exists at all: a fix can land in the backend and the
 * client and never reach `server.tool(...)`, in which case no caller can reach
 * it and the atom silently keeps its old behaviour.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');
const server = readFileSync(join(REPO, 'mcp/ocs-server.ts'), 'utf8');

/** The source of one `server.tool(\n  '<name>', …)` registration + its handler. */
function toolSource(tool: string): string {
  const at = server.indexOf(`server.tool(\n  '${tool}'`);
  expect(at, `${tool} is not registered in mcp/ocs-server.ts`).toBeGreaterThan(-1);
  const next = server.indexOf('server.tool(', at + 10);
  return server.slice(at, next === -1 ? server.length : next);
}

/** The Zod parameter keys of one registration. */
function schemaKeys(tool: string): string[] {
  const src = toolSource(tool);
  const seg = src.slice(0, src.indexOf('async (args)'));
  return [...new Set([...seg.matchAll(/^\s{4}([a-z_][a-z0-9_]*):\s*z\b/gm)].map((m) => m[1]))];
}

describe('ocs_list_chatbots — the DEFAULT page must fit in context (ace#1901)', () => {
  const keys = schemaKeys('ocs_list_chatbots');
  const src = toolSource('ocs_list_chatbots');

  it('the extractor found the registration', () => {
    expect(keys).toContain('team_slug');
  });

  it('projects versions[] by DEFAULT, not behind an opt-in flag', () => {
    // The whole point of the issue: `page_size`/`next_cursor` already exist
    // and do not help, because the FIRST page is already over the cap. An
    // optional param defaulting to today's behaviour would fix nothing.
    expect(src).toMatch(/projectChatbotVersions\(out\.chatbots\)/);
    expect(keys).toContain('full_versions');
  });

  it('the projection is applied only when the caller did NOT ask for full rows', () => {
    expect(src).toMatch(/if \(full_versions\) return result\(out\)/);
  });

  it('exposes write_to_path, reusing the name commcare_download_ccz established', () => {
    // Same param name + `<thing>_written_to` semantics as
    // `commcare_download_ccz` and the connect list handles added in ace#1799.
    // A second name for the same idea is its own defect.
    expect(keys).toContain('write_to_path');
  });

  it('returns chatbots_written_to INSTEAD of chatbots when write_to_path is set', () => {
    // Mirrors `ccz_written_to` / `programs_written_to`: the handle REPLACES
    // the payload. Returning both would leave the payload in context.
    expect(src).toMatch(/chatbots_written_to/);
    // The write branch must return before the inline branch can serialize rows.
    const writeAt = src.indexOf('chatbots_written_to');
    const inlineAt = src.indexOf('projectChatbotVersions');
    expect(writeAt).toBeLessThan(inlineAt);
  });

  it('routes write_to_path through prepareWritePath (absolute-path + credential guard)', () => {
    // ace#1110 F4 — a write sink is an overwrite primitive.
    expect(src).toMatch(/prepareWritePath\(write_to_path\)/);
  });

  it('the path handle writes the UNPROJECTED rows — the escape hatch must be complete', () => {
    // A handle that wrote the projected rows would offer no way to reach the
    // dropped prose at all, which is what makes it an escape hatch.
    expect(src).toMatch(/JSON\.stringify\(\{ chatbots: out\.chatbots \}/);
  });

  it('tells the reader where the dropped prose lives', () => {
    // A projection that does not name its own replacement read is a silent
    // truncation; the caller cannot tell it is missing anything.
    expect(src).toMatch(/CHATBOT_VERSIONS_PROJECTION_NOTE/);
    expect(src).toMatch(/versions_projection/);
  });

  it('the description states the measurement, not a round adjective', () => {
    // CLAUDE.md rule 1: the number in a contract must be traceable.
    expect(src).toMatch(/87,009|85\.9%/);
    expect(src).toMatch(/ace#1901/);
  });
});
