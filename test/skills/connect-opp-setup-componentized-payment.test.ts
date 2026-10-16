import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ace#2163. connect-opp-setup § Archetypes modelled only the archetype axis, so
// a componentized programme declared `longitudinal-visits` got "one payment
// unit for the whole arc" — and a single PU over independently payable
// components withholds the first component's payment until the last lands
// (`required_deliver_units` requires ALL listed DUs). Observed on
// poverty-graduation/20260905-1345 Phase 4; the undeclared transfer method was
// then answered three different ways across Phases 3, 4 and 5 on
// poverty-graduation/20260908-0510. This pins the componentized branch.
const root = join(__dirname, '../..');
const skill = readFileSync(join(root, 'skills/connect-opp-setup/SKILL.md'), 'utf8');

function archetypesSection(): string {
  const start = skill.indexOf('\n## Archetypes\n');
  const end = skill.indexOf('\n## ', start + 1);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return skill.slice(start, end);
}

describe('connect-opp-setup § Archetypes covers componentized programmes (ace#2163)', () => {
  const section = archetypesSection();
  const branchStart = section.indexOf('### Componentized programmes');
  const branch = branchStart >= 0 ? section.slice(branchStart) : '';

  it('has a componentized branch keyed on products.mode', () => {
    expect(branchStart).toBeGreaterThan(0);
    expect(branch).toMatch(/products\.mode: componentized/);
  });

  it('per-component PDD payment terms set the payment-unit count', () => {
    expect(branch).toMatch(/Per-component PDD payment terms set the payment-unit count/);
    expect(branch).toMatch(/required_deliver_units/);
  });

  it('the archetype rule governs only entity_id shape', () => {
    expect(branch).toMatch(/archetype rule governs `entity_id` SHAPE only/);
  });

  it('an undeclared transfer method becomes a deployment parameter + open question, not a silent pick', () => {
    expect(branch).toMatch(/deployment parameter, not a silent pick/);
    expect(branch).toMatch(/review_ask/);
    expect(branch).toMatch(/SAME working reading/);
  });

  it('the longitudinal-visits one-PU rule points at the componentized exception', () => {
    const longitudinal = section.slice(
      section.indexOf('### `longitudinal-visits`'),
      section.indexOf('### `focus-group`'),
    );
    expect(longitudinal).toMatch(/one\*\* payment unit for the whole arc/);
    expect(longitudinal).toMatch(/componentized/);
  });
});
