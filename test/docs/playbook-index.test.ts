import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `playbook/README.md` is the "how do I do X on surface Y" index — the one
 * place a maintainer looks before changing something on a live program.
 *
 * An index rots silently: a new integration doc or learning that nobody adds
 * to it is invisible to exactly the reader the index exists for. Before this
 * file, 23 of the 36 learnings were linked from no playbook doc at all, and the
 * integration docs still described tools that were never built.
 *
 * Three assertions: every `playbook/integrations/*.md` and every
 * `docs/learnings/*.md` is named in the index, and every relative link the
 * index makes resolves. Observed and filed as ace#3153.
 */
const ROOT = join(__dirname, '..', '..');
const INDEX = join(ROOT, 'playbook', 'README.md');
const index = readFileSync(INDEX, 'utf8');

describe('playbook/README.md index', () => {
  it('lists every integration doc', () => {
    const docs = readdirSync(join(ROOT, 'playbook', 'integrations')).filter((f) => f.endsWith('.md'));
    const missing = docs.filter((f) => !index.includes(`integrations/${f}`));
    expect(missing, `add these to playbook/README.md § Surfaces`).toEqual([]);
  });

  it('lists every learning', () => {
    const learnings = readdirSync(join(ROOT, 'docs', 'learnings')).filter((f) => f.endsWith('.md'));
    const missing = learnings.filter((f) => !index.includes(f));
    expect(missing, `add these to playbook/README.md § Learnings by surface`).toEqual([]);
  });

  it('every relative link resolves', () => {
    const links = [...index.matchAll(/\]\((?!https?:)([^)#]+)(#[^)]*)?\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(10);
    const broken = links.filter((l) => !existsSync(join(ROOT, 'playbook', l)));
    expect(broken).toEqual([]);
  });
});
