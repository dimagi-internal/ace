import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

// dimagi-internal/ace#3064. A `retryTapIfNoChange` tap on btn_start re-taps
// while POST /users/start_learn_app/ is still in flight (the hierarchy has not
// changed yet), and the second success callback crashes CommCare 2.64.0:
//   IllegalArgumentException ... action_connect_job_intro_fragment_to_connect_downloading_fragment
//   cannot be found from the current destination connect_downloading_fragment
//   at ConnectJobIntroFragment$1.onSuccess(ConnectJobIntroFragment.java:161)
// Observed with the retried tap twice (ace#2584 spark-facilitator/20261001-2208;
// ace#3064 baseline 02-learn-install 2026-10-16); a single tap on a fresh opp
// (20260730-1718, worker-1, 2026-10-17) did not crash. So no tap on btn_start
// may carry `retryTapIfNoChange`.

const RECIPES = [
  'mcp/mobile/recipes/static/connect-claim-opp.yaml',
  'mcp/mobile/recipes/baseline/02-learn-install.yaml',
];

const START_IDS = new Set(['org.commcare.dalvik:id/btn_start', '${SELECTOR:opp-detail-start}']);

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');
}

/** Every `tapOn` mapping anywhere in the recipe's step tree. */
function tapOns(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) node.forEach((n) => tapOns(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'tapOn' && v && typeof v === 'object') out.push(v as Record<string, unknown>);
      tapOns(v, out);
    }
  }
  return out;
}

function startTaps(text: string): Record<string, unknown>[] {
  const docs = parseAllDocuments(text).map((d) => d.toJS());
  return tapOns(docs).filter((t) => START_IDS.has(String(t.id)));
}

describe('btn_start is tapped without retryTapIfNoChange (ace#3064)', () => {
  for (const rel of RECIPES) {
    it(`${rel}: every btn_start tap is a single tap`, () => {
      const taps = startTaps(read(rel));
      expect(taps.length).toBeGreaterThan(0);
      for (const t of taps) expect(t.retryTapIfNoChange, JSON.stringify(t)).not.toBe(true);
    });
  }

  it('control: the pre-fix shape (retried btn_start tap) is caught', () => {
    const before = [
      'appId: org.commcare.dalvik',
      '---',
      '- tapOn:',
      '    id: "org.commcare.dalvik:id/btn_start"',
      '    retryTapIfNoChange: true',
    ].join('\n');
    expect(startTaps(before).some((t) => t.retryTapIfNoChange === true)).toBe(true);
  });

  it('connect-claim-opp keeps a delayed, guarded re-tap for genuine tap loss', () => {
    const y = read('mcp/mobile/recipes/static/connect-claim-opp.yaml');
    expect(y).toMatch(
      /extendedWaitUntil:\s*\n\s*notVisible:\s*\n\s*id: "\$\{SELECTOR:opp-detail-start\}"\s*\n\s*timeout: 15000\s*\n\s*optional: true/,
    );
  });
});

describe('01-claim-opp matches OPP_NAME as a fragment, not a full string (ace#3064)', () => {
  // Maestro `text:` is a full-string regex: OPP_NAME=20260730-2210 failed
  // scrollUntilVisible with the tile "20260730-2210 · Household Poverty
  // Targeting Survey" fully on screen (2026-10-16).
  const y = read('mcp/mobile/recipes/baseline/01-claim-opp.yaml');
  it('every OPP_NAME text match is wrapped as ".*${OPP_NAME}.*"', () => {
    const matches = y.match(/^\s*text: .*OPP_NAME.*$/gm) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) expect(m.trim()).toBe('text: ".*${OPP_NAME}.*"');
  });
  it('the header no longer claims a substring match', () => {
    expect(y).not.toMatch(/substring by default/);
  });
});
