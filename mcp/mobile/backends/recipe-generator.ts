import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MaestroBackend } from './maestro.js';
import type { ShellFn } from './avd.js';

/**
 * LLM callback. The mobile MCP does NOT bring its own LLM — when ACE runs
 * inside Claude Code, the calling agent is itself an LLM session and
 * generates Maestro YAML inline using its own context. This callback exists
 * for non-Claude-Code programmatic callers (scripts, CI jobs) that want
 * to reuse the parseSummary / validateRecipe logic. Required when the
 * caller invokes generateForModule.
 */
export type LlmFn = (system: string, user: string) => Promise<string>;

export interface RecipeGeneratorOpts {
  llm: LlmFn;
  maestro?: MaestroBackend;
  shell?: ShellFn;
}

const SYSTEM_PROMPT = `You generate Maestro mobile-test YAML for the CommCare Android app
(appId: org.commcare.dalvik). Use only these step types:

- launchApp
- tapOn (with id, text, or a string)
- inputText
- takeScreenshot (always pair with a kebab-case step name)
- assertVisible
- assertNotVisible
- extendedWaitUntil
- waitForAnimationToEnd
- eraseText
- swipe
- pressKey
- back
- scroll
- hideKeyboard

For every form question in the module, emit:
  - tapOn (the question's input field, by id or text)
  - takeScreenshot (named like "form-N-M-qK-<short-slug>")
  - inputText (a plausible answer matching the question type)
  - tapOn next/finish button

End every module recipe with assertVisible of an end-state element.
Output the YAML and nothing else. No code fences, no commentary.`;

export class RecipeGenerator {
  private llm: LlmFn;
  private maestro: MaestroBackend;

  constructor(opts: RecipeGeneratorOpts) {
    this.llm = opts.llm;
    this.maestro = opts.maestro ?? new MaestroBackend({ shell: opts.shell });
  }

  /**
   * Extract module names from an app-summary markdown blob.
   *
   * Three formats supported, tried in order. The first that yields any
   * modules wins:
   *
   *   1. **Modules section with H3 entries:** a `## Modules` heading whose
   *      block contains `### N. <name>` rows. Used by Test-001-style
   *      atomic-visit summaries.
   *   2. **Modules section with a markdown table:** a `## Modules` heading
   *      whose block contains a `| # | Module | ... |` table. Module name
   *      is column 2. Used by Test-002-style focus-group summaries.
   *   3. **Legacy: top-level `## Module ...` headings.** Picks up any H2
   *      heading whose text starts with "Module". Used by hand-authored
   *      summaries before the `## Modules` parent convention landed.
   */
  parseSummary(summary: string): string[] {
    const modulesBlock = extractModulesBlock(summary);
    if (modulesBlock) {
      const h3 = parseH3Modules(modulesBlock);
      if (h3.length > 0) return h3;
      const table = parseTableModules(modulesBlock);
      if (table.length > 0) return table;
    }
    return parseLegacyH2Modules(summary);
  }

  async generateForModule(args: {
    summary: string;
    moduleName: string;
    appKind: 'learn' | 'deliver';
  }): Promise<string> {
    const userPrompt = `App kind: ${args.appKind}\n\nModule to walk through: ${args.moduleName}\n\nFull app summary:\n${args.summary}`;
    const yaml = await this.llm(SYSTEM_PROMPT, userPrompt);

    // Validate by writing to a temp file and running validateRecipe.
    const tmp = path.join(os.tmpdir(), `mob-gen-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
    fs.writeFileSync(tmp, yaml);
    try {
      await this.maestro.validateRecipe(tmp);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
    return yaml;
  }
}

function extractModulesBlock(summary: string): string | null {
  const lines = summary.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Modules\s*$/i.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function parseH3Modules(block: string): string[] {
  const out: string[] = [];
  for (const line of block.split('\n')) {
    const m = line.match(/^###\s+(.+?)\s*$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

function parseTableModules(block: string): string[] {
  const out: string[] = [];
  for (const line of block.split('\n')) {
    // Skip header (`| # | Module | ...`) and separator (`|---|---|...`).
    if (/^\|\s*#?\s*\|\s*Module/i.test(line)) continue;
    if (/^\|[\s\-:|]+\|$/.test(line)) continue;
    // Match `| <number> | <name> | ...` and capture column 2.
    const m = line.match(/^\|\s*\d+\s*\|\s*([^|]+?)\s*\|/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

function parseLegacyH2Modules(summary: string): string[] {
  const out: string[] = [];
  for (const line of summary.split('\n')) {
    const m = line.match(/^##\s+(Module\b.+?)\s*$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}
