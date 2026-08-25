/**
 * Class-level preventer for dimagi-internal/ace#1632.
 *
 * `_app-component-library.md` is the single source both build skills read.
 * Each component declares an **Enforced by** line, and that line already
 * distinguishes the two enforcement paths:
 *
 *   - a build-time eval dimension  → the architect can satisfy it, so the
 *     component's Brief paragraph belongs in the `/nova:autobuild` brief;
 *   - "applied post-build by <skill>" → the setting lives on a surface Nova
 *     does not author (CommCare HQ), so briefing it asks the architect for
 *     something structurally impossible.
 *
 * `grid-menu-display` was the second kind and sat in BOTH build skills'
 * emit-checklists anyway, so every Nova build reported a spurious "unmet
 * requirement" in the build memo — the one artifact meant to carry REAL
 * deviations — twice per run. Live on bednet-check-2-visit/20260825-1310:
 * the Learn architect searched the deferred tool catalogue three ways, found
 * no atom, and reported it unmet; `app-hq-settings` (Step 2.65) then applied
 * all three fields HQ-side on the first attempt.
 *
 * The rail: a component whose **Enforced by** names a post-build skill may
 * appear in a build skill's emit-checklist ONLY with an explicit
 * do-not-brief marker naming the post-build owner. The point is the class,
 * not the row — the next HQ-side-only component is caught on arrival.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SKILLS = fileURLToPath(new URL('../../skills/', import.meta.url));
const library = readFileSync(`${SKILLS}_app-component-library.md`, 'utf8');

const BUILD_SKILLS = ['pdd-to-learn-app', 'pdd-to-deliver-app'] as const;

/** Sections of the library keyed by component name (`### <name>`). */
function components(): Map<string, string> {
  const out = new Map<string, string>();
  const parts = library.split(/\n(?=### )/);
  for (const part of parts) {
    const m = /^### ([a-z0-9-]+)\s*$/m.exec(part.split('\n')[0]);
    if (!m) continue;
    out.set(m[1], part);
  }
  return out;
}

/** Components whose enforcement happens AFTER the Nova build, HQ-side. */
function postBuildComponents(): string[] {
  const names: string[] = [];
  for (const [name, body] of components()) {
    const enforcedBy = /- \*\*Enforced by:\*\*([\s\S]*?)(?=\n- \*\*|\n\*\*Brief paragraph)/.exec(
      body,
    );
    if (!enforcedBy) continue;
    if (/applied post-build by/i.test(enforcedBy[1])) names.push(name);
  }
  return names;
}

describe('post-build components are not briefed to Nova (ace#1632)', () => {
  it('the library still parses into components with Enforced-by lines', () => {
    const parsed = components();
    expect(parsed.size, 'no `### <component>` sections parsed — re-point this rail').
      toBeGreaterThan(10);
    expect(parsed.has('grid-menu-display')).toBe(true);
  });

  it('detects the post-build enforcement path (sanity)', () => {
    const post = postBuildComponents();
    expect(
      post,
      'grid-menu-display is applied post-build by app-hq-settings — if this no ' +
        'longer parses, the Enforced-by wording moved and the rail is blind',
    ).toContain('grid-menu-display');
  });

  it('every post-build component named in a build skill carries a do-not-brief marker', () => {
    const post = postBuildComponents();
    for (const skill of BUILD_SKILLS) {
      const body = readFileSync(`${SKILLS}${skill}/SKILL.md`, 'utf8');
      // Emit-checklist entries are bullets that OPEN with the component name.
      const bullets = body
        .split(/\n(?=\s*- `)/)
        .filter((b) => /^\s*- `[a-z0-9-]+`/.test(b));

      for (const name of post) {
        const entry = bullets.find((b) => b.trimStart().startsWith(`- \`${name}\``));
        if (!entry) continue;
        expect(
          entry.replace(/\s+/g, ' '),
          `${skill}: \`${name}\` is applied post-build (HQ-side), but its ` +
            'emit-checklist entry does not say so — its Brief paragraph then goes ' +
            'verbatim into the /nova:autobuild brief and the architect can only ' +
            'report an unmet requirement it has no atom to satisfy (ace#1632). ' +
            'Say "do NOT put it in the Nova brief" and name the post-build owner.',
        ).toMatch(/do NOT put it in the Nova brief/i);
      }
    }
  });

  it('the library marks grid-menu-display DO NOT BRIEF THIS', () => {
    const section = components().get('grid-menu-display')!;
    expect(
      section,
      'the library is the shared source both build skills read — the marker has ' +
        'to live here or the next author re-adds the paragraph (ace#1632)',
    ).toMatch(/DO NOT BRIEF THIS/);
  });
});
