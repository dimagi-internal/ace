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
    idd_coverage: DimensionScore;
    form_completeness: DimensionScore;
    connect_config: DimensionScore;
    data_model: DimensionScore;
    validation_logic: DimensionScore;
    field_usability: DimensionScore;
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

  const prompt = `You are an expert evaluator for CommCare Connect applications. Score this generated ${appType} app blueprint against the IDD requirements.

## IDD (Requirements)

${idd}

## Generated Blueprint

\`\`\`json
${blueprintJson}
\`\`\`

## Scoring Criteria

Rate each dimension 0-10 with specific reasoning. Be strict — a 7 means "good but has notable gaps", a 9 means "excellent with only minor issues", a 10 means "perfect".

### 1. IDD Coverage (0-10)
Does the app address all requirements from the IDD's ${appType === 'learn' ? 'Learn' : 'Deliver'} App Specification?
- Are all specified forms/modules present?
- Are all specified fields/questions included?
- Does the scope match (nothing major missing, nothing extraneous)?

### 2. Form Completeness (0-10)
Are forms well-structured?
- Do forms have all required questions with correct types?
- Are labels clear and professional?
- Are required fields marked appropriately?
- For Learn apps: does each quiz have enough questions to meaningfully assess knowledge?
- For Deliver apps: do forms capture all necessary service delivery data?

### 3. Connect Configuration (0-10)
Are Connect-specific configs correct for this app type?
- For Learn: does each form have learn_module (with description) and assessment (with score_question and passing_score)?
- For Deliver: do forms have deliver_unit and/or task configs as appropriate?
- Are the configs logically correct (e.g., assessments reference actual score questions)?
- Is connect_type set correctly at the app level?

### 4. Data Model (0-10)
For Learn apps: N/A (score 10 if no case management, which is correct)
For Deliver apps:
- Are case types and properties complete per IDD?
- Is case_name_property set correctly?
- Are case properties mapped to form questions?
- Is the case lifecycle correct (registration → followup → close)?

### 5. Validation & Logic (0-10)
- Are constraints present where they should be (numeric ranges, required fields)?
- Are calculated fields correct (score calculations for Learn, derived fields for Deliver)?
- Is skip/display logic present where needed?
- Are XPath expressions syntactically plausible?
- For Deliver: is conditional case closure logic correct?

### 6. Field Usability (0-10)
Would a CHW in the field find this app usable?
- Are question labels clear and jargon-free?
- Is the form flow logical?
- Are select options comprehensive and unambiguous?
- Are hints/help text provided where useful?
- Is the information architecture sensible (module organization, form ordering)?

## Output Format

Respond with ONLY a JSON object, no other text:

{
  "idd_coverage": {"score": N, "reasoning": "..."},
  "form_completeness": {"score": N, "reasoning": "..."},
  "connect_config": {"score": N, "reasoning": "..."},
  "data_model": {"score": N, "reasoning": "..."},
  "validation_logic": {"score": N, "reasoning": "..."},
  "field_usability": {"score": N, "reasoning": "..."},
  "summary": "2-3 sentence overall assessment"
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
    idd_coverage: { score: scores.idd_coverage.score, max: 10, reasoning: scores.idd_coverage.reasoning },
    form_completeness: { score: scores.form_completeness.score, max: 10, reasoning: scores.form_completeness.reasoning },
    connect_config: { score: scores.connect_config.score, max: 10, reasoning: scores.connect_config.reasoning },
    data_model: { score: scores.data_model.score, max: 10, reasoning: scores.data_model.reasoning },
    validation_logic: { score: scores.validation_logic.score, max: 10, reasoning: scores.validation_logic.reasoning },
    field_usability: { score: scores.field_usability.score, max: 10, reasoning: scores.field_usability.reasoning },
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
