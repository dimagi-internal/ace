import { describe, it, expect } from "vitest";
import { parseNarrative, NARRATIVE_BEATS, NarrativeSchema } from "../../lib/partnership-narrative";

const valid = `
id: the-scale-gap
title: The Scale Gap
version: 1
thesis: A proven model reaching ten times the people.
emotional_beat: ambition
hero: the program's leadership
primary_capability: rapid program stand-up + pay-for-verified-delivery at scale
beats:
  hook: { intent: "Name the reach gap", words: 10 }
  cycle: { intent: "Show Learn/Deliver/Verify/Pay", words: 20 }
  handoff: { intent: "Hand to the prospect", words: 8 }
  scene: { intent: "Where the work happens", words: 20 }
  problem: { intent: "Frame the headline stat", words: 25 }
  product: { intent: "Walk the micro-demo", words: 30 }
  impact: { intent: "Read impact stats", words: 20 }
`;

describe("parseNarrative", () => {
  it("parses a valid narrative", () => {
    const n = parseNarrative(valid);
    expect(n.id).toBe("the-scale-gap");
    expect(n.version).toBe(1);
    expect(Object.keys(n.beats)).toEqual(expect.arrayContaining([...NARRATIVE_BEATS]));
  });

  it("rejects a narrative missing a required beat", () => {
    const bad = valid.replace(/  product:.*\n/, "");
    expect(() => parseNarrative(bad)).toThrow(/product/);
  });

  it("rejects an unknown beat id", () => {
    const bad = valid + `  bonus: { intent: x, words: 5 }\n`;
    expect(() => parseNarrative(bad)).toThrow();
  });

  it("NARRATIVE_BEATS matches the schema's beat keys (drift guard)", () => {
    expect(Object.keys(NarrativeSchema.shape.beats.shape).sort()).toEqual(
      [...NARRATIVE_BEATS].sort(),
    );
  });
});
