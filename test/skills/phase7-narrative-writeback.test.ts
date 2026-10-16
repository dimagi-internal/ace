import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const agent = read('agents/synthetic-data-and-workflows.md');
const narrative = read('skills/demo-narrative/SKILL.md');

// ace#2254. The canopy DDD loop edits its own spec/why-brief copies and nothing
// carried them back: on spark-facilitator/20260907-1120 a withdrawn honesty
// claim stayed live on Drive (rev 10 == rev 7) and on canopy-web (v1), and check
// 14 passed the stale Drive spec over zero evaluations.
describe('Phase 7 writes the converged narrative back after the DDD loop (ace#2254)', () => {
  const start = agent.indexOf('### Step 3.5: Carry the converged narrative back');
  const end = agent.indexOf('### Step 3.9');
  const step = agent.slice(start, end);

  it('sits after the DDD dispatch and runs for every terminal status', () => {
    expect(start).toBeGreaterThan(agent.indexOf('### Step 3: Render + converge'));
    expect(end).toBeGreaterThan(start);
    expect(step).toMatch(/whatever its `terminal_status`/);
  });

  it('overwrites both Drive artifacts from the loop copies by localFilePath', () => {
    expect(step).toMatch(/drive_update_file\(\{fileId, localFilePath\}\)/);
    expect(step).toMatch(/unified_spec_ref/);
    expect(step).toMatch(/why_brief_ref/);
    expect(step).toMatch(/docs\/walkthroughs\/<slug>\.yaml/);
  });

  it('posts the story with the real canopy verb, never pull, and handles a pending review', () => {
    expect(step).toMatch(/scripts\.ddd\.narrative post /);
    expect(step).toMatch(/Never `narrative pull`/);
    expect(step).toMatch(/Exit 3/);
    expect(step).toMatch(/narrative_guard check/);
  });

  it('re-runs check 14 on the PUSHED spec and records judged', () => {
    expect(step).toMatch(/Re-run check 14 on the PUSHED spec/);
    expect(step).toMatch(/checkScrollFraming/);
    expect(step).toMatch(/judged/);
  });

  it('the write-back schema carries the record', () => {
    expect(agent).toMatch(/ddd-run: +\{ status: done, writeback:/);
  });

  it('demo-narrative: a re-author posts, never pulls', () => {
    const s = narrative.slice(narrative.indexOf('4b. **A re-author'), narrative.indexOf('5. **Write back**'));
    expect(s).toMatch(/narrative post/);
    expect(s).toMatch(/`narrative pull`/);
    expect(s).toMatch(/ace#2254/);
  });
});

// ace#2347. Finale rules 2 (show the rate) and 3 (a visible consequence) are
// PAGE requirements. Inside a narrative-only scope they could only be met by
// narrating what the page does not show — a claim_reality_coherence defect
// (spark-facilitator/20260910-0541).
describe('the finale rules that live on the page say how to land them (ace#2347)', () => {
  const s = narrative.slice(narrative.indexOf('**Rules 2 and 3 are PAGE requirements'), narrative.indexOf('   - `scenes[]` — each scene'));

  it('patches the dashboard, lint first, with the render-code atoms', () => {
    expect(s).toMatch(/workflow_update_render_code/);
    expect(s).toMatch(/check-render-code-utilities\.ts/);
    expect(s.indexOf('check-render-code-utilities')).toBeLessThan(s.indexOf('workflow_update_render_code'));
  });

  it('links the payoff check that already says "authored onto the page"', () => {
    expect(s).toMatch(/checkEscapedPayoffIsHonoured/);
    expect(s).toMatch(/authored onto\s+the page/);
  });

  it('names narrating an unshown rate or consequence as a claim_reality_coherence defect', () => {
    expect(s).toMatch(/Never narrate a rate or a consequence the page does not show/);
    expect(s).toMatch(/claim_reality_coherence/);
  });
});
