import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * dimagi-internal/ace#3238 — three training skills told the author to pass
 * `--screenshots <drive_folders.screenshots from app-screenshot-capture_manifest.yaml>`
 * to `scripts/embed-doc-screenshots.ts`, but `app-screenshot-capture` § Step 6
 * never wrote a `drive_folders` block. Since output previews contract v1 the
 * passing frames are split across `3-commcare/previews/apps-learn/` and
 * `.../apps-deliver/`, so a single "screenshots" folder no longer exists at all.
 * Repro: connect-fi/20261018-1440 Phase 6, where the FLW-guide author found the
 * folders by hand.
 *
 * The contract pinned here: every `drive_folders.<key>` any skill names is a key
 * the producer's Step 6 `drive_folders:` block declares.
 */

const ROOT = join(__dirname, '..', '..');
const SKILLS = join(ROOT, 'skills');
const PRODUCER = join(SKILLS, 'app-screenshot-capture', 'SKILL.md');

function producerDriveFolderKeys(): string[] {
  const md = readFileSync(PRODUCER, 'utf-8');
  const blocks = [...md.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);
  const block = blocks.find((b) => /^drive_folders:/m.test(b));
  expect(block, 'app-screenshot-capture must show a drive_folders: yaml block').toBeDefined();
  const parsed = parseYaml(block!) as { drive_folders: Record<string, unknown> };
  return Object.keys(parsed.drive_folders ?? {});
}

function allSkillFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(SKILLS, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) out.push(join(SKILLS, entry.name));
    if (entry.isDirectory()) {
      const p = join(SKILLS, entry.name, 'SKILL.md');
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

describe('capture manifest drive_folders contract (ace#3238)', () => {
  it('the producer declares one folder per previews leg plus forensics', () => {
    expect(producerDriveFolderKeys().sort()).toEqual(
      ['forensics', 'previews_deliver', 'previews_learn'],
    );
  });

  it('every drive_folders.<key> a skill names is written by the producer', () => {
    const keys = new Set(producerDriveFolderKeys());
    const unknown: string[] = [];
    for (const f of allSkillFiles()) {
      const text = readFileSync(f, 'utf-8');
      for (const m of text.matchAll(/drive_folders\.([a-z_]+)/g)) {
        if (!keys.has(m[1])) unknown.push(`${f.slice(ROOT.length + 1)}: drive_folders.${m[1]}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('the illustrated-guide embed steps pass both previews folders', () => {
    for (const rel of [
      'skills/_training-template.md',
      'skills/training-llo-guide/SKILL.md',
      'skills/training-flw-guide/SKILL.md',
    ]) {
      const text = readFileSync(join(ROOT, rel), 'utf-8');
      expect(text, rel).toContain('--screenshots <drive_folders.previews_learn');
      expect(text, rel).toContain('--screenshots <drive_folders.previews_deliver');
      // The retired single-folder phrasing must not come back.
      expect(text, rel).not.toMatch(/drive_folders\.screenshots|capture manifest's drive_folders>/);
    }
  });
});
