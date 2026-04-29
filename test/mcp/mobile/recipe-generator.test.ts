import { describe, it, expect, vi } from 'vitest';
import { RecipeGenerator, type LlmFn } from '../../../mcp/mobile/backends/recipe-generator.js';

const APP_SUMMARY = `
## Module 1 — Pre-test

### Form 1.1: Identification
- Q1: First name (text)
- Q2: Last name (text)
- Q3: Age (integer)
`;

const MOCK_YAML = `appId: org.commcare.dalvik
---
- launchApp: { clearState: false }
- assertVisible: { id: "home_screen_root" }
- tapOn: "Module 1 — Pre-test"
- takeScreenshot: "module-1-landing"
- tapOn: "Form 1.1: Identification"
- takeScreenshot: "form-1-1-q1-first-name"
- inputText: "Test"
- tapOn: { id: "form_next" }
- takeScreenshot: "form-1-1-q2-last-name"
- inputText: "Worker"
- tapOn: { id: "form_next" }
- takeScreenshot: "form-1-1-q3-age"
- inputText: "30"
- tapOn: { id: "form_finish" }
- assertVisible: "Module 1 complete"
`;

describe('RecipeGenerator.generateForModule', () => {
  it('calls the LLM with the summary + module name and returns validated YAML', async () => {
    const llm: LlmFn = vi.fn().mockResolvedValue(MOCK_YAML);
    const gen = new RecipeGenerator({ llm });
    const yaml = await gen.generateForModule({
      summary: APP_SUMMARY,
      moduleName: 'Module 1 — Pre-test',
      appKind: 'learn',
    });
    expect(yaml).toContain('appId: org.commcare.dalvik');
    expect(yaml).toContain('takeScreenshot');
    expect(llm).toHaveBeenCalledOnce();
  });

  it('rejects YAML with steps not in the allowed Maestro vocabulary', async () => {
    const badYaml = MOCK_YAML.replace('takeScreenshot', 'bogusStep');
    const llm: LlmFn = vi.fn().mockResolvedValue(badYaml);
    const gen = new RecipeGenerator({ llm });
    await expect(
      gen.generateForModule({ summary: APP_SUMMARY, moduleName: 'Module 1 — Pre-test', appKind: 'learn' }),
    ).rejects.toThrow(/RECIPE_INVALID|unknown/i);
  });
});

describe('RecipeGenerator.parseSummary', () => {
  it('extracts module names from app summary markdown', () => {
    const gen = new RecipeGenerator({ llm: vi.fn() });
    const modules = gen.parseSummary(APP_SUMMARY);
    expect(modules).toEqual(['Module 1 — Pre-test']);
  });

  it('handles multiple modules', () => {
    const summary = `## Module 1 — A\n\n## Module 2 — B\n\n## Module 3 — C\n`;
    const gen = new RecipeGenerator({ llm: vi.fn() });
    expect(gen.parseSummary(summary)).toEqual(['Module 1 — A', 'Module 2 — B', 'Module 3 — C']);
  });
});
