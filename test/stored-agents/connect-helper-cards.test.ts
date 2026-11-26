/**
 * connect-helper's card contract with connect-labs.
 *
 * Labs (`connect_labs/messaging/canopy_bridge/cards.py`) takes the first fenced
 * block whose info string is `card-html` out of the agent's reply and sends it
 * to PersonalID as a `format: card-html` message (its `index.html`), with the
 * prose around it as the caption. worker-chat § 6 tells the agent how to write
 * one. Both sides must use the same fence, and the skill must keep the rules
 * that make a card safe to send: one per reply, self-contained, the prose able
 * to stand alone for apps too old to show a card.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skill = readFileSync(
  join(__dirname, '..', '..', 'stored-agents', 'connect-helper', 'skills', 'worker-chat', 'SKILL.md'),
  'utf8',
);
const cards = skill.slice(skill.indexOf('## 6. A card'));

describe('connect-helper cards', () => {
  it('names the fence labs splits on', () => {
    expect(cards).toMatch(/```card-html\n/);
  });
  it('keeps the rules that make a card safe to send', () => {
    expect(cards).toMatch(/One card per reply/);
    expect(cards).toMatch(/No script/);
    expect(cards).toMatch(/prose still stands alone/);
    expect(cards).toMatch(/every figure from the brief or a tool this\s+turn/);
  });
  it('makes the card the one exception to the no-markdown rule', () => {
    expect(skill).toMatch(/The one\s+exception is a card \(step 6\)/);
  });
});
