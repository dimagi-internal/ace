/**
 * ace#1799 — the org-wide list atoms must not be able to overflow the
 * tool-result cap by default, and must offer the SAME path handle the rest of
 * this server already uses.
 *
 * This is the atom-registration half of the fix (the pure half is
 * test/lib/connect-list-projection.test.ts). It is a SOURCE-level test on
 * purpose: `mcp/connect-server.ts` does a top-level
 * `await server.connect(transport)`, so importing it connects stdio — the
 * same reason test/mcp/registration-coverage.test.ts parses statically.
 *
 * ace#1448 is why this exists at all: a fix can land in the backend and the
 * client and never reach `server.tool(...)`, in which case no caller can
 * reach it and the atom silently keeps its old behaviour.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');
const server = readFileSync(join(REPO, 'mcp/connect-server.ts'), 'utf8');

/** The source of one `server.tool('<name>', …)` registration + its handler. */
function toolSource(tool: string): string {
  const at = server.indexOf(`server.tool('${tool}'`);
  expect(at, `${tool} is not registered in mcp/connect-server.ts`).toBeGreaterThan(-1);
  const next = server.indexOf('server.tool(', at + 10);
  return server.slice(at, next === -1 ? server.length : next);
}

/** The Zod parameter keys of one registration. */
function schemaKeys(tool: string): string[] {
  const src = toolSource(tool);
  const seg = src.slice(0, src.indexOf('async (args)'));
  return [...new Set([...seg.matchAll(/^\s{4}([a-z_][a-z0-9_]*):\s*z\./gm)].map((m) => m[1]))];
}

describe('connect_list_programs — org-wide scan must fit in context (ace#1799)', () => {
  const keys = schemaKeys('connect_list_programs');
  const src = toolSource('connect_list_programs');

  it('the extractor found the registration', () => {
    expect(keys).toContain('organization_slug');
  });

  it('exposes write_to_path, reusing this server’s established param name', () => {
    // `commcare_download_ccz` established `write_to_path` in this same file.
    // A second name for the same idea (fromPath / outPath / …) makes the
    // pairing unguessable, which is its own defect.
    expect(keys).toContain('write_to_path');
  });

  it('returns programs_written_to INSTEAD of programs when write_to_path is set', () => {
    // Mirrors `ccz_written_to`: the handle REPLACES the payload. Returning
    // both would leave the payload in context and fix nothing.
    expect(src).toMatch(/programs_written_to/);
  });

  it('routes write_to_path through prepareWritePath (absolute-path + credential guard)', () => {
    // ace#1110 F4 — a write sink is an overwrite primitive.
    expect(src).toMatch(/prepareWritePath\(write_to_path\)/);
  });

  it('projects descriptions by DEFAULT, not behind an opt-in flag', () => {
    // An optional param defaulting to today's behaviour fixes nothing: Step 2
    // mandates the unfiltered call and would still get the oversized payload.
    expect(src).toMatch(/projectProgramDescriptions\(programs\)/);
    expect(keys).toContain('full_descriptions');
  });

  it('never truncates NAME-FILTERED rows — those are hydrated and Step 3a reconciles them', () => {
    // `listPrograms(name)` hydrates each match through `getProgram` (ace#1089),
    // and Step 3a compares that full description against the run's PDD.
    // Truncating it would silently corrupt the comparison.
    expect(src).toMatch(/const hydrated = name !== undefined/);
    expect(src).toMatch(/if \(hydrated \|\| full_descriptions\) return \{ programs/);
  });
});

describe('connect_list_opportunities — Step 4a Σ must not cost 80 KB (ace#1799)', () => {
  const keys = schemaKeys('connect_list_opportunities');
  const src = toolSource('connect_list_opportunities');

  it('the extractor found the registration', () => {
    expect(keys).toContain('organization_slug');
  });

  it('still exposes hydrate and the loud program_id refusal (ace#1448, ace#1022)', () => {
    expect(keys).toContain('hydrate');
    expect(keys).toContain('program_id');
  });

  it('exposes write_to_path, reusing this server’s established param name', () => {
    expect(keys).toContain('write_to_path');
    expect(src).toMatch(/opportunities_written_to/);
    expect(src).toMatch(/prepareWritePath\(write_to_path\)/);
  });

  it('exposes summarize_by_program — Step 4a’s whole computation, server-side', () => {
    expect(keys).toContain('summarize_by_program');
    expect(keys).toContain('duplicate_program_name');
    expect(src).toMatch(/summarizeOpportunitiesByProgram\(/);
  });

  it('summarize_by_program IMPLIES hydrate — Σ’s two inputs are dashboard-read', () => {
    // Summarizing an unhydrated listing would sum a column that is not there
    // and report 0 as a fact.
    expect(src).toMatch(/summarize_by_program !== undefined/);
    expect(src).toMatch(/hydrate: wantHydrate/);
  });

  it('summarize REPLACES the rows rather than adding to them', () => {
    // Returning both would leave the ~80 KB payload in context.
    expect(src).toMatch(/if \(summary\) return \{ listing: res\.listing, summary \}/);
  });

  it('still returns the listing completeness block in every mode (ace#1590)', () => {
    // `listing.complete !== true` is what makes Σ UNKNOWN; dropping it from
    // the summarize or write_to_path shapes would silently re-open ace#1590.
    const returns = [...src.matchAll(/return \{[^}]*\}/g)].map((m) => m[0]);
    const listingReturns = returns.filter((r) => /listing/.test(r));
    expect(listingReturns.length).toBeGreaterThanOrEqual(2);
  });

  it('feeds listing.complete into the summary rather than assuming it', () => {
    expect(src).toMatch(/listingComplete: res\.listing\.complete === true/);
    expect(src).toMatch(/listingTruncatedReason: res\.listing\.truncated_reason/);
  });
});
