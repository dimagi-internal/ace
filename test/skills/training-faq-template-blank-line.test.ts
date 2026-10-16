import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ace#2998: a bold FAQ question line immediately followed by its answer is ONE
// markdown paragraph, so the published Doc merged Q and A. Every bold question
// in the § Format template must be followed by a blank line.
// Observed: smallholder-seasonal/20261015-1402, Phase 6 training-faq.
describe('training-faq § Format template', () => {
  const md = readFileSync(join(__dirname, '../../skills/training-faq/SKILL.md'), 'utf8');
  const template = md.split('## Format\n')[1].split('```markdown\n')[1].split('\n```')[0];
  const lines = template.split('\n');
  const isQuestion = (l: string) => /^\*\*\[(FLW|LLO)\] Q: /.test(l);

  it('has bold question lines', () => {
    expect(lines.filter(isQuestion).length).toBeGreaterThan(0);
  });

  it('puts a blank line after every bold question line', () => {
    const offenders = lines.filter((l, i) => isQuestion(l) && lines[i + 1]?.trim() !== '');
    expect(offenders).toEqual([]);
  });
});
