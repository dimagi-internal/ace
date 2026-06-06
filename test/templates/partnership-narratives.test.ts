import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseNarrative } from "../../lib/partnership-narrative";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "templates", "partnership-narratives");

describe("partnership-narratives library", () => {
  const dirs = readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  it("has exactly three starter narratives", () => {
    expect(dirs.sort()).toEqual(["day-in-the-life", "the-scale-gap", "trust-travels"]);
  });

  for (const dir of dirs) {
    it(`${dir}/narrative.yaml parses and id matches dir`, () => {
      const n = parseNarrative(readFileSync(join(ROOT, dir, "narrative.yaml"), "utf8"));
      expect(n.id).toBe(dir);
    });
  }
});
