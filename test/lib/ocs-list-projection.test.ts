/**
 * ace#1901 — the pure half of the `ocs_list_chatbots` payload fix.
 * (The atom-registration half is
 * test/mcp/ocs/list-chatbots-payload-handles.test.ts.)
 *
 * NEGATIVE-CONTROL NOTE. `projectChatbotVersions` is a NEW symbol, so there is
 * no honest pre-fix red run for the tests that call it — against pre-fix code
 * they fail on a missing import, not on an assertion. The `CONTROL:` block at
 * the bottom is the substitute: it runs against UNTOUCHED code
 * (`projectProgramDescriptions`, shipped by the sibling PR #1897 and not
 * modified here) and is what actually falsifies the design decision — it shows
 * the sibling's 400-char recipe, transplanted here, leaves the payload over
 * the 40,000-char inline ceiling.
 */
import { describe, it, expect } from 'vitest';
import {
  projectChatbotVersions,
  CHATBOT_VERSIONS_PROJECTION_NOTE,
} from '../../lib/ocs-list-projection.js';
import { projectProgramDescriptions } from '../../lib/connect-list-projection.js';

/**
 * The per-version description LENGTHS measured on team `connect-ace`
 * 2026-09-02 off `GET /api/experiments/?page_size=50` — 50 rows, 109 version
 * entries, Σ 61,234 chars. Lengths only; no live prose is checked in.
 */
const LIVE_DESCRIPTION_LENGTHS: number[][] = [
  [0, 2269, 250], [0, 135, 168], [0, 3153, 217], [0, 1952, 238, 564], [0, 2046, 2896],
  [0, 1117], [0, 2686], [0, 2710], [0, 709], [0, 99], [0, 2092, 1752], [0, 1654],
  [0, 1482], [0, 784], [0, 1084], [0, 590], [0, 187], [0, 145], [0, 202], [0, 360],
  [0, 1111], [0, 954], [0, 213], [0, 930], [0, 61], [0, 1085], [0, 1115], [0, 61],
  [0, 1107], [0, 1132], [0, 1123], [0, 1064], [0, 1075], [0, 937], [0, 1051], [0, 1045],
  [0, 1193, 257], [0, 1132], [0, 1127], [0, 1594], [0, 1017], [0, 1454, 321], [0, 1485],
  [0, 1491], [0, 987], [0, 41], [0, 1305], [0, 374], [0, 954], [0, 897],
];

/** A page shaped like the live one, with the measured description lengths. */
function livePage() {
  return LIVE_DESCRIPTION_LENGTHS.map((lengths, i) => ({
    id: `075abf86-b9bb-476f-8b9e-eed1d1f2478${i % 10}`,
    name: `ACE - opportunity-${i} (2026090${i % 10}-1200)`,
    url: `https://www.openchatstudio.com/api/experiments/075abf86-b9bb-476f-8b9e-eed1d1f2478${i % 10}/`,
    version_number: lengths.length + 1,
    experiment_id: 12000 + i,
    versions: lengths.map((len, v) => ({
      // Live version entries carry `name` too (measured Σ 4,406 chars over the
      // 109 entries — ~40 each, the chatbot's own name).
      name: `ACE - opportunity-${i} (2026090${i % 10}-1200)`,
      version_number: v + 1,
      is_default_version: v === lengths.length - 1,
      version_description: 'x'.repeat(len),
    })),
  }));
}

