import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// dimagi-internal/ace#992 — a section must be attributed to the file that
// actually carries it.
//
// The defect: TEN citations across nine agent files pointed at
// "agents/ace-orchestrator.md § <Section>" for sections that live in its
// sibling, agents/orchestrator-reference.md. Every phase agent cited a
// dangling reference for the very Phase Write-Back Contract it must obey, and
// it survived for months because nothing checked.
//
// SCOPE, deliberately narrow. This asserts ONE thing: no agent doc attributes
// a section to `ace-orchestrator.md` when that section exists in
// `orchestrator-reference.md` and NOT in `ace-orchestrator.md`. That is the
// exact misattribution class, and it needs no prose heuristics — the proof is
// positive (the section is demonstrably in the other file), so a citation that
// merely runs into a sentence cannot trip it.
//
// A general "every § citation resolves" check was tried first and rejected:
// citations legitimately run into prose ("§ Fork Points and the per-opp
// table") and headings legitimately continue past the citation ("§ Step 4"
// citing "Step 4 — structural verification"), so it degenerated into
// linting English rather than catching misattribution.
// ---------------------------------------------------------------------------

const AGENTS_DIR = fileURLToPath(new URL('../agents/', import.meta.url));
const ORCH = 'ace-orchestrator.md';
const REF = 'orchestrator-reference.md';

function headingWordLists(file: string): string[][] {
  const md = readFileSync(`${AGENTS_DIR}${file}`, 'utf8');
  return [...md.matchAll(/^#{2,6}\s+(.+?)\s*$/gm)].map((m) => normalize(m[1]));
}

function normalize(t: string): string[] {
  return t
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9-]/g, ''))
    .filter(Boolean);
}

/** Does any heading in `lists` begin with every word of `want`? */
function someHeadingStartsWith(lists: string[][], want: string[]): boolean {
  return want.length > 0 && lists.some((h) => want.every((w, i) => h[i] === w));
}

const orchHeadings = headingWordLists(ORCH);
const refHeadings = headingWordLists(REF);
// orchestrator-reference.md is EXCLUDED, and the exclusion is principled
// rather than convenient: it is the definition site for these sections, and
// its own citations run the other way ("Relocated rationale for
// `ace-orchestrator.md § Pre-flight Step 4`") — pointing back at the doc it is
// the reference FOR. That direction is correct and is not the class here.
const agentFiles = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md') && f !== REF);

describe('agents/*.md attribute sections to the file that carries them (#992)', () => {
  it('both orchestrator docs parse and carry headings (sanity)', () => {
    expect(orchHeadings.length).toBeGreaterThan(5);
    expect(refHeadings.length).toBeGreaterThan(5);
  });

  it('orchestrator-reference.md really is where the Phase Write-Back Contract lives', () => {
    // The anchor case. If this ever moves, the test below must be revisited
    // rather than silently passing on a stale premise.
    expect(someHeadingStartsWith(refHeadings, normalize('Phase Write-Back Contract'))).toBe(true);
    expect(someHeadingStartsWith(orchHeadings, normalize('Phase Write-Back Contract'))).toBe(false);
  });

  it.each(agentFiles)('%s does not attribute a reference section to ace-orchestrator.md', (file) => {
    const md = readFileSync(`${AGENTS_DIR}${file}`, 'utf8');
    const bad: string[] = [];

    // Tolerates a newline between the filename and the § — several of the
    // ace#992 offenders were wrapped that way, which is why a single-line
    // grep missed them.
    for (const m of md.matchAll(
      /ace-orchestrator\.md\s*\n?\s*§\s*([A-Za-z0-9 ,'`\-—:]+)/g,
    )) {
      const cited = normalize(m[1].replace(/`/g, ''));
      // Try progressively shorter leading spans so trailing prose can't hide
      // a real section name.
      for (let n = Math.min(cited.length, 6); n >= 1; n--) {
        const span = cited.slice(0, n);
        if (someHeadingStartsWith(orchHeadings, span)) break; // legitimately there
        if (someHeadingStartsWith(refHeadings, span)) {
          bad.push(`"§ ${span.join(' ')}" is in ${REF}, not ${ORCH}`);
          break;
        }
      }
    }

    expect(
      [...new Set(bad)],
      `${file} attributes section(s) to the wrong orchestrator doc:\n  ${bad.join('\n  ')}\n\n` +
        `Cite ${REF}. (ace#992: ten refs named ${ORCH} for sections that live in its sibling.)`,
    ).toEqual([]);
  });
});
