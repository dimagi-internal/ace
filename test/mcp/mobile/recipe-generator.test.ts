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
  it('extracts legacy `## Module N — name` headings', () => {
    const gen = new RecipeGenerator({ llm: vi.fn() });
    const modules = gen.parseSummary(APP_SUMMARY);
    expect(modules).toEqual(['Module 1 — Pre-test']);
  });

  it('handles multiple legacy modules', () => {
    const summary = `## Module 1 — A\n\n## Module 2 — B\n\n## Module 3 — C\n`;
    const gen = new RecipeGenerator({ llm: vi.fn() });
    expect(gen.parseSummary(summary)).toEqual(['Module 1 — A', 'Module 2 — B', 'Module 3 — C']);
  });

  it('extracts H3 modules under `## Modules` parent', () => {
    const summary = `## Overview\n\nFiller text\n\n## Modules\n\n### 1. Foo\nbody\n\n### 2. Bar\nbody\n\n## Other section\n\n### Should not match\n`;
    const gen = new RecipeGenerator({ llm: vi.fn() });
    expect(gen.parseSummary(summary)).toEqual(['1. Foo', '2. Bar']);
  });

  it('extracts table-row modules under `## Modules` parent', () => {
    const summary = `## Modules\n\n| # | Module | Purpose |\n|---|---|---|\n| 1 | Facilitation basics | Opening sessions |\n| 2 | Probing techniques | Tell me more |\n\n## Other section\n`;
    const gen = new RecipeGenerator({ llm: vi.fn() });
    expect(gen.parseSummary(summary)).toEqual(['Facilitation basics', 'Probing techniques']);
  });

  it('does not pick up non-module H2 headings when no `## Modules` block exists', () => {
    const summary = `## Overview\n\n## Connect Configuration\n\n## Notable differences\n`;
    const gen = new RecipeGenerator({ llm: vi.fn() });
    // None of these start with "Module" — legacy parser returns empty.
    expect(gen.parseSummary(summary)).toEqual([]);
  });
});
