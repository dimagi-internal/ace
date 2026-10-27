// ace#3317: a cloud runner's first turn had no ace-web token and ace-setup never installed the Chromium its mint needs.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const setup = readFileSync("bin/ace-setup", "utf8");
const turn = readFileSync("skills/turn/SKILL.md", "utf8");

describe("a bare runner can get ACE's ace-web token without hand steps", () => {
  it("ace-setup installs Chromium before it runs the ace-web mint", () => {
    const install = setup.indexOf("npx playwright install chromium >/dev/null");
    const mint = setup.indexOf("ace-web-bot-token-mint.ts --ensure");
    expect(install).toBeGreaterThan(-1);
    expect(mint).toBeGreaterThan(install);
  });

  it("the turn skill runs ace-setup when .env or the token is missing", () => {
    expect(turn).toMatch(/Bootstrap a bare runner BEFORE preflight/);
    expect(turn).toMatch(/bin\/ace-setup/);
    expect(turn).toMatch(/never `source` the file/);
  });
});
