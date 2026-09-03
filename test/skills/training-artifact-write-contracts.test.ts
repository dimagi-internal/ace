/**
 * Guards two doc contracts that were each self-contradicting once already.
 *
 * 1. Machine-parsed artifacts must not be written with `drive_create_file`.
 *    That tool creates a native Google Doc, which stores a document model
 *    rather than bytes — exporting one back turns every `\n` into
 *    `\r\n\r\n\r\n`. It also has no `mimeType` parameter, so the instruction
 *    "use drive_create_file, it must stay literal text" was not satisfiable as
 *    written. The rule was added to `_training-template.md` while all five
 *    training skills still said the opposite in their own "MCP Tools Used"
 *    sections — and the per-skill text is what gets read first.
 *
 * 2. Citing a frame and ASSERTING what it shows are different acts. The
 *    content check (`framesCitedWithoutShows` + `shows:`) has to stay named in
 *    the shared contract, or it decays to the same "everyone remembers it"
 *    convention that ace#866 and ace#1304 both already failed as.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SKILLS = path.join(__dirname, '..', '..', 'skills');
const TRAINING_SKILLS = [
  'training-flw-guide',
  'training-llo-guide',
  'training-faq',
  'training-quick-reference',
  'training-onboarding-email',
];

const read = (p: string) => fs.readFileSync(p, 'utf8');

describe('training skills — verdict YAML write contract', () => {
  for (const name of TRAINING_SKILLS) {
    it(`${name} does not tell the author to write the verdict with drive_create_file`, () => {
      const body = read(path.join(SKILLS, name, 'SKILL.md'));
      // The exact phrasing that shipped the contradiction.
      expect(body).not.toContain('machine-parsed, must stay literal text');
      // And it must positively name the tool that actually preserves bytes.
      expect(body).toContain('drive_upload_binary');
    });
  }

  it('the shared template explains WHY, not just what', () => {
    const tpl = read(path.join(SKILLS, '_training-template.md'));
    expect(tpl).toContain('Machine-parsed artifacts must not be written as Google Docs');
    // The mechanism has to survive, or the rule reads as arbitrary and gets
    // "simplified" back out by the next editor.
    expect(tpl).toMatch(/r\\n\\r\\n\\r\\n|\\r\\n/);
    expect(tpl).toContain('text/yaml');
  });
});

describe('screenshot citation contract — content, not just identity', () => {
  it('the shared template names the content check and the shows field', () => {
    const tpl = read(path.join(SKILLS, '_training-template.md'));
    expect(tpl).toContain('framesCitedWithoutShows');
    expect(tpl).toContain('shows:');
  });

  it('app-screenshot-capture instructs the producer to OPEN frames and record shows', () => {
    const skill = read(path.join(SKILLS, 'app-screenshot-capture', 'SKILL.md'));
    expect(skill).toContain('Pixel review');
    expect(skill).toContain('shows:');
    // The producer half of the duplicate rule must stay delegated to the
    // helper rather than restated as prose — restating it is what dropped the
    // auto-named-frame exception.
    expect(skill).toContain('assignCanonicalDuplicates');
  });

  it('the template still carries the older identity checks too', () => {
    const tpl = read(path.join(SKILLS, '_training-template.md'));
    expect(tpl).toContain('canonicalCaptures');
    expect(tpl).toContain('findDuplicateCitations');
  });
});