describe('projectChatbotVersions', () => {
  it('replaces versions[] with a two-field summary', () => {
    const { chatbots } = projectChatbotVersions([
      {
        id: 'a',
        name: 'bot',
        versions: [
          { version_number: 1, is_default_version: false, version_description: 'first' },
          { version_number: 2, is_default_version: true, version_description: 'published one' },
          { version_number: 3, is_default_version: false, version_description: 'draft' },
        ],
      },
    ]);
    expect(chatbots[0]).not.toHaveProperty('versions');
    expect(chatbots[0].versions_summary).toEqual({ count: 3, published_version_number: 2 });
  });

  it('reads the PUBLISHED version from is_default_version, not from position (ace#891)', () => {
    // The working counter runs ahead of the published default. Reading the
    // last entry, or the row's own `version_number`, writes an off-by-one into
    // run_state.yaml that llo-launch's freshness check later trips over.
    const { chatbots } = projectChatbotVersions([
      {
        id: 'a',
        versions: [
          { version_number: 1, is_default_version: false },
          { version_number: 2, is_default_version: true },
          { version_number: 3, is_default_version: false },
        ],
      },
    ]);
    expect(chatbots[0].versions_summary?.published_version_number).toBe(2);
  });

  it('reports published_version_number: null when nothing is flagged default', () => {
    // A bot with only a working draft. Null is the honest answer; guessing the
    // highest version number would report an unpublished draft as live.
    const { chatbots } = projectChatbotVersions([
      { id: 'a', versions: [{ version_number: 1, is_default_version: false }] },
    ]);
    expect(chatbots[0].versions_summary?.published_version_number).toBeNull();
  });

  it('passes rows with NO versions key through untouched, and does not count them', () => {
    // Absent is not the same as emptied — a row that never carried the array
    // must not sprout a `versions_summary` claiming it has zero versions.
    const rows: Array<{ id: string; name: string; versions?: [] }> = [
      { id: 'a', name: 'no-versions' },
    ];
    const r = projectChatbotVersions(rows);
    expect(r.chatbots[0]).not.toHaveProperty('versions_summary');
    expect(r.projected_rows).toBe(0);
  });

  it('handles an empty versions[] as a real (zero-count) summary', () => {
    const r = projectChatbotVersions([{ id: 'a', versions: [] }]);
    expect(r.chatbots[0].versions_summary).toEqual({ count: 0, published_version_number: null });
    expect(r.projected_rows).toBe(1);
  });

  it('reports the NET saving, not the gross size of what it dropped', () => {
    // `chars_removed` has to net off the summary that replaced the array, or
    // the atom reports a saving it did not make.
    const versions = [{ version_number: 1, is_default_version: true, version_description: 'y'.repeat(2000) }];
    const r = projectChatbotVersions([{ id: 'a', versions }]);
    const summaryCost = JSON.stringify({ count: 1, published_version_number: 1 }).length;
    expect(r.chars_removed).toBe(JSON.stringify(versions).length - summaryCost);
    expect(r.version_entries_dropped).toBe(1);
  });

  it('does not mutate its input', () => {
    const rows = [{ id: 'a', versions: [{ version_number: 1, is_default_version: true }] }];
    projectChatbotVersions(rows);
    expect(rows[0].versions).toHaveLength(1);
  });

  it('the note names the replacement read, so a truncation is never silent', () => {
    expect(CHATBOT_VERSIONS_PROJECTION_NOTE).toMatch(/ocs_get_chatbot/);
    expect(CHATBOT_VERSIONS_PROJECTION_NOTE).toMatch(/full_versions|write_to_path/);
  });
});

describe('the live page fits in context after projection (ace#1901)', () => {
  /** The ceiling the rest of the plugin already uses for inline payloads. */
  const INLINE_CEILING = 40_000;

  it('reproduces the measured default-page size within 1%', () => {
    // Anchors the fixture to the live measurement it was taken from. If this
    // drifts, every comparison below is about a different payload.
    const chars = JSON.stringify({ chatbots: livePage() }).length;
    expect(chars).toBeGreaterThan(86_000);
    expect(chars).toBeLessThan(88_000);
    expect(chars).toBeGreaterThan(INLINE_CEILING);
  });

  it('the projected page lands under the inline ceiling', () => {
    const { chatbots } = projectChatbotVersions(livePage());
    const chars = JSON.stringify({ chatbots }).length;
    expect(chars).toBeLessThan(INLINE_CEILING);
    // Measured: 14,676 chars for the real page.
    expect(chars).toBeLessThan(16_000);
  });

  it('CONTROL: the sibling recipe (#1897), transplanted here, does NOT clear the ceiling', () => {
    // Runs `projectProgramDescriptions` — UNTOUCHED by this PR — over the same
    // live descriptions the issue proposed applying it to. 42 of the 109
    // entries are over 400 chars, so the cap retains 20,129 chars of prose and
    // the surrounding version objects keep the rest.
    //
    // This is the assertion that falsifies "just do what #1799 did". It is a
    // real red against code this PR does not modify.
    const page = livePage();
    const capped = page.map((row) => ({
      ...row,
      versions: projectProgramDescriptions(
        row.versions.map((v) => ({ ...v, description: v.version_description })),
      ).programs.map(({ version_description: _drop, ...v }) => v),
    }));
    const chars = JSON.stringify({ chatbots: capped }).length;
    expect(chars).toBeGreaterThan(INLINE_CEILING);
    // Measured on the real page: 47,083 chars.
    expect(chars).toBeGreaterThan(45_000);
  });
});
