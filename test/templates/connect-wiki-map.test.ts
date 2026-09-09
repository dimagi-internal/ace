import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

/**
 * The Connect wiki page map is well-formed AND actually read by something.
 *
 * ## Why the second half matters more than the first
 *
 * A committed data file with no caller is the failure this repo keeps
 * relearning: ace#1877 shipped `assignCanonicalDuplicates` plus a skill line
 * saying "call it", and nothing called it — verified by grep, only its own
 * tests referenced it. It read as done for a release. A curated wiki map is
 * exactly that shape of artifact: it is inert data, it has a green liveness
 * probe, and every structural check passes whether or not a single deck ever
 * cites it.
 *
 * So the assertions below deliberately include "a caller exists": both
 * training generate prompts must name the map, and every `WIKI_*_URL` token in
 * `_common/resources.yaml` must appear in both prompts' override blocks. An
 * unresolved token is not a silent no-op — it renders the literal
 * `{{WIKI_PAYMENTS_URL}}` onto a slide an FLW reads.
 *
 * Liveness (do the URLs still resolve?) is deliberately NOT here — that needs
 * the network, and a required check that depends on Confluence uptime teaches
 * people to ignore red checks. It lives in
 * `scripts/probe-connect-wiki-map.ts`.
 */

const REPO = join(__dirname, '..', '..');
const DECKS = join(REPO, 'templates', 'training-deck');
const MAP_PATH = join(DECKS, '_common', 'connect-wiki-map.yaml');
const TRAINING_PROMPTS = [
  join(DECKS, 'connect-training-atomic', 'generate.prompt.md'),
  join(DECKS, 'connect-training-fgd', 'generate.prompt.md'),
];

interface Page {
  id: number;
  title: string;
  url: string;
}
interface Map {
  base: string;
  space_key: string;
  verified_on: string;
  sections: Record<string, { audience: string; pages: Page[] }>;
  excluded?: Array<{ id?: number; ids?: number[]; title: string; reason: string }>;
}

const map = yaml.load(readFileSync(MAP_PATH, 'utf8')) as Map;
const allPages = Object.entries(map.sections).flatMap(([section, b]) =>
  b.pages.map((p) => ({ section, ...p })),
);

describe('connect-wiki-map.yaml shape', () => {
  it('declares a base, space key and a string verified_on', () => {
    expect(map.base).toBe('https://dimagi.atlassian.net/wiki');
    expect(map.space_key).toBe('connectpublic');
    // A string, not a Date. Unquoted `2026-09-09` parses to a JS Date, which
    // then prints as "Wed Sep 09 2026 05:30:00 GMT+0530" in the probe output.
    expect(typeof map.verified_on).toBe('string');
    expect(map.verified_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('gives every page a numeric id, a title, and a url built from base+id', () => {
    expect(allPages.length).toBeGreaterThan(10);
    for (const p of allPages) {
      expect(Number.isInteger(p.id), `${p.section}: id must be an integer`).toBe(true);
      expect(p.title.length).toBeGreaterThan(2);
      // The numeric id in the path is what keeps the URL stable across page
      // renames. A slug-only URL breaks the moment someone retitles the page.
      expect(p.url.startsWith(map.base), `${p.title}: url must start with base`).toBe(true);
      expect(p.url.includes(String(p.id)), `${p.title}: url must contain its id`).toBe(true);
    }
  });

  it('has no duplicate page ids across sections', () => {
    const seen = new globalThis.Map<number, string>();
    const dupes: string[] = [];
    for (const p of allPages) {
      const prior = seen.get(p.id);
      if (prior && prior !== p.section) dupes.push(`${p.id} in both ${prior} and ${p.section}`);
      else seen.set(p.id, p.section);
    }
    expect(dupes).toEqual([]);
  });

  it('tags every section with a valid audience', () => {
    for (const [key, block] of Object.entries(map.sections)) {
      expect(['flw', 'llo', 'both'], `${key}: bad audience`).toContain(block.audience);
    }
  });
});

describe('connect-wiki-map.yaml has a caller (anti-orphan)', () => {
  it('both training generate prompts name the map file', () => {
    for (const prompt of TRAINING_PROMPTS) {
      const body = readFileSync(prompt, 'utf8');
      expect(body, `${prompt} must read connect-wiki-map.yaml`).toContain(
        'connect-wiki-map.yaml',
      );
    }
  });

  it('every WIKI_*_URL token in resources.yaml is resolved by both prompts', () => {
    const resources = readFileSync(join(DECKS, '_common', 'resources.yaml'), 'utf8');
    const tokens = [...resources.matchAll(/\{\{(WIKI_[A-Z0-9_]*_URL)\}\}/g)].map((m) => m[1]);

    // If this is empty the slide stopped citing the wiki and the map is inert
    // again — which is the whole failure this suite exists to catch.
    expect(new Set(tokens).size).toBeGreaterThan(0);

    for (const prompt of TRAINING_PROMPTS) {
      const body = readFileSync(prompt, 'utf8');
      for (const token of new Set(tokens)) {
        expect(
          body.includes(token),
          `${prompt} never resolves ${token}, so it would render literally on a slide`,
        ).toBe(true);
      }
    }
  });

  it('every section the prompts reference actually exists in the map', () => {
    // Guards the other direction: a prompt pointing at
    // `sections.does_not_exist.pages[0].url` resolves to nothing.
    for (const prompt of TRAINING_PROMPTS) {
      const body = readFileSync(prompt, 'utf8');
      const refs = [...body.matchAll(/sections\.([a-z_]+)\.pages/g)].map((m) => m[1]);
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(
          Object.keys(map.sections),
          `${prompt} references unknown section "${ref}"`,
        ).toContain(ref);
      }
    }
  });
});

describe('excluded pages stay excluded', () => {
  it('records a reason for every exclusion', () => {
    for (const ex of map.excluded ?? []) {
      expect(ex.reason.length).toBeGreaterThan(20);
      expect(ex.id ?? ex.ids).toBeDefined();
    }
  });

  it('never links an excluded page id from anywhere in the map', () => {
    const excludedIds = (map.excluded ?? []).flatMap((e) => e.ids ?? [e.id!]);
    // The [WIP] onboarding guide is the one that matters: unstable content must
    // not reach a deck an LLO reads, and it is the page most likely to look
    // tempting to a future editor skimming the space.
    expect(excludedIds.length).toBeGreaterThan(0);
    for (const id of excludedIds) {
      expect(
        allPages.some((p) => p.id === id),
        `page ${id} is listed as excluded but also mapped`,
      ).toBe(false);
    }
  });
});
