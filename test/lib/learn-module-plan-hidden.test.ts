/**
 * The componentized Learn plan builds modules it then HIDES for a model. Connect
 * counts every learn module toward completion (models.py:398-406 at
 * c7409bd35), so a hidden marked module makes Learn uncompletable — ace#3036.
 */
import { describe, expect, it } from 'vitest';

import { planLearnModules } from '../../lib/learn-module-plan';

describe('planLearnModules — hidden modules cannot be completed on Connect (ace#3036)', () => {
  it('flags built-but-hidden modules', () => {
    const plan = planLearnModules({
      components: [
        { component_id: '1', title: 'A', pdd_file_id: 'a' },
        { component_id: '2', title: 'B', pdd_file_id: 'b' },
      ],
      activeComponentIds: ['1'],
      frameworkComponentIds: ['1', '2'],
    });
    const gap = plan.gaps.find((g) => g.code === 'hidden-modules-block-learn-completion');
    expect(gap?.components).toEqual(['2']);
    expect(gap?.detail).toMatch(/Learn completion/);
  });

  it('does not flag a model that shows every built module', () => {
    const plan = planLearnModules({ components: [{ component_id: '1', title: 'A', pdd_file_id: 'a' }], frameworkComponentIds: ['1'] });
    expect(plan.gaps.map((g) => g.code)).not.toContain('hidden-modules-block-learn-completion');
  });
});
