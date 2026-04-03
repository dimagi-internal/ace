/**
 * LLM-as-Judge scorer for ACE evaluation.
 * Evaluates generated blueprints against IDD requirements.
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export interface ScoreResult {
  dimensions: {
    idd_fidelity: DimensionScore;
    connect_wiring: DimensionScore;
    data_integrity: DimensionScore;
    production_readiness: DimensionScore;
  };
  totalScore: number;
  maxScore: number;
  percentage: number;
  summary: string;
}

export interface DimensionScore {
  score: number;
  max: number;
  reasoning: string;
}

export async function scoreBlueprint(
  idd: string,
  blueprint: Record<string, unknown>,
  appType: 'learn' | 'deliver',
): Promise<ScoreResult> {
  const blueprintJson = JSON.stringify(blueprint, null, 2);

  const prompt = `You are a HARSH evaluator for CommCare Connect applications. Your job is to find problems, not praise. Score this generated ${appType} app blueprint against the IDD requirements.

## Scoring Philosophy
- A 5 is AVERAGE — it works but has meaningful gaps
- A 7 means GOOD — real gaps exist but nothing breaks
- A 9 means EXCELLENT — only nitpicks remain
- A 10 is virtually IMPOSSIBLE — reserve for genuinely flawless work
- Most scores should be 4-7. If you're scoring above 8, you're being too generous.
- Deduct heavily for anything that would cause a PRODUCTION FAILURE
- Deduct for anything a Connect admin would need to manually fix before the app works

## IDD (Requirements)

${idd}

## Generated Blueprint

\`\`\`json
${blueprintJson}
\`\`\`

## Scoring Dimensions

### 1. IDD Fidelity (0-10)
Does the app match the IDD EXACTLY? Not "roughly covers" — EXACTLY.
- Count every form specified in the IDD. Is each one present? (-2 per missing form)
- Count every field specified in the IDD. Is each one present with the right type? (-1 per missing field)
- Are there forms/fields NOT in the IDD? (-1 per extraneous addition, unless clearly necessary)
- Does the scope match the IDD's intent, or did the generator interpret it loosely?

### 2. Connect Wiring (0-10)
Can a Connect admin set up LearnModules, DeliverUnits, Tasks, and Assessments from this blueprint WITHOUT guessing?
- For Learn: does EVERY form have learn_module with a real description AND assessment with score_question pointing to an actual hidden question AND a passing_score?
- For Deliver: does EVERY form have deliver_unit? Do service/followup forms have task configs?
- Are IDs explicit or will the admin need to invent them?
- Can you map blueprint → Connect Django models (LearnModule, DeliverUnit, Task, Assessment, DeliverUnitFlagRules) without ambiguity?
- Is there enough metadata to configure payment units and verification rules?
- CRITICAL: if connect_type is wrong or missing, score 0.

### 3. Data Integrity (0-10)
Will the data collected be correct and complete?
- Are calculated fields actually calculated (not manual entry for derivable values)?
- Are XPath expressions syntactically valid?
- Do case properties capture all IDD-specified data points?
- Is case lifecycle correct (registration creates, followup updates, close conditions)?
- Are there data loss risks (e.g., case property not mapped, calculated field wrong)?
- For Learn: do score calculations produce the right range? Can a CHW actually achieve the passing score?
- For Deliver: do case list filters enforce workflow ordering, or can a CHW skip steps?

### 4. Production Readiness (0-10)
Would you deploy this to 25 CHWs in rural Zambia tomorrow?
- Are required fields marked required?
- Are constraints preventing bad data (negative numbers, out-of-range values)?
- Is skip/display logic preventing irrelevant questions?
- Are labels short enough for small Android screens (<30 words)?
- Are hints present where input is ambiguous?
- Is the form flow logical and self-explanatory?
- Are there any UX problems that would cause CHW confusion or errors?
- Would a CHW with basic literacy and 30 minutes of training succeed with this app?

## Output Format

Respond with ONLY a JSON object, no other text:

{
  "idd_fidelity": {"score": N, "reasoning": "List every specific gap found. Name the missing/extra items."},
  "connect_wiring": {"score": N, "reasoning": "For each form, state whether Connect config is complete. Name what's missing."},
  "data_integrity": {"score": N, "reasoning": "List every data issue found. XPath problems, missing calculations, wrong types."},
  "production_readiness": {"score": N, "reasoning": "List every UX/field issue. Be specific about what would fail in the field."},
  "summary": "2-3 sentences. Lead with the biggest problem."
}`;

  // Write prompt to temp file to avoid shell escaping issues
  const tmpFile = join(tmpdir(), `ace-eval-${Date.now()}.txt`);
  writeFileSync(tmpFile, prompt);

  let result: string;
  try {
    result = execSync(
      `cat ${JSON.stringify(tmpFile)} | claude -p - --output-format text 2>/dev/null`,
      { maxBuffer: 1024 * 1024, timeout: 180000 },
    ).toString().trim();
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }

  // Extract JSON from response
  const jsonMatch = result.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Failed to parse scorer response: ${result.slice(0, 200)}`);
  }

  const scores = JSON.parse(jsonMatch[0]);

  const dimensions = {
    idd_fidelity: { score: scores.idd_fidelity.score, max: 10, reasoning: scores.idd_fidelity.reasoning },
    connect_wiring: { score: scores.connect_wiring.score, max: 10, reasoning: scores.connect_wiring.reasoning },
    data_integrity: { score: scores.data_integrity.score, max: 10, reasoning: scores.data_integrity.reasoning },
    production_readiness: { score: scores.production_readiness.score, max: 10, reasoning: scores.production_readiness.reasoning },
  };

  const totalScore = Object.values(dimensions).reduce((sum, d) => sum + d.score, 0);
  const maxScore = Object.values(dimensions).reduce((sum, d) => sum + d.max, 0);

  return {
    dimensions,
    totalScore,
    maxScore,
    percentage: Math.round((totalScore / maxScore) * 100),
    summary: scores.summary,
  };
}

export function formatScorecard(appType: string, result: ScoreResult): string {
  const lines: string[] = [];
  lines.push(`## ${appType} App Scorecard`);
  lines.push('');
  lines.push(`| Dimension | Score | Reasoning |`);
  lines.push(`|-----------|-------|-----------|`);

  for (const [key, dim] of Object.entries(result.dimensions)) {
    const name = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    lines.push(`| ${name} | ${dim.score}/${dim.max} | ${dim.reasoning} |`);
  }

  lines.push('');
  lines.push(`**Total: ${result.totalScore}/${result.maxScore} (${result.percentage}%)**`);
  lines.push('');
  lines.push(`**Summary:** ${result.summary}`);

  return lines.join('\n');
}
