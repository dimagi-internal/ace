import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

// canopy-web accepts decisions[] rows and retired the brief lists (dimagi-internal/canopy-web#1516).
describe("demo sets publish decision rows and read feedback rounds", () => {
  const demo = read("skills/demo-narrative/SKILL.md");
  const iterate = read("skills/narrative-iteration-review/SKILL.md");

  it("demo-narrative publishes the set with decisions[], through ace-canopy-web", () => {
    expect(demo).toMatch(/scripts\.ddd\.demo_set publish/);
    expect(demo).toMatch(/bin\/ace-canopy-web --workspace <ws> --/);
    expect(demo).toMatch(/decisions\[\]/);
  });

  it("demo-narrative verifies the board before citing its link", () => {
    expect(demo).toMatch(/bin\/ace-canopy-web --workspace <ws> verify storyboard <slug>/);
  });

  it("demo-narrative no longer tells the publisher to send brief.assumptions", () => {
    expect(demo).not.toMatch(/brief\.(assumptions|divergences|open_questions)/);
  });

  it("narrative-iteration-review reads feedback rounds as well as review responses", () => {
    expect(iterate).toMatch(/ddd-feedback-round/);
    expect(iterate).toMatch(/scripts\.ddd\.feedback_round/);
    expect(iterate).toMatch(/Feedback-Ref: storyboard:<slug>\/round-<n>\/<note id>/);
  });
});
