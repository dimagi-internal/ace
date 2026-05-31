// test/eval/mobile-recipes/run-eval.ts
/**
 * Recipe-generation evals: run RecipeGenerator against existing fixtures and
 * assert the output is structurally valid.
 *
 * Run via: npx tsx test/eval/mobile-recipes/run-eval.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RecipeGenerator } from '../../../mcp/mobile/backends/recipe-generator.js';
import { MaestroBackend } from '../../../mcp/mobile/backends/maestro.js';

// Stub LLM that emits a structurally-valid template per module name.
async function stubLlm(_system: string, user: string): Promise<string> {
  const moduleMatch = user.match(/Module to walk through: (.+?)\n/);
  const moduleName = moduleMatch ? moduleMatch[1] : 'Module';
  return `appId: org.commcare.dalvik
---
- launchApp: { clearState: false }
- assertVisible: { id: "home_screen_root" }
- tapOn: "${moduleName}"
- takeScreenshot: "module-landing"
- assertVisible: "Module complete"
`;
}

async function evaluate(fixtureDir: string): Promise<{ pass: boolean; details: string[] }> {
  const summaryPath = path.join(fixtureDir, 'app-summaries', 'learn-app-summary.md');
  if (!fs.existsSync(summaryPath)) {
    return { pass: false, details: [`missing ${summaryPath}`] };
  }
  const summary = fs.readFileSync(summaryPath, 'utf8');
  const gen = new RecipeGenerator({ llm: stubLlm, maestro: new MaestroBackend() });
  const modules = gen.parseSummary(summary);
  const details: string[] = [];
  let pass = true;
  for (const m of modules) {
    try {
      const yaml = await gen.generateForModule({ summary, moduleName: m, appKind: 'learn' });
      if (!yaml.includes('takeScreenshot')) {
        pass = false;
        details.push(`module "${m}" emitted no screenshots`);
      }
      if (!yaml.includes('assertVisible')) {
        pass = false;
        details.push(`module "${m}" missing trailing assertVisible`);
      }
      details.push(`module "${m}" OK`);
    } catch (e) {
      pass = false;
      details.push(`module "${m}" failed: ${(e as Error).message}`);
    }
  }
  return { pass, details };
}

async function main() {
  const fixtures = ['ACE-Test-001', 'ACE-Test-002'];
  let allPass = true;
  for (const f of fixtures) {
    const dir = path.join('test', 'fixtures', f);
    const r = await evaluate(dir);
    console.log(`\n=== ${f} ===`);
    for (const d of r.details) console.log(`  ${d}`);
    console.log(`  → ${r.pass ? 'PASS' : 'FAIL'}`);
    allPass = allPass && r.pass;
  }
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
