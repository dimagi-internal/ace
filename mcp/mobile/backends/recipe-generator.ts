import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MaestroBackend } from './maestro.js';
import type { ShellFn } from './avd.js';

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

  parseSummary(summary: string): string[] {
    const out: string[] = [];
    for (const line of summary.split('\n')) {
      const m = line.match(/^##\s+(.+?)\s*$/);
      if (m) out.push(m[1].trim());
    }
    return out;
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
